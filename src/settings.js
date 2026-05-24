// BF Memory Pipeline - Settings Module
// Handles UI, settings persistence, and debug logging

import { getConnectionProfiles, getCurrentProfileId } from './profiler.js';
import { DEFAULT_DRAFT_PROMPT } from './agent-draft.js';
import { DEFAULT_FINDER_PROMPT } from './agent-finder.js';
import { DEFAULT_MEMORY_PROMPT } from './agent-memory.js';
import { DEFAULT_WRITER_FORMAT } from './agent-writer.js';
import { DEFAULT_REFLECT_PROMPT } from './agent-reflect.js';
import {
    getEntities, setEntityStatus, reloadEntitiesFromChat,
    scanForNamedCandidates, showEntityPopup, promoteEntity,
} from './agent-entities.js';
import { explainFactRetrieval } from './fact-retrieval.js';

let Popup, POPUP_TYPE;
async function ensurePopup() {
    if (Popup) return true;
    const paths = ['../../../../popup.js', '../../../../../popup.js', '../../../../scripts/popup.js'];
    for (const p of paths) {
        try {
            const mod = await import(p);
            Popup = mod.Popup;
            POPUP_TYPE = mod.POPUP_TYPE;
            return true;
        } catch { /* try next */ }
    }
    return false;
}

const EXTENSION_NAME = (() => {
    try {
        const url = new URL(import.meta.url);
        const parts = url.pathname.split('/');
        const srcIdx = parts.lastIndexOf('src');
        if (srcIdx > 0) return parts[srcIdx - 1];
    } catch { /* fallback */ }
    return 'bf-memory-pipeline';
})();

let extensionSettings = null;
// debugLog is the RAM RING BUFFER: holds ALL kept entries (incl. debug/verbose when
// enabled), newest-first, capped at MAX_DEBUG_ENTRIES_MEM. The chat_metadata copy is a
// verbose-stripped, byte-budgeted SLICE (MAX_DEBUG_ENTRIES_PERSIST). See addDebugLog /
// saveDebugLogToMeta below. Kept named `debugLog` so existing readers are unaffected.
let debugLog = [];
// Persisted slice cap — unchanged contract for the chat_metadata.bf_mem_log copy.
const MAX_DEBUG_ENTRIES = 500; // FIX #10: raised from 200 so a long session isn't truncated (still bounded)
// Two-cap scheme (debug-log redesign): the RAM ring buffer holds far more (the firehose,
// incl. debug/verbose) while only a non-verbose slice of MAX_DEBUG_ENTRIES_PERSIST reaches
// chat_metadata so the chat .jsonl stays small.
const MAX_DEBUG_ENTRIES_MEM = 2000;       // RAM ring buffer (drop-oldest)
const MAX_DEBUG_ENTRIES_PERSIST = MAX_DEBUG_ENTRIES; // persisted, verbose-stripped slice
// Byte budget for the JSON-serialized persisted slice (protects the chat .jsonl round-trip).
const LOG_PERSIST_BYTE_BUDGET = 256 * 1024; // ~256 KB
// Monotonic per-entry sequence — stable ordering within an identical timestamp.
let logSeq = 0;
// Ambient run id (set by beginRun/endRun). addDebugLog calls with no explicit opts.runId
// inherit this so leaf logs (db/retrieval) auto-tag without signature churn.
let currentRunId = null;
// Valid level/subsystem vocabularies (anything else falls back to a safe default).
const LOG_LEVELS = new Set(['fail', 'pass', 'info', 'debug', 'verbose']);
const LOG_SUBSYSTEMS = new Set([
    'pipeline', 'agent1', 'agent3', 'finder', 'retrieval', 'db',
    'entity', 'reflection', 'settings', 'import', 'cache', 'writer',
]);
// DISPLAY-only aliases for subsystem machine keys (the keys themselves are stable,
// for back-compat with persisted log entries + the filter dropdown values).
const SUBSYSTEM_DISPLAY = {
    agent1: 'Drafter',
    agent2: 'Writer',
    writer: 'Writer',
    agent3: 'Scribe',
    agent4: 'Librarian',
    finder: 'Librarian',
};
function subsystemLabel(key) {
    return SUBSYSTEM_DISPLAY[key] || key;
}
let lastGenerated = { runId: null, timestamp: null, updates: [] };
let lastInserted = { runId: null, timestamp: null, updates: [] };
let lastRunTokens = null; // {baselineInput, actualInput, agent1Input, agent1Output, agent3Input, agent3Output, mainOutput, ts, approx}
let sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
// Scene card — the always-injected "what is true right now" core working-memory block.
// Persisted per-chat in chat_metadata.bf_mem_scene, reloaded on CHAT_CHANGED.
// null = no scene yet (back-compatible: absent scene behaves as no scene card).
let sceneCard = null; // { location, present[], goals[], beats[], updatedAt, runId }
// Reflection / consolidation summary — the rolling "story so far" + last synthesized
// observations. Persisted per-chat in chat_metadata.bf_mem_reflection, reloaded on
// CHAT_CHANGED. null = none yet (back-compatible: absent reflection = no injection).
let reflection = null; // { summary, observations[], updatedAt, runId }
// Summary pyramid — hierarchical zoom-out state. TOP level reuses the reflection #STORY
// summary (NOT duplicated — copied in at generation time); MIDDLE level holds one SHORT
// summary per populated (category, aspect) "shelf/bucket". Persisted per-chat in
// chat_metadata.bf_mem_pyramid, reloaded on CHAT_CHANGED. null = none yet (back-compatible:
// absent pyramid = no Big Picture injection). Derived/regenerable — never deletes facts.
let summaryPyramid = null; // { story, shelves: { 'cat||aspect': { text, factCount, updatedAt } }, updatedAt, runId }

const DEFAULT_SETTINGS = {
    enabled: false,
    useMemoryProfile: true,
    // Per-agent connection profiles (replacing single memoryProfile).
    // Old `memoryProfile` is kept on the stored object for rollback safety
    // and migrated forward in migrateLegacySettings().
    agent1Profile: '',
    agent3Profile: '',
    // Agent 4 (Fact Finder, STAGE 2 of two-stage retrieval) connection profile.
    // Empty => reuse Agent 1's profile (the design default). `agent4Profile` is the
    // canonical key; `finderProfile` is accepted as an alias (validated/migrated below).
    agent4Profile: '',
    finderProfile: '',
    // Per-agent context message counts (replacing single contextMessages).
    // Agent 3 default raised from 2 -> 5 (FIX #2a): a 2-message window truncated
    // long single-message backstory disclosures and the surrounding exchange that
    // gave them context, so rich reveals were missed. The full target message is
    // always sent untruncated regardless of this window (see buildMemoryPrompt /
    // pipeline.js — only the debug-log preview is substring'd, never the prompt).
    agent1ContextMessages: 5,
    agent3ContextMessages: 5,
    // Agent 2 (Writer) context limit: default 0 = off (main model sees full chat as ST
    // sends it). When > 0, we trim data.chat IN-PLACE to the last N user/AI messages
    // before sending — the main model sees only those + our injected facts. Lets you
    // shrink the prompt and rely on facts to replace older history. Reversible: just
    // change the slider back to 0.
    agent2ContextMessages: 0,
    // Writer recall tool (pull-detail / "infinite reach"). When ON, registers an optional
    // `search_memory` function-tool the MAIN model can call mid-generation to fetch a stored
    // fact that WASN'T pushed into its context. Default OFF so existing users and non-tool-
    // calling models are completely unaffected. Requires a tool-calling-capable main model;
    // only active on the main generation path (ST's tool loop never runs on the quiet/agent
    // paths). READ-ONLY: the tool never writes or deletes.
    enableWriterRecallTool: false,
    // Summary pyramid — optional "Big Picture" injection (hierarchical zoom-out). When ON, the
    // Writer gets a compact block = the rolling reflection story summary + the SHORT shelf
    // (category/aspect-bucket) summaries relevant to the current scene focus, hard token-capped.
    // Default OFF so behavior is byte-identical to today (respects the earlier decision to NOT
    // bloat every turn). Shelf summaries themselves are GENERATED regardless during the existing
    // reflection pass (cost-bounded: only changed buckets, capped per pass) and stored in
    // chat_metadata — this toggle only gates whether they're INJECTED. Absent (older settings)
    // → default false (back-compatible).
    enableSummaryPyramid: false,
    // Automatic associative linking (A-MEM style, lexical, DETERMINISTIC, zero-API). When ON, a
    // freshly-written fact is auto-connected to related EXISTING facts (same subject / shared
    // location / shared participants / lexical token overlap) by recording links into its
    // `relationships` — so asking about any one surfaces the others. Free + deterministic (no LLM),
    // so it DEFAULTS ON; the toggle lets a user disable it. Absent (older settings) => true.
    enableAutoLinking: true,
    // Hard cap on the injected Big Picture block, in approx tokens (reuses the buildSceneBlock
    // char-budget truncation style). Bounds prompt growth even with a huge store.
    summaryPyramidMaxTokens: 250,
    reviewInterval: 10,
    // DEPRECATED (Feature #2a): retrieval tier inclusion is now DETERMINISTIC (capped,
    // no random dice). These keys are kept for settings persistence/back-compat and the
    // existing sliders, but no longer gate which facts get injected. Safe to remove the
    // UI later; the values are inert.
    secondaryChance: 50,
    tertiaryChance: 15,
    // Feature #4 — depth-dice sequence retrieval. For a relevant track we always include
    // the current step, then roll each depth tier (steps back) at these probabilities;
    // the furthest successful roll sets how far back we reach (contiguously). Stored as
    // 0..1 floats. Absent on older settings → defaults below apply (back-compatible).
    depthDice1: 0.70,
    depthDice2: 0.50,
    depthDice3: 0.25,
    depthDice4: 0.10,
    showToast: true,
    debugMode: false,
    // Verbose logging tier (opt-in firehose). When false, level:'verbose' entries are
    // DROPPED at ingestion (never enter the ring buffer or storage). RAM-only even when on.
    debugVerbose: false,
    // Scene card (always-on core working-memory block). When enabled, Agent 1 emits an
    // optional #SCENE block each turn (location / present / goals / last beat); we inject
    // a compact one-line [Scene] block ABOVE the fact list every turn a scene exists.
    // Absent (older settings) → default true; back-compatible (no scene = no injection).
    sceneCardEnabled: true,
    // Hard cap on the injected scene block, in approx tokens. Truncated defensively.
    sceneCardMaxTokens: 150,
    // Reflection / consolidation pass (memory-research Phase 3). Periodically (every
    // reflectionInterval successful pipeline runs) makes ONE extra LLM call — reusing
    // Agent 3's connection profile — to compress accumulated detail into (a) a rolling
    // "story so far" summary and (b) higher-order observation facts. INFREQUENT + cost-
    // aware by design (the owner has been burned by expensive full-chat passes). Default
    // ON but with a conservative interval. Absent (older settings) → defaults apply.
    reflectionEnabled: true,
    reflectionInterval: 12,
    // DEPRECATED (refinement #1): the reflection "story so far" summary is NO LONGER
    // injected into the writer prompt under any circumstance. This key is retained inert
    // for back-compat (default now FALSE) so old saved settings don't error. Reflection
    // still runs as a silent dedupe-janitor / observation writer (refinement #4).
    reflectionInject: false,
    reflectionMaxTokens: 200,
    reflectionPrompt: '',
    // Character registry + NPC-promotion flow. Periodically (every characterCheckInterval
    // successful pipeline runs) scans the fact store for NEWLY-SEEN NAMED entities (proper
    // names in facts' involved/subject and the NPC drawer's `about`) that aren't yet
    // classified, and offers ONE batched popup to mark each Recurring / NPC / Later.
    // Deterministic scan (NO LLM call). Runs OFF the critical path on MESSAGE_RECEIVED, like
    // reflection. Absent (older settings) → defaults apply (back-compatible).
    characterRegistryEnabled: true,
    characterCheckInterval: 10,
    // Two-stage retrieval: STAGE 2 detail finder (Agent 4). When true (default), after
    // Agent 1 picks #Branches from the menu, Agent 4 reads the full facts under those
    // branches (+ all Unsorted) and chooses the relevant subset for injection. When false
    // (or on any finder error/empty), the pipeline falls back to deterministic retrieveFacts.
    useFinderAgent: true,
    // Optional system-prompt override for Agent 4. Empty => DEFAULT_FINDER_PROMPT.
    finderPrompt: '',
    draftPrompt: '',
    memoryPrompt: '',
    writerFormat: '',
    dbProfiles: {},
    activeDbProfile: '',
    // USER TAXONOMY OVERLAY (persisted, GLOBAL across chats). Extra Layer-1 categories and
    // Layer-2 leaves the user added from the Database tab, merged ON TOP of the built-in
    // TAXONOMY by database.js (flatVocab/effectiveCategories/groupedTaxonomyMenu). DATA-ONLY +
    // ADDITIVE — never removes/shadows a built-in. Default empty => behaves byte-identically to
    // the built-in-only taxonomy. Shape:
    //   categories: string[]                         — extra L1 names
    //   aspects:    { [category]: string[] }         — extra leaves per category (snake_case)
    //   subAreas:   { [category]: { [subArea]: string[] } } — OPTIONAL grouping for the menu
    // The AI-expansion flow (a later task) writes to this SAME overlay.
    taxonomyOverlay: { categories: [], aspects: {}, subAreas: {} },
    // schemaVersion intentionally NOT in defaults: the merge-missing-defaults loop
    // would otherwise pre-fill it for existing users and short-circuit the migration.
    // migrateLegacySettings() sets it after running.
};

function getContext() {
    return SillyTavern.getContext();
}

export function getSettings() {
    return extensionSettings;
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[EXTENSION_NAME] = extensionSettings;
    context.saveSettingsDebounced();
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function clamp(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

function validateSettings(s) {
    s.contextMessages = Math.floor(clamp(s.contextMessages, 1, 50, 5));
    s.agent1ContextMessages = Math.floor(clamp(s.agent1ContextMessages, 1, 50, 5));
    s.agent3ContextMessages = Math.floor(clamp(s.agent3ContextMessages, 1, 20, 5));
    s.agent2ContextMessages = Math.floor(clamp(s.agent2ContextMessages, 0, 50, 0));
    s.reviewInterval  = Math.floor(clamp(s.reviewInterval,  3, 100, 10));
    s.secondaryChance = Math.floor(clamp(s.secondaryChance, 0, 100, 50));
    s.tertiaryChance  = Math.floor(clamp(s.tertiaryChance,  0, 100, 15));
    // Feature #4 depth-dice probabilities are 0..1 floats (not clamped to ints).
    s.depthDice1 = clamp(s.depthDice1, 0, 1, 0.70);
    s.depthDice2 = clamp(s.depthDice2, 0, 1, 0.50);
    s.depthDice3 = clamp(s.depthDice3, 0, 1, 0.25);
    s.depthDice4 = clamp(s.depthDice4, 0, 1, 0.10);
    if (typeof s.enabled !== 'boolean') {
        // FIX #10: log when a coercion silently flips a previously-true enable off.
        if (s.enabled === true || (s.enabled && s.enabled !== false)) {
            addDebugLog('fail', `enabled coerced to false (was non-boolean: ${JSON.stringify(s.enabled)})`);
        }
        s.enabled = false;
    }
    s.sceneCardMaxTokens = Math.floor(clamp(s.sceneCardMaxTokens, 30, 400, 150));
    // Reflection: interval clamped to a sane range (min 4 so it can't fire every turn);
    // token cap for the injected summary clamped small (it's continuity glue, not a dump).
    s.reflectionInterval = Math.floor(clamp(s.reflectionInterval, 4, 100, 12));
    s.reflectionMaxTokens = Math.floor(clamp(s.reflectionMaxTokens, 50, 500, 200));
    if (typeof s.reflectionEnabled !== 'boolean') s.reflectionEnabled = true;
    if (typeof s.reflectionInject !== 'boolean')  s.reflectionInject = false; // inert (refinement #1)
    if (typeof s.reflectionPrompt !== 'string')   s.reflectionPrompt = '';
    // Character registry: enable toggle + check interval (clamped 2..50 so it can't fire every
    // turn nor be set absurdly high). Defaults: enabled true, interval 10.
    if (typeof s.characterRegistryEnabled !== 'boolean') s.characterRegistryEnabled = true;
    s.characterCheckInterval = Math.floor(clamp(s.characterCheckInterval, 2, 50, 10));
    if (typeof s.useMemoryProfile !== 'boolean') s.useMemoryProfile = true;
    if (typeof s.showToast !== 'boolean')        s.showToast = true;
    if (typeof s.debugMode !== 'boolean')        s.debugMode = false;
    if (typeof s.debugVerbose !== 'boolean')     s.debugVerbose = false;
    if (typeof s.sceneCardEnabled !== 'boolean') s.sceneCardEnabled = true;
    if (typeof s.memoryProfile !== 'string')     s.memoryProfile = '';
    if (typeof s.agent1Profile !== 'string')     s.agent1Profile = '';
    if (typeof s.agent3Profile !== 'string')     s.agent3Profile = '';
    if (typeof s.agent4Profile !== 'string')     s.agent4Profile = '';
    if (typeof s.finderProfile !== 'string')     s.finderProfile = '';
    // Accept `finderProfile` as an alias for `agent4Profile`: if only the alias is set,
    // fold it onto the canonical key so downstream code only reads agent4Profile.
    if (!s.agent4Profile && s.finderProfile) s.agent4Profile = s.finderProfile;
    if (typeof s.useFinderAgent !== 'boolean')   s.useFinderAgent = true;
    if (typeof s.enableWriterRecallTool !== 'boolean') s.enableWriterRecallTool = false;
    if (typeof s.enableSummaryPyramid !== 'boolean') s.enableSummaryPyramid = false;
    // Auto-linking defaults ON (free + deterministic): absent/invalid => true (back-compat).
    if (typeof s.enableAutoLinking !== 'boolean') s.enableAutoLinking = true;
    s.summaryPyramidMaxTokens = Math.floor(clamp(s.summaryPyramidMaxTokens, 50, 1000, 250));
    if (typeof s.finderPrompt !== 'string')      s.finderPrompt = '';
    if (typeof s.draftPrompt !== 'string')       s.draftPrompt = '';
    if (typeof s.memoryPrompt !== 'string')      s.memoryPrompt = '';
    if (typeof s.writerFormat !== 'string')      s.writerFormat = '';
    if (typeof s.activeDbProfile !== 'string')   s.activeDbProfile = '';
    if (!s.dbProfiles || typeof s.dbProfiles !== 'object' || Array.isArray(s.dbProfiles)) {
        s.dbProfiles = {};
    }
    // User taxonomy overlay: coerce to the well-formed { categories[], aspects{}, subAreas{} }
    // shape so database.js can read it without defensive branching. Absent/malformed => empty.
    if (!s.taxonomyOverlay || typeof s.taxonomyOverlay !== 'object' || Array.isArray(s.taxonomyOverlay)) {
        s.taxonomyOverlay = { categories: [], aspects: {}, subAreas: {} };
    } else {
        const ov = s.taxonomyOverlay;
        if (!Array.isArray(ov.categories)) ov.categories = [];
        if (!ov.aspects || typeof ov.aspects !== 'object' || Array.isArray(ov.aspects)) ov.aspects = {};
        if (!ov.subAreas || typeof ov.subAreas !== 'object' || Array.isArray(ov.subAreas)) ov.subAreas = {};
    }
    return s;
}

function migrateLegacySettings(s) {
    // Skip if already migrated
    if ((s.schemaVersion ?? 0) >= 2) return;

    const context = getContext();
    const legacy = context.extensionSettings?.bf_memory;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        // Copy renamed fields ONLY if current is empty (don't clobber user's newer values)
        if (legacy.recentMessageCount !== undefined && (s.contextMessages === undefined || s.contextMessages === 5)) {
            const n = Number(legacy.recentMessageCount);
            if (Number.isFinite(n)) s.contextMessages = n;
        }
        if (typeof legacy.customExtractorPrompt === 'string' && !s.memoryPrompt) {
            s.memoryPrompt = legacy.customExtractorPrompt;
        }
        if (typeof legacy.customWriterRule === 'string' && !s.writerFormat) {
            s.writerFormat = legacy.customWriterRule;
        }
        if (typeof legacy.extractorProfileId === 'string' && !s.memoryProfile) {
            s.memoryProfile = legacy.extractorProfileId;
        }
        if (typeof legacy.useExtractorProfile === 'boolean' && s.useMemoryProfile === undefined) {
            s.useMemoryProfile = legacy.useExtractorProfile;
        }
        console.log('[BFMemory] Migrated legacy bf_memory settings (old key preserved for rollback)');
    }

    // v0.7: split single memoryProfile/contextMessages into per-agent settings.
    // Old fields are intentionally KEPT on the stored object for rollback safety.
    if (typeof s.memoryProfile === 'string' && s.memoryProfile && !s.agent1Profile && !s.agent3Profile) {
        s.agent1Profile = s.memoryProfile;
        s.agent3Profile = s.memoryProfile;
    }
    if (typeof s.contextMessages === 'number' && s.contextMessages !== 5 && !s.agent1ContextMessages) {
        s.agent1ContextMessages = s.contextMessages;
    }

    s.schemaVersion = 2;
}

// --- Status ---

export function updateStatus(status, message = '') {
    const dot = document.getElementById('bf_mem_status_dot');
    const text = document.getElementById('bf_mem_status_text');

    if (dot) {
        dot.className = 'bf-mem-status-dot';
        if (status === 'running') dot.classList.add('running');
        else if (status === 'error') dot.classList.add('error');
        else if (extensionSettings?.enabled) dot.classList.add('active');
    }

    if (text && message) {
        text.textContent = message;
    } else if (text) {
        text.textContent = extensionSettings?.enabled ? 'Active' : 'Disabled';
    }
}

// --- Debug Log (persistent — stored in chat_metadata.bf_mem_log so it survives page reload) ---

const LOG_META_KEY = 'bf_mem_log';

// FIX #8: ctx.saveMetadata() is DEBOUNCED — rapid addDebugLog bursts each schedule
// a save the next call supersedes, so only entries that happen to coincide with
// ST's own chat-save reach disk. We add a throttled IMMEDIATE chat save (at most
// once per LOG_FLUSH_THROTTLE_MS) plus a guaranteed synchronous flush on
// beforeunload (the primary fix, since reload is exactly when data is lost).
const LOG_FLUSH_THROTTLE_MS = 5000;
let lastLogFlushAt = 0;

// --- Persistent debug-log FILE (full firehose, incl. verbose) ---
// The chat_metadata slice above stays small & verbose-STRIPPED for instant load; the FULL
// RAM ring buffer (incl. verbose) is ALSO mirrored to a dedicated per-chat attachment file
// (bf_mem_debuglog_<chatId>.json) via database.js, reusing the fact-DB attachment infra.
// That re-uploads the whole file each write (ST has no append), so we THROTTLE it on the
// same cadence as the metadata flush and only force it on beforeunload.
const LOG_FILE_FLUSH_THROTTLE_MS = 15000; // file write is heavier than metadata — throttle harder
let lastLogFileFlushAt = 0;               // last successful/attempted file write
let logFileDirty = false;                 // entries changed since the last file write
let logFileWriteInFlight = false;         // guard against overlapping async uploads
// The chatId the in-RAM `debugLog` buffer currently belongs to. Tracked so a CHAT_CHANGED can
// flush the OUTGOING chat's tail to the OUTGOING chat's file BEFORE the buffer is swapped — by
// the time CHAT_CHANGED fires, getContext().chatId is already the NEW chat, so flushing to the
// live chatId would mis-file the old tail. Set whenever reloadDebugLogFromChat resolves a chatId.
let _logBufferChatId = '';
// FILE CAP: how many newest entries (incl. verbose) the file retains. Bounds the re-upload
// size — at ~0.5 KB/entry this is roughly a 1.5–2 MB JSON ceiling. Oldest entries beyond
// this are dropped (the RAM ring buffer is the smaller MAX_DEBUG_ENTRIES_MEM cap).
const MAX_DEBUG_ENTRIES_FILE = 4000;

// --- runId threading (debug-log redesign §2) ---
// Ambient current run id. Any addDebugLog with no explicit opts.runId inherits this, so
// leaf logs (db/retrieval/eviction) auto-group without taking a runId parameter. An explicit
// opts.runId always wins. pendingRun generalizes the old reflectionPending pattern: it carries
// the inline run's id across the MESSAGE_RECEIVED boundary so a turn's pre-reply and post-reply
// events (extraction, reflection) share ONE id. Stored here (not in pipeline.js) so endRun/the
// summary can read it; pipeline owns arming/consuming it via the helpers below.
let pendingRun = null;

/** Set the ambient run id for the current turn. Explicit opts.runId on a log still overrides. */
export function beginRun(runId) {
    currentRunId = runId || null;
    return currentRunId;
}

/** Clear the ambient run id. Call at the end of a turn's logging window. */
export function endRun() {
    currentRunId = null;
}

/** Current ambient run id (null when no run active). */
export function getCurrentRunId() {
    return currentRunId;
}

/**
 * Arm post-reply work to share the inline run's id across the MESSAGE_RECEIVED boundary.
 * Generalizes reflectionPending — the post-reply extraction path calls consumePendingRun()
 * (or beginRun(getPendingRun().runId)) so Agent 3 extraction + reflection tag the SAME run
 * the user saw start, instead of minting a fresh `M…` id.
 * @param {{runId:string, startTime?:number}} info
 */
export function setPendingRun(info) {
    pendingRun = info && info.runId ? { ...info } : null;
}

/** Peek the armed pendingRun without clearing it. */
export function getPendingRun() {
    return pendingRun;
}

/** Read AND clear the armed pendingRun (one-shot consume across the reply boundary). */
export function consumePendingRun() {
    const p = pendingRun;
    pendingRun = null;
    return p;
}

/** Best-effort immediate (non-debounced) persist of the debug log to chat .jsonl. */
function flushDebugLogNow() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[LOG_META_KEY] = buildPersistSlice();
        ctx.saveMetadata?.();
        // Immediate, non-debounced chat write so the metadata reaches disk.
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
        lastLogFlushAt = Date.now();
    } catch { /* best-effort */ }
    // Also force the FULL (incl-verbose) file to flush. This is async/fire-and-forget;
    // on beforeunload the browser may not await it, but the throttled writes during the
    // session mean at most the last <throttle-window of verbose entries are at risk —
    // the metadata slice (above) and earlier file writes already reached disk.
    try { void flushDebugLogFile(true); } catch { /* best-effort */ }
}

/**
 * Build the FULL file payload: the whole RAM ring buffer (incl. verbose) capped at
 * MAX_DEBUG_ENTRIES_FILE newest entries. Kept newest-first to match the buffer; the loader
 * preserves order. This is what lands in the dedicated attachment file (NOT chat_metadata).
 */
function buildFileEntries() {
    return debugLog.slice(0, MAX_DEBUG_ENTRIES_FILE);
}

/**
 * Throttled, best-effort write of the FULL debug log to its dedicated attachment file.
 * Re-uploading the whole file is expensive, so this respects LOG_FILE_FLUSH_THROTTLE_MS
 * and never overlaps an in-flight upload. `force` (beforeunload / explicit flush) bypasses
 * the throttle. Async + fire-and-forget from addDebugLog; all errors are swallowed inside
 * database.js so the RAM buffer is never at risk.
 * @param {boolean} [force]
 * @param {string|null} [chatIdOverride] - target this chatId instead of the live one. Used on
 *   CHAT_CHANGED to file the OUTGOING chat's tail against the OUTGOING chatId (the live chatId
 *   has already advanced to the new chat by the time the event fires).
 */
async function flushDebugLogFile(force = false, chatIdOverride = null) {
    if (!logFileDirty && !force) return;
    if (logFileWriteInFlight) return; // a write is already running; dirty flag stays set
    if (!force && (Date.now() - lastLogFileFlushAt < LOG_FILE_FLUSH_THROTTLE_MS)) return;
    let chatId = chatIdOverride || '';
    if (!chatId) {
        try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
    }
    if (!chatId) return; // no chat open — keep entries in RAM until one is
    logFileWriteInFlight = true;
    lastLogFileFlushAt = Date.now();
    const snapshot = buildFileEntries(); // capture before the await so concurrent appends aren't lost-tracked
    logFileDirty = false;                // optimistic; re-set on failure below
    try {
        const { saveDebugLogFile } = await import('./database.js');
        const ok = await saveDebugLogFile(chatId, snapshot);
        if (!ok) logFileDirty = true; // upload failed/skipped — retry on the next tick
    } catch {
        logFileDirty = true;          // never throws into callers; just mark for retry
    } finally {
        logFileWriteInFlight = false;
    }
}

/**
 * Build the persisted slice: verbose-STRIPPED (the firehose stays RAM-only) and capped at
 * MAX_DEBUG_ENTRIES_PERSIST, then byte-budgeted so the chat .jsonl round-trip can't bloat.
 */
function buildPersistSlice() {
    // Drop verbose entries entirely — they never reach disk. Old entries (no `level`) are kept.
    let slice = debugLog.filter(e => e.level !== 'verbose').slice(0, MAX_DEBUG_ENTRIES_PERSIST);
    // Byte guard: if the serialized slice exceeds the budget, trim oldest (tail) until under.
    try {
        while (slice.length > 1 && JSON.stringify(slice).length > LOG_PERSIST_BYTE_BUDGET) {
            slice = slice.slice(0, slice.length - 1);
        }
    } catch { /* serialization guard is best-effort */ }
    return slice;
}

function loadDebugLogFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return [];
        const stored = md[LOG_META_KEY];
        // Shape-check: must be array of {type, message, timestamp}
        if (!Array.isArray(stored)) return [];
        return stored
            .filter(e => e && typeof e === 'object' && typeof e.message === 'string')
            .map(backfillEntry);
    } catch { return []; }
}

/**
 * Back-fill a persisted entry that may pre-date the structured schema (just {type,message,
 * timestamp}). Additive: derives level/subsystem/ts/seq if absent and parses a leading
 * [Rxxxx]/[Mxxxx] runId prefix from the message so OLD logs still group. Never overwrites
 * fields that are already present.
 */
function backfillEntry(e) {
    if (e.v == null) e.v = 1;
    if (typeof e.type !== 'string') e.type = 'info';
    if (typeof e.level !== 'string') e.level = e.type; // legacy type is a valid 3-value level
    if (typeof e.subsystem !== 'string') e.subsystem = 'settings';
    if (e.runId == null) {
        const m = /^\[([RM][0-9a-z]+)\]/.exec(e.message || '');
        e.runId = m ? m[1] : null;
    }
    if (typeof e.seq !== 'number') e.seq = ++logSeq;
    if (typeof e.ts !== 'number') {
        const parsed = e.iso ? Date.parse(e.iso) : NaN;
        e.ts = Number.isFinite(parsed) ? parsed : Date.now();
    }
    return e;
}

function saveDebugLogToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return; // no chat loaded — log lives in-memory only until a chat opens
        md[LOG_META_KEY] = buildPersistSlice();
        ctx.saveMetadata?.();
        // FIX #8: throttled immediate flush so a burst of entries doesn't all get
        // lost to the debounce on reload. Bounded to once per LOG_FLUSH_THROTTLE_MS
        // to avoid thrashing disk; the beforeunload handler guarantees the tail.
        if (Date.now() - lastLogFlushAt >= LOG_FLUSH_THROTTLE_MS) {
            if (typeof ctx.saveChat === 'function') ctx.saveChat();
            else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
            lastLogFlushAt = Date.now();
        }
    } catch { /* best-effort */ }
}

/**
 * Re-load the debug log on chat open / CHAT_CHANGED. Two-stage:
 *   1) SYNC: load the small verbose-stripped chat_metadata slice for an INSTANT render.
 *   2) ASYNC: fetch the dedicated per-chat attachment FILE (the full firehose, incl.
 *      verbose) and, if it has more entries than the metadata slice, swap it in. The file
 *      is the superset/preferred source; the slice is just the fast first paint. A new chat
 *      with no file keeps the (possibly empty) metadata slice — graceful missing-file path.
 * A token guards against an out-of-order resolve when the user switches chats mid-fetch.
 */
let debugLogLoadToken = 0;

/**
 * Flush the OUTGOING chat's debug-log tail to ITS OWN file before the buffer is swapped to a new
 * chat. Must run on CHAT_CHANGED *before* reloadDebugLogFromChat(): at that point `debugLog` still
 * holds the old chat's entries and `_logBufferChatId` still names the old chat, but the live
 * getContext().chatId has already advanced — so we force-flush the full buffer against the tracked
 * old chatId. Best-effort + never throws. Without this, the last <throttle-window of (esp. verbose)
 * entries for the chat you're leaving would be lost.
 */
async function flushOutgoingChatLog() {
    const outgoing = _logBufferChatId;
    if (!outgoing) return;
    try { await flushDebugLogFile(true, outgoing); } catch { /* best-effort */ }
}

export function reloadDebugLogFromChat() {
    debugLog = loadDebugLogFromMeta();
    renderDebugLog();
    // Reset file-flush bookkeeping so the freshly-loaded chat starts clean.
    logFileDirty = false;
    const myToken = ++debugLogLoadToken;
    let chatId = '';
    try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
    // Remember which chat the RAM buffer now belongs to, so a later CHAT_CHANGED can flush this
    // chat's tail to this chat's file (see flushOutgoingChatLog).
    _logBufferChatId = chatId;
    if (!chatId) return;
    (async () => {
        try {
            const { loadDebugLogFile } = await import('./database.js');
            const fileEntries = await loadDebugLogFile(chatId);
            // Bail if the user switched chats (or this chat reloaded) while we were fetching.
            if (myToken !== debugLogLoadToken) return;
            if (Array.isArray(fileEntries) && fileEntries.length) {
                // The file is the superset (it carries verbose + more history). Prefer it
                // whenever it has at least as many entries as the metadata slice.
                const merged = fileEntries.map(backfillEntry).slice(0, MAX_DEBUG_ENTRIES_MEM);
                if (merged.length >= debugLog.length) {
                    debugLog = merged;
                    renderDebugLog();
                }
            }
        } catch { /* best-effort — keep the metadata slice already loaded */ }
    })();
}

/** Map a legacy `type` to a 5-value level (for existing 2-arg call sites). */
function typeToLevel(type) {
    return LOG_LEVELS.has(type) ? type : 'info';
}

/** Derive the 3-value legacy `type` from a 5-value level (so old readers never break). */
function levelToType(level) {
    return (level === 'fail' || level === 'pass') ? level : 'info';
}

/**
 * Append a debug-log entry. BACKWARD-COMPATIBLE:
 *   addDebugLog('info', 'message')                       // legacy 2-arg — unchanged behavior
 *   addDebugLog('info', 'message', { runId, subsystem,   // new structured form
 *     event, level, data, reason, actor, before, after })
 *
 * The stored entry ALWAYS keeps the legacy keys {type, message, timestamp} verbatim, so old
 * readers (renderDebugLog, exportLogs, the shape-check on load) keep working. New optional
 * fields are additive. `level` (5-value) is the superset of `type` (3-value); whichever is
 * supplied derives the other. Verbose entries are gated by the debugVerbose setting and are
 * NEVER persisted (RAM-only).
 *
 * @param {string} type  legacy type OR (when opts.level absent) the level shorthand
 * @param {string} message human-readable string (unchanged contract)
 * @param {object} [opts] { runId, level, subsystem, event, data, reason, actor, before, after }
 */
export function addDebugLog(type, message, opts = {}) {
    if (!opts || typeof opts !== 'object') opts = {};

    // Level/type derivation: opts.level (5-value) wins; else derive from the legacy `type`.
    const level = LOG_LEVELS.has(opts.level) ? opts.level : typeToLevel(type);
    const legacyType = levelToType(level);

    // Verbose gating: drop at INGESTION when the firehose toggle is off, so verbose never
    // costs ring-buffer space, render time, or storage.
    if (level === 'verbose' && !extensionSettings?.debugVerbose) return;

    const subsystem = LOG_SUBSYSTEMS.has(opts.subsystem) ? opts.subsystem : 'settings';
    // runId: explicit opts.runId overrides the ambient currentRunId set by beginRun().
    const runId = (opts.runId != null && opts.runId !== '') ? opts.runId : currentRunId;

    const now = new Date();
    const entry = {
        // --- legacy keys (kept EXACTLY for back-compat readers / text export) ---
        type: legacyType,
        message,
        timestamp: now.toLocaleTimeString(),
        // --- structured fields (additive, all optional to downstream readers) ---
        v: 1,
        ts: now.getTime(),
        iso: now.toISOString(),
        seq: ++logSeq,
        level,
        subsystem,
        runId: runId ?? null,
    };
    // Only attach optional structured fields when provided (keeps small entries small).
    if (opts.event != null) entry.event = opts.event;
    if (opts.data != null) entry.data = opts.data;
    if (opts.reason != null) entry.reason = opts.reason;
    if (opts.actor != null) entry.actor = opts.actor;
    if (opts.before !== undefined) entry.before = opts.before;
    if (opts.after !== undefined) entry.after = opts.after;

    // RAM ring buffer: newest-first, drop-oldest beyond MAX_DEBUG_ENTRIES_MEM.
    debugLog.unshift(entry);
    if (debugLog.length > MAX_DEBUG_ENTRIES_MEM) debugLog.length = MAX_DEBUG_ENTRIES_MEM;

    // Persist a verbose-stripped, byte-budgeted slice to chat_metadata (survives reload,
    // instant load). The FULL buffer (incl. verbose) goes to the dedicated attachment file.
    saveDebugLogToMeta();
    logFileDirty = true;
    void flushDebugLogFile(false); // throttled; async fire-and-forget (errors swallowed)
    renderDebugLog();

    if (extensionSettings?.debugMode) {
        const tag = level.toUpperCase();
        const sub = subsystem !== 'settings' ? ` ${subsystem}` : '';
        const rid = runId ? ` [${runId}]` : '';
        console.log(`[BFMemory] [${tag}]${rid}${sub} ${message}`);
    }
}

// --- Debug-log filter state (client-side over the in-memory ring buffer) ---
// Level checkboxes default to fail+pass+info; debug/verbose opt-in. The verbose level is
// further gated by the debugVerbose SETTING (capture-side) — when off, verbose entries
// never enter the buffer regardless of this display filter.
const DEFAULT_LOG_LEVEL_FILTER = new Set(['fail', 'pass', 'info']);
let logLevelFilter = new Set(DEFAULT_LOG_LEVEL_FILTER);
let logSubsystemFilter = '';
let logSearchFilter = '';

/** Read the current filter UI into module state (no-op when the controls aren't mounted). */
function syncLogFilterFromUI() {
    const boxes = document.querySelectorAll('.bf-mem-log-level');
    if (boxes.length) {
        logLevelFilter = new Set();
        boxes.forEach(b => { if (b.checked) logLevelFilter.add(b.value); });
    }
    const sub = document.getElementById('bf_mem_log_subsystem');
    if (sub) logSubsystemFilter = sub.value || '';
    const search = document.getElementById('bf_mem_log_search');
    if (search) logSearchFilter = (search.value || '').trim().toLowerCase();
}

/** True if an entry passes the active level/subsystem/text filters. */
function entryMatchesFilter(entry) {
    const level = entry.level || entry.type || 'info';
    if (logLevelFilter.size && !logLevelFilter.has(level)) return false;
    if (logSubsystemFilter && (entry.subsystem || 'settings') !== logSubsystemFilter) return false;
    if (logSearchFilter) {
        const hay = (
            (entry.message || '') + ' ' +
            (entry.runId || '') + ' ' +
            (entry.event || '') + ' ' +
            (entry.subsystem || '') + ' ' +
            (entry.data != null ? safeStringify(entry.data) : '')
        ).toLowerCase();
        if (!hay.includes(logSearchFilter)) return false;
    }
    return true;
}

function safeStringify(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
}

/** Compact human header for a run, derived from its run.summary entry's `data` blob. */
function formatRunSummary(runId, summaryEntry) {
    const shortId = runId || '(run)';
    if (!summaryEntry || !summaryEntry.data) {
        return `Run ${shortId}`;
    }
    const d = summaryEntry.data;
    const parts = [`Run ${shortId}`];
    if (Number.isFinite(d.durationMs)) parts.push(`${d.durationMs}ms`);
    if (d.agents) {
        const mark = (s) => s === 'ok' ? '✓' : s === 'failed' ? '✗' : s === 'skipped' ? '–' : '?';
        const ag = [];
        if (d.agents.agent1) ag.push(`Drafter${mark(d.agents.agent1)}`);
        if (d.agents.agent3) ag.push(`Scribe${mark(d.agents.agent3)}`);
        if (ag.length) parts.push(ag.join(' '));
    }
    if (d.facts) {
        const f = d.facts;
        const fstr = `facts ${f.NEW ?? 0}N/${f.UPDATED ?? 0}U/${f.SKIPPED ?? 0}S` +
            (f.EVICTED ? `/${f.EVICTED}E` : '');
        parts.push(fstr);
    }
    if (d.tokens && Number.isFinite(d.tokens.netIn)) {
        const n = d.tokens.netIn;
        const tok = Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        parts.push(`${n >= 0 ? '+' : ''}${tok} tok`);
    }
    if (d.cancelled) parts.push('CANCELLED');
    return parts.join(' · ');
}

/** Render one entry as an HTML string (shared by flat + grouped paths). */
function renderEntryHtml(entry) {
    const level = entry.level || entry.type || 'info';
    const meta = [];
    if (entry.subsystem && entry.subsystem !== 'settings') meta.push(escapeHtml(subsystemLabel(entry.subsystem)));
    const metaHtml = meta.length ? `<span class="bf-mem-log-sub">${meta.join(' ')}</span> ` : '';
    return `
        <div class="bf-mem-debug-entry ${escapeHtml(level)}" data-event="${escapeHtml(entry.event || '')}" data-run="${escapeHtml(entry.runId || '')}">
            <span class="bf-mem-log-time">[${escapeHtml(entry.timestamp)}]</span> ${metaHtml}${escapeHtml(entry.message).replace(/\n/g, '<br>')}
        </div>`;
}

function renderDebugLog() {
    const container = document.getElementById('bf_mem_debug_log');
    if (!container) return;

    syncLogFilterFromUI();

    const total = debugLog.length;
    const visible = debugLog.filter(entryMatchesFilter);

    // Group visible entries by runId, newest run first. The ring buffer is already
    // newest-first, so the first time we see a runId fixes its display order. Entries with
    // no runId collect under a synthetic "Ungrouped / manual" block at the end.
    const order = [];
    const groups = new Map(); // runId -> entries[]
    const ungrouped = [];
    for (const e of visible) {
        const rid = e.runId;
        if (!rid) { ungrouped.push(e); continue; }
        if (!groups.has(rid)) { groups.set(rid, []); order.push(rid); }
        groups.get(rid).push(e);
    }

    // Map each runId to its summary entry (search the FULL buffer, not just the visible
    // slice, so a filtered-out summary still drives the header). Within a run, summary is
    // typically present once; fall back to a generic header when absent.
    const summaryByRun = new Map();
    for (const e of debugLog) {
        if (e.runId && e.event === 'run.summary' && !summaryByRun.has(e.runId)) {
            summaryByRun.set(e.runId, e);
        }
    }

    const blocks = [];
    for (const rid of order) {
        const entries = groups.get(rid);
        const summary = summaryByRun.get(rid);
        const headerLevel = (summary && (summary.level || summary.type)) || 'info';
        const header = escapeHtml(formatRunSummary(rid, summary));
        const body = entries.map(renderEntryHtml).join('');
        blocks.push(
            `<details class="bf-mem-run-group ${escapeHtml(headerLevel)}">` +
            `<summary>${header} <span class="bf-mem-run-count">(${entries.length})</span></summary>` +
            `<div class="bf-mem-run-body">${body}</div>` +
            `</details>`,
        );
    }
    if (ungrouped.length) {
        const body = ungrouped.map(renderEntryHtml).join('');
        blocks.push(
            `<details class="bf-mem-run-group ungrouped" open>` +
            `<summary>Ungrouped / manual <span class="bf-mem-run-count">(${ungrouped.length})</span></summary>` +
            `<div class="bf-mem-run-body">${body}</div>` +
            `</details>`,
        );
    }

    container.innerHTML = blocks.join('') ||
        '<div class="bf-mem-summary-empty">No log entries match the current filter.</div>';

    const countEl = document.getElementById('bf_mem_log_count');
    if (countEl) countEl.textContent = `showing ${visible.length} / ${total}`;
}

// --- Last Generated / Last Inserted Facts (replaces old Summary tab) ---

const GENERATED_META_KEY = 'bf_mem_generated';
const INSERTED_META_KEY = 'bf_mem_inserted';

function loadFactsFromMeta(key) {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        const stored = md[key];
        if (!stored || typeof stored !== 'object' || !Array.isArray(stored.updates)) return null;
        return stored;
    } catch { return null; }
}

function saveFactsToMeta(key, data) {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[key] = data;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

export function setLastGenerated(updates) {
    lastGenerated = {
        runId: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        updates: Array.isArray(updates) ? updates : [],
    };
    saveFactsToMeta(GENERATED_META_KEY, lastGenerated);
    renderGenerated();
}

export function setLastInserted(updates) {
    lastInserted = {
        runId: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        updates: Array.isArray(updates) ? updates : [],
    };
    saveFactsToMeta(INSERTED_META_KEY, lastInserted);
    renderInserted();
}

export function appendLastInserted(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return;
    lastInserted.updates = [...(lastInserted.updates || []), ...updates];
    lastInserted.timestamp = new Date().toLocaleTimeString();
    saveFactsToMeta(INSERTED_META_KEY, lastInserted);
    renderInserted();
}

export function reloadFactsFromChat() {
    lastGenerated = loadFactsFromMeta(GENERATED_META_KEY) || { runId: null, timestamp: null, updates: [] };
    lastInserted = loadFactsFromMeta(INSERTED_META_KEY) || { runId: null, timestamp: null, updates: [] };
    renderGenerated();
    renderInserted();
}

function renderFactList(containerId, data, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (data.runId === null) {
        container.innerHTML = `<div class="bf-mem-summary-empty">${escapeHtml(opts.emptyMsg || 'No pipeline runs yet.')}</div>`;
        return;
    }
    if (!data.updates || data.updates.length === 0) {
        container.innerHTML = `<div class="bf-mem-summary-empty">${escapeHtml(opts.zeroMsg || 'Last run extracted 0 facts.')}</div>`;
        return;
    }

    const header = `<div class="bf-mem-fact-header"><b>${escapeHtml(data.timestamp || '')}</b> · ${data.updates.length} fact${data.updates.length === 1 ? '' : 's'}</div>`;
    const items = data.updates.map(u => {
        const cat = escapeHtml(u.category || '?');
        const key = escapeHtml(u.key || '');
        const value = escapeHtml(String(u.value ?? ''));
        const knownBy = (u.knownBy || []).map(k => `<span class="bf-mem-chip">@${escapeHtml(k)}</span>`).join(' ');
        const tags = (u.tags || []).map(t => `<span class="bf-mem-chip bf-mem-chip-tag">#${escapeHtml(t)}</span>`).join(' ');
        const source = u.source ? `<span class="bf-mem-fact-source">from ${escapeHtml(u.source)}</span>` : '';
        const status = u.status
            ? `<span class="bf-mem-fact-status bf-mem-fact-status-${u.status.toLowerCase()}">${escapeHtml(u.status)}</span>`
            : '';
        return `
            <div class="bf-mem-fact-row">
                <div class="bf-mem-fact-line"><span class="bf-mem-fact-cat">${cat}</span> <code class="bf-mem-fact-key">${key}</code> = <span class="bf-mem-fact-val">${value}</span></div>
                <div class="bf-mem-fact-meta">${knownBy} ${tags} ${source} ${status}</div>
            </div>`;
    }).join('');
    container.innerHTML = header + items;
}

function renderGenerated() {
    renderFactList('bf_mem_generated_list', lastGenerated, {
        emptyMsg: 'No pipeline runs yet. Send a message to see what the Scribe extracts.',
        zeroMsg: 'Last run extracted 0 facts (the Scribe found nothing worth storing).',
    });
}

function renderInserted() {
    renderFactList('bf_mem_inserted_list', lastInserted, {
        emptyMsg: 'No pipeline runs yet.',
        zeroMsg: 'Nothing to insert (the Scribe returned no facts, or run was cancelled).',
    });
}

// --- Token Comparison (persistent — stored in chat_metadata.bf_mem_tokens) ---

const TOKENS_META_KEY = 'bf_mem_tokens';

function loadTokensFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return;
        const stored = md[TOKENS_META_KEY];
        if (stored && typeof stored === 'object') {
            lastRunTokens = (stored.lastRun && typeof stored.lastRun === 'object') ? stored.lastRun : null;
            sessionTokens = (stored.session && typeof stored.session === 'object')
                ? stored.session
                : { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
        }
    } catch { /* ignore */ }
}

function saveTokensToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[TOKENS_META_KEY] = { lastRun: lastRunTokens, session: sessionTokens };
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

// Called by pipeline.js after a run's input metrics are known.
export function setRunTokens(run) {
    // Coerce every field to a finite number so a tokenizer returning undefined/NaN
    // can't poison the running session totals (they'd become NaN and stop adding up).
    const baselineInput = Number(run?.baselineInput) || 0;
    const actualInput   = Number(run?.actualInput) || 0;
    const agentInput    = (Number(run?.agent1Input) || 0) + (Number(run?.agent3Input) || 0);
    const agentOutput   = (Number(run?.agent1Output) || 0) + (Number(run?.agent3Output) || 0);

    lastRunTokens = { ...run, ts: Date.now(), approx: true };
    // accumulate session
    sessionTokens.baselineInput += baselineInput;
    sessionTokens.actualInput   += actualInput;
    sessionTokens.agentInput    += agentInput;
    sessionTokens.agentOutput   += agentOutput;
    // Only count this as a run if it produced at least one usable token figure.
    // A no-op run (all zero — e.g. tokenizer unavailable) would otherwise inflate
    // the run count and skew per-run averages.
    if (baselineInput || actualInput || agentInput || agentOutput) {
        sessionTokens.runs += 1;
    }
    saveTokensToMeta();
    renderTokens();
}

// Called by pipeline.js MESSAGE_RECEIVED handler once Agent 3 (memory extraction)
// runs off the blocking path. Agent 3 no longer participates in the pre-generation
// setRunTokens call, so its input/output tokens are folded into the session totals
// here WITHOUT bumping the run count (the run was already counted on the blocking
// path) and WITHOUT touching baseline/actual input. Also stamps the figures onto
// lastRunTokens so the per-run breakdown still shows the Agent 3 line.
export function addAgent3Tokens({ agent3Input = 0, agent3Output = 0 } = {}) {
    const inN = Number(agent3Input) || 0;
    const outN = Number(agent3Output) || 0;
    if (!inN && !outN) return;
    sessionTokens.agentInput += inN;
    sessionTokens.agentOutput += outN;
    if (lastRunTokens) {
        lastRunTokens.agent3Input = (Number(lastRunTokens.agent3Input) || 0) + inN;
        lastRunTokens.agent3Output = (Number(lastRunTokens.agent3Output) || 0) + outN;
    }
    saveTokensToMeta();
    renderTokens();
}

// Called by pipeline.js MESSAGE_RECEIVED handler when the main reply lands.
export function setMainOutputTokens(n) {
    const out = Number(n) || 0;
    if (lastRunTokens) lastRunTokens.mainOutput = out;
    sessionTokens.mainOutput += out;
    saveTokensToMeta();
    renderTokens();
}

export function reloadTokensFromChat() {
    lastRunTokens = null;
    sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
    loadTokensFromMeta();
    renderTokens();
}

// --- Scene Card (persistent — stored in chat_metadata.bf_mem_scene) ---
// Always-on "what is true right now" core block. Updated by Agent 1 each turn,
// injected above the fact list every turn (when enabled and a scene exists).

const SCENE_META_KEY = 'bf_mem_scene';
const SCENE_BEATS_MAX = 3; // rolling window: keep the last N one-line beats

/** Coerce a stored value into the scene shape, or return null if unusable. */
function normalizeScene(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const arr = (v) => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : [];
    const loc = typeof raw.location === 'string' ? raw.location.trim() : '';
    const present = arr(raw.present);
    const goals = arr(raw.goals);
    const beats = arr(raw.beats).slice(-SCENE_BEATS_MAX);
    // A scene is meaningful only if it carries at least one field.
    if (!loc && present.length === 0 && goals.length === 0 && beats.length === 0) return null;
    return {
        location: loc,
        present,
        goals,
        beats,
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadSceneFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizeScene(md[SCENE_META_KEY]);
    } catch { return null; }
}

function saveSceneToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[SCENE_META_KEY] = sceneCard;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/** Current scene card (or null). Read by pipeline.js to build the injection. */
export function getScene() {
    return sceneCard;
}

/**
 * Update the scene card from an Agent 1 #SCENE parse. Merges defensively:
 *   - location / present / goals: replaced when the new value is non-empty,
 *     otherwise the prior value is kept (Agent 1 may omit a field on a given turn).
 *   - beats: rolling window — append the newest beat(s), drop the oldest, cap at 3.
 * @param {{location?:string, present?:string[], goals?:string[], newBeats?:string[]}} patch
 * @param {string} runId
 */
export function setScene(patch, runId = '') {
    if (!patch || typeof patch !== 'object') return;
    const prev = sceneCard || { location: '', present: [], goals: [], beats: [] };
    const cleanArr = (v) => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : [];

    const location = (typeof patch.location === 'string' && patch.location.trim())
        ? patch.location.trim() : prev.location;
    const present = (Array.isArray(patch.present) && patch.present.length)
        ? cleanArr(patch.present) : prev.present;
    const goals = (Array.isArray(patch.goals) && patch.goals.length)
        ? cleanArr(patch.goals) : prev.goals;

    // Rolling beats window: append new beats, keep last SCENE_BEATS_MAX, de-dupe
    // a newest beat that exactly repeats the prior tail (Agent 1 echoing itself).
    let beats = [...(prev.beats || [])];
    for (const b of cleanArr(patch.newBeats)) {
        if (beats.length && beats[beats.length - 1] === b) continue;
        beats.push(b);
    }
    beats = beats.slice(-SCENE_BEATS_MAX);

    const next = normalizeScene({ location, present, goals, beats, updatedAt: Date.now(), runId });
    if (!next) return; // nothing meaningful to store
    sceneCard = next;
    saveSceneToMeta();
    renderScene();
}

/** Re-load the scene card from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadSceneFromChat() {
    sceneCard = loadSceneFromMeta();
    renderScene();
}

/** Render the read-only live scene card in the Agent 1 tab (if present). */
function renderScene() {
    const el = document.getElementById('bf_mem_scene_view');
    if (!el) return;
    if (!sceneCard) {
        el.innerHTML = '<div class="bf-mem-summary-empty">No scene yet. It updates each turn once the pipeline runs.</div>';
        return;
    }
    const s = sceneCard;
    const row = (label, val) => val ? `<div class="bf-mem-fact-line"><span class="bf-mem-fact-cat">${escapeHtml(label)}</span> ${escapeHtml(val)}</div>` : '';
    el.innerHTML =
        row('Location', s.location) +
        row('Present', (s.present || []).join(', ')) +
        row('Goals', (s.goals || []).join('; ')) +
        row('Recently', (s.beats || []).join('; '));
}

// --- Reflection / Consolidation (persistent — stored in chat_metadata.bf_mem_reflection) ---
// Rolling "story so far" summary + last synthesized observations. Mirrors the scene-card
// persistence pattern: per-chat, shape-checked reload, best-effort save.

const REFLECTION_META_KEY = 'bf_mem_reflection';

/** Coerce a stored value into the reflection shape, or null if unusable. */
function normalizeReflection(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const observations = Array.isArray(raw.observations)
        ? raw.observations.map(x => String(x ?? '').trim()).filter(Boolean)
        : [];
    if (!summary && observations.length === 0) return null;
    return {
        summary,
        observations,
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadReflectionFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizeReflection(md[REFLECTION_META_KEY]);
    } catch { return null; }
}

function saveReflectionToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[REFLECTION_META_KEY] = reflection;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/** Current reflection summary object (or null). Read by pipeline.js for injection. */
export function getReflection() {
    return reflection;
}

/**
 * Store a fresh reflection (replaces the prior one — it's a rolling summary, not a log).
 * @param {{summary?:string, observations?:string[]}} patch
 * @param {string} runId
 */
export function setReflection(patch, runId = '') {
    const next = normalizeReflection({ ...(patch || {}), updatedAt: Date.now(), runId });
    if (!next) return; // nothing meaningful to store
    reflection = next;
    saveReflectionToMeta();
    renderReflection();
}

/** Re-load the reflection from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadReflectionFromChat() {
    reflection = loadReflectionFromMeta();
    renderReflection();
}

/** Render the read-only live reflection summary in the Agent 3 tab (if present). */
function renderReflection() {
    const el = document.getElementById('bf_mem_reflection_view');
    if (!el) return;
    if (!reflection) {
        el.innerHTML = '<div class="bf-mem-summary-empty">No reflection yet. It is generated periodically once the pipeline has run several turns.</div>';
        return;
    }
    const r = reflection;
    let html = '';
    if (r.summary) html += `<div class="bf-mem-fact-line">${escapeHtml(r.summary)}</div>`;
    if ((r.observations || []).length) {
        html += '<div class="bf-mem-fact-meta" style="margin-top:6px;">' +
            r.observations.map(o => `<span class="bf-mem-chip bf-mem-chip-tag">${escapeHtml(o)}</span>`).join(' ') +
            '</div>';
    }
    el.innerHTML = html || '<div class="bf-mem-summary-empty">No reflection yet.</div>';
}

// --- Summary Pyramid (persistent — stored in chat_metadata.bf_mem_pyramid) ---
// Hierarchical zoom-out: a SHORT summary per (category, aspect) "shelf/bucket" rolling up
// into the whole-story summary (reused from reflection's #STORY). Mirrors the reflection
// persistence pattern: per-chat, shape-checked reload, best-effort save. Read by the writer
// injection builder (agent-writer.js) and written by the reflection pass (agent-reflect.js).

const PYRAMID_META_KEY = 'bf_mem_pyramid';

/** Coerce a stored value into the pyramid shape, or null if unusable. */
function normalizePyramid(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const story = typeof raw.story === 'string' ? raw.story.trim() : '';
    const shelves = {};
    if (raw.shelves && typeof raw.shelves === 'object' && !Array.isArray(raw.shelves)) {
        for (const [bucketKey, entry] of Object.entries(raw.shelves)) {
            if (!bucketKey || !entry || typeof entry !== 'object') continue;
            const text = typeof entry.text === 'string' ? entry.text.trim() : '';
            if (!text) continue; // an empty shelf summary carries no value — drop it
            shelves[String(bucketKey)] = {
                text,
                factCount: Number(entry.factCount) || 0,
                updatedAt: Number(entry.updatedAt) || Date.now(),
            };
        }
    }
    if (!story && Object.keys(shelves).length === 0) return null;
    return {
        story,
        shelves,
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadPyramidFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizePyramid(md[PYRAMID_META_KEY]);
    } catch { return null; }
}

function savePyramidToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[PYRAMID_META_KEY] = summaryPyramid;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/**
 * Current summary pyramid object (or null). Read by agent-writer.js (Big Picture injection)
 * and agent-reflect.js (changed-bucket detection — compares stored shelf factCount/updatedAt
 * against the live index).
 * @returns {{story:string, shelves:Object<string,{text:string,factCount:number,updatedAt:number}>, updatedAt:number, runId:string}|null}
 */
export function getSummaryPyramid() {
    return summaryPyramid;
}

/**
 * Store a fresh summary pyramid (replaces the prior one — it's rolling derived state, not a
 * log). Mirrors setReflection. Best-effort persist to chat_metadata.
 * @param {{story?:string, shelves?:Object}} pyramid
 * @param {string} runId
 */
export function setSummaryPyramid(pyramid, runId = '') {
    const next = normalizePyramid({ ...(pyramid || {}), updatedAt: Date.now(), runId });
    if (!next) return; // nothing meaningful to store
    summaryPyramid = next;
    savePyramidToMeta();
}

/** Re-load the pyramid from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadPyramidFromChat() {
    summaryPyramid = loadPyramidFromMeta();
}

// --- Character Registry (live list in the Agent 3 tab) ---
// Read-only-ish list of known entities + their status, with a way to re-decide each
// (toggle status / re-scan). Storage + detection live in agent-entities.js; this is
// just the settings-panel surface. Persistence is per-chat (bf_mem_entities), reloaded
// on CHAT_CHANGED via reloadEntitiesFromChat() (wired in initSettings).

const ENTITY_STATUS_LABEL = { named: 'Recurring', npc: 'NPC', later: 'Later', pending: 'Pending' };

/** Render the Characters list (if the panel is present). */
function renderEntities() {
    const el = document.getElementById('bf_mem_charreg_list');
    if (!el) return;
    let reg = {};
    try { reg = getEntities() || {}; } catch { reg = {}; }
    const items = Object.values(reg)
        .filter(e => e && e.name)
        .sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.name).localeCompare(String(b.name)));

    if (items.length === 0) {
        el.innerHTML = '<div class="bf-mem-summary-empty">No characters tracked yet. They are discovered automatically as facts accumulate.</div>';
        return;
    }

    el.innerHTML = items.map(e => {
        const nm = escapeHtml(e.name);
        const status = ENTITY_STATUS_LABEL[e.status] || e.status || 'Pending';
        const sclass = `bf-mem-fact-status bf-mem-fact-status-${escapeHtml(String(e.status || 'pending').toLowerCase())}`;
        const count = Number(e.count) || 0;
        return `
            <div class="bf-mem-charreg-item bf-mem-fact-row" data-name="${nm}">
                <div class="bf-mem-fact-line">
                    <span class="bf-mem-fact-key">${nm}</span>
                    <span class="${sclass}" style="margin-left:6px;">${escapeHtml(status)}</span>
                    <span class="bf-mem-fact-source" style="margin-left:6px;">${count}×</span>
                </div>
                <div class="bf-mem-fact-meta">
                    <button class="bf-mem-charreg-set menu_button" data-name="${nm}" data-status="named" title="Mark recurring (promotes facts out of the NPC drawer)">Recurring</button>
                    <button class="bf-mem-charreg-set menu_button" data-name="${nm}" data-status="npc" title="Mark as one-off NPC">NPC</button>
                    <button class="bf-mem-charreg-set menu_button" data-name="${nm}" data-status="later" title="Defer">Later</button>
                </div>
            </div>`;
    }).join('');

    // Bind re-decide buttons (delegated rebind each render — list is small).
    el.querySelectorAll('.bf-mem-charreg-set').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const status = btn.dataset.status;
            if (!name || !status) return;
            try {
                setEntityStatus(name, status);
                if (status === 'named') {
                    const res = await promoteEntity(name);
                    if (typeof toastr !== 'undefined') {
                        toastr.success(`"${name}" promoted (${res.moved} fact(s) moved)`, 'BF Memory');
                    }
                }
            } catch (err) {
                addDebugLog('fail', `Character re-decide for "${name}" failed: ${err.message || err}`);
            }
            renderEntities();
        });
    });
}

/** Re-load registry from chat + re-render. Called on CHAT_CHANGED. */
export function reloadEntitiesUI() {
    try { reloadEntitiesFromChat(); } catch { /* ignore */ }
    renderEntities();
}

function fmt(n) { return (typeof n === 'number' && Number.isFinite(n)) ? n.toLocaleString() : '—'; }

function renderTokens() {
    const lastEl = document.getElementById('bf_mem_tokens_lastrun');
    const sessEl = document.getElementById('bf_mem_tokens_session');
    const banner = document.getElementById('bf_mem_tokens_banner');
    if (!lastEl) return;

    if (!lastRunTokens) {
        lastEl.innerHTML = '<div class="bf-mem-summary-empty">No generations yet. Send a message — token comparison appears after the first pipeline run.</div>';
        if (sessEl) sessEl.innerHTML = '<div class="bf-mem-summary-empty">No generations yet this session.</div>';
        if (banner) banner.style.display = 'none';
        return;
    }

    const L = lastRunTokens;
    const extIn = (L.actualInput || 0) + (L.agent1Input || 0) + (L.agent3Input || 0);
    const extOut = (L.mainOutput || 0) + (L.agent1Output || 0) + (L.agent3Output || 0);
    const netIn = extIn - (L.baselineInput || 0);   // negative = saved
    const netOut = extOut - (L.mainOutput || 0);     // agent output overhead (always >= 0)

    // Trim-off detection: actual main input ~= baseline (within 3%)
    const trimOff = (L.baselineInput > 0) && (L.actualInput >= L.baselineInput * 0.97);
    if (banner) {
        banner.style.display = trimOff ? 'block' : 'none';
        banner.textContent = trimOff
            ? 'Writer trim is OFF — the main model sees the full chat, so there are no input savings. The agent calls below are pure overhead (the tradeoff for memory recall). Turn on "Context Limit" in the Writer tab to save input tokens.'
            : '';
    }

    const netInClass = netIn < 0 ? 'bf-mem-tok-save' : 'bf-mem-tok-bad';
    const netInStr = (netIn < 0 ? '' : '+') + fmt(netIn);

    lastEl.innerHTML = `
        <table class="bf-mem-db-table">
            <thead><tr><th></th><th>Input</th><th>Output</th></tr></thead>
            <tbody>
                <tr><td>Baseline (full chat)</td><td>${fmt(L.baselineInput)}</td><td>${fmt(L.mainOutput)}</td></tr>
                <tr><td>— Main model</td><td>${fmt(L.actualInput)}</td><td>${fmt(L.mainOutput)}</td></tr>
                <tr><td>— Drafter</td><td>${fmt(L.agent1Input)}</td><td>${fmt(L.agent1Output)}</td></tr>
                <tr><td>— Scribe</td><td>${fmt(L.agent3Input)}</td><td>${fmt(L.agent3Output)}</td></tr>
                <tr><td><b>Extension total</b></td><td><b>${fmt(extIn)}</b></td><td><b>${fmt(extOut)}</b></td></tr>
                <tr><td><b>NET vs baseline</b></td><td class="${netInClass}">${netInStr}</td><td class="bf-mem-tok-cost">+${fmt(netOut)}</td></tr>
            </tbody>
        </table>
        <small class="bf-mem-hint">Approx. token counts (local tokenizer). Negative input = saved; output overhead is the agent calls.</small>`;

    if (sessEl) {
        const s = sessionTokens;
        const sExtIn = (s.actualInput || 0) + (s.agentInput || 0);
        const sExtOut = (s.mainOutput || 0) + (s.agentOutput || 0);
        const sNetIn = sExtIn - (s.baselineInput || 0);
        const sNetClass = sNetIn < 0 ? 'bf-mem-tok-save' : 'bf-mem-tok-bad';
        sessEl.innerHTML = `
            <table class="bf-mem-db-table">
                <thead><tr><th>${s.runs} run(s)</th><th>Input</th><th>Output</th></tr></thead>
                <tbody>
                    <tr><td>Baseline total</td><td>${fmt(s.baselineInput)}</td><td>${fmt(s.mainOutput)}</td></tr>
                    <tr><td>Extension total</td><td>${fmt(sExtIn)}</td><td>${fmt(sExtOut)}</td></tr>
                    <tr><td><b>NET</b></td><td class="${sNetClass}">${(sNetIn < 0 ? '' : '+') + fmt(sNetIn)}</td><td class="bf-mem-tok-cost">+${fmt(sExtOut - (s.mainOutput || 0))}</td></tr>
                </tbody>
            </table>`;
    }
}

function exportLogs() {
    const header = `=== BF Memory Pipeline Debug Logs ===\nExported: ${new Date().toISOString()}\nEntries: ${debugLog.length}\n${'='.repeat(40)}\n\n`;
    const logText = debugLog.map(entry => `[${entry.timestamp}] [${entry.type.toUpperCase().padEnd(5)}] ${entry.message}`).join('\n');
    const out = header + logText;
    addDebugLog('info', `Logs exported (${debugLog.length} entries)`, {
        subsystem: 'settings', event: 'log.exported', actor: 'USER', data: { entryCount: debugLog.length },
    });
    return out;
}

/**
 * Machine-readable export of the FULL RAM ring buffer (incl. debug/verbose when present) as
 * pretty JSON — the artifact for "investigate what changed why". Full `data` blobs included.
 * Returns the JSON string; callers handle download/clipboard.
 */
export function exportLogsJSON() {
    let chatId = null;
    try { chatId = getContext().chatId ?? null; } catch { /* no chat */ }
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        schemaVersion: 1,
        chatId,
        entries: debugLog,
    }, null, 2);
}

// --- Profile Dropdown ---

function reloadProfiles() {
    const agent1Select = document.getElementById('bf_mem_agent1_profile');
    const agent3Select = document.getElementById('bf_mem_agent3_profile');
    const agent4Select = document.getElementById('bf_mem_agent4_profile');
    if (!agent1Select && !agent3Select && !agent4Select) return;

    const profiles = getConnectionProfiles();
    const activeProfile = getCurrentProfileId();

    const populate = (select, savedValue) => {
        if (!select) return;
        const currentValue = select.value;
        select.innerHTML = '<option value="">-- Use default profile --</option>';
        profiles.forEach(profile => {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.name + (profile.id === activeProfile ? ' (current)' : '');
            select.appendChild(option);
        });
        if (currentValue && profiles.find(p => p.id === currentValue)) {
            select.value = currentValue;
        } else if (savedValue) {
            select.value = savedValue;
        }
    };

    populate(agent1Select, extensionSettings?.agent1Profile);
    populate(agent3Select, extensionSettings?.agent3Profile);
    populate(agent4Select, extensionSettings?.agent4Profile);
}

// --- Tabs ---

function setupTabs() {
    const tablist = document.querySelector('.bf-mem-tabs[role="tablist"]');
    if (!tablist) return;

    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));

    function activateTab(tab) {
        tabs.forEach(t => {
            t.setAttribute('aria-selected', 'false');
            t.setAttribute('tabindex', '-1');
            t.classList.remove('active');
            const panel = document.getElementById(t.getAttribute('aria-controls'));
            if (panel) panel.style.display = 'none';
        });

        tab.setAttribute('aria-selected', 'true');
        tab.setAttribute('tabindex', '0');
        tab.classList.add('active');

        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        if (panel) panel.style.display = '';

        // Refresh DB view when switching to database tab
        if (tab.getAttribute('aria-controls') === 'bf_mem_tab_database') {
            refreshDatabaseView();
        }
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => activateTab(tab));
        tab.addEventListener('keydown', (e) => {
            const idx = tabs.indexOf(tab);
            let target = null;
            if (e.key === 'ArrowRight') target = tabs[(idx + 1) % tabs.length];
            else if (e.key === 'ArrowLeft') target = tabs[(idx - 1 + tabs.length) % tabs.length];
            if (target) { e.preventDefault(); activateTab(target); }
        });
    });
}

// --- Database View ---

/**
 * Populate the "Add aspect" category dropdown with the built-in L1 order followed by any
 * user-added (custom) categories, preserving the current selection when possible. Custom
 * categories are suffixed " (custom)" so they're distinguishable.
 * @param {string[]} builtinOrder - MENU_CATEGORY_ORDER (built-in L1)
 * @param {Set<string>} customCats - user-added overlay category names
 * @returns {void}
 */
function populateAddLabelCategoryDropdown(builtinOrder, customCats) {
    const select = document.getElementById('bf_mem_addleaf_category');
    if (!select) return;
    const prev = select.value;
    const names = [...builtinOrder, ...[...customCats].filter(c => !builtinOrder.includes(c))];
    select.innerHTML = names.map(c =>
        `<option value="${escapeHtml(c)}">${escapeHtml(c)}${customCats.has(c) ? ' (custom)' : ''}</option>`
    ).join('');
    if (prev && names.includes(prev)) select.value = prev;
}

/**
 * Add a user Layer-2 leaf to the persisted taxonomy overlay (with dedup). Normalizes the surface
 * form, checks it against the EXISTING effective vocab + synonyms for the category; if already
 * covered, it logs a dedup redirect and does NOT add a duplicate. Otherwise it appends the leaf
 * (and its optional sub-area) to settings.taxonomyOverlay, persists, invalidates the taxonomy
 * memo, and refreshes the Database view.
 * @param {string} category - target Layer-1 category (built-in or custom)
 * @param {string} rawLeaf - raw user leaf input
 * @param {string} [rawSubArea] - optional sub-area grouping for the menu
 * @returns {Promise<void>}
 */
async function addUserLeaf(category, rawLeaf, rawSubArea) {
    const {
        canonicalizeLeafSurface, findExistingLeaf, invalidateTaxonomyOverlayCache, mapLegacyCategory,
    } = await import('./database.js');
    const cat = mapLegacyCategory(category); // canonical spelling (built-in or overlay)
    const leaf = canonicalizeLeafSurface(rawLeaf);
    if (!leaf) {
        toastr.warning('Enter a valid aspect name.', 'BF Memory');
        return;
    }
    // Dedup: already a leaf or a known synonym of an existing leaf for this category.
    const existing = findExistingLeaf(leaf, cat);
    if (existing) {
        addDebugLog('info', `Label not added — "${leaf}" already covered by "${existing}" (${cat})`, {
            subsystem: 'settings', event: 'label.merged', reason: 'SYNONYM_DEDUP', actor: 'USER',
            data: { tier: 'aspect', category: cat, label: leaf, existing },
        });
        toastr.info(`"${leaf}" is already covered by "${existing}".`, 'BF Memory');
        return;
    }

    // Persist into the overlay (well-formed shape guaranteed by validateSettings).
    const ov = extensionSettings.taxonomyOverlay = extensionSettings.taxonomyOverlay || { categories: [], aspects: {}, subAreas: {} };
    if (!Array.isArray(ov.aspects[cat])) ov.aspects[cat] = [];
    ov.aspects[cat].push(leaf);
    const subArea = String(rawSubArea || '').trim();
    if (subArea) {
        if (!ov.subAreas[cat] || typeof ov.subAreas[cat] !== 'object') ov.subAreas[cat] = {};
        if (!Array.isArray(ov.subAreas[cat][subArea])) ov.subAreas[cat][subArea] = [];
        ov.subAreas[cat][subArea].push(leaf);
    }
    saveSettings();
    invalidateTaxonomyOverlayCache();
    addDebugLog('pass', `Custom aspect added: "${leaf}" → ${cat}${subArea ? ` (${subArea})` : ''}`, {
        subsystem: 'settings', event: 'label.added', actor: 'USER',
        data: { tier: 'aspect', category: cat, label: leaf, subArea: subArea || undefined },
    });
    toastr.success(`Added aspect "${leaf}" to ${cat}.`, 'BF Memory');
    const nameEl = document.getElementById('bf_mem_addleaf_name');
    const subEl = document.getElementById('bf_mem_addleaf_subarea');
    if (nameEl) nameEl.value = '';
    if (subEl) subEl.value = '';
    refreshDatabaseView();
}

/**
 * Add a user Layer-1 category to the persisted taxonomy overlay (with dedup against built-ins +
 * existing overlay categories). Persists, invalidates the taxonomy memo, and refreshes the view.
 * @param {string} rawName - raw user category name
 * @returns {Promise<void>}
 */
async function addUserCategory(rawName) {
    const { MENU_CATEGORY_ORDER, effectiveCategories, invalidateTaxonomyOverlayCache } = await import('./database.js');
    // Keep the user's casing but trim; reject empty.
    const name = String(rawName || '').trim().replace(/\s+/g, ' ');
    if (!name) {
        toastr.warning('Enter a category name.', 'BF Memory');
        return;
    }
    const lc = name.toLowerCase();
    const existing = effectiveCategories().find(c => c.toLowerCase() === lc);
    if (existing) {
        const isBuiltin = MENU_CATEGORY_ORDER.some(c => c.toLowerCase() === lc);
        addDebugLog('info', `Category not added — "${name}" already exists as "${existing}"`, {
            subsystem: 'settings', event: 'label.merged', reason: 'SYNONYM_DEDUP', actor: 'USER',
            data: { tier: 'category', category: name, label: name, existing },
        });
        toastr.info(`Category "${existing}" already exists${isBuiltin ? ' (built-in)' : ''}.`, 'BF Memory');
        return;
    }
    if (!confirm(`Add a new top-level category "${name}"?`)) return;

    const ov = extensionSettings.taxonomyOverlay = extensionSettings.taxonomyOverlay || { categories: [], aspects: {}, subAreas: {} };
    if (!Array.isArray(ov.categories)) ov.categories = [];
    ov.categories.push(name);
    saveSettings();
    invalidateTaxonomyOverlayCache();
    addDebugLog('pass', `Custom category added: "${name}"`, {
        subsystem: 'settings', event: 'label.added', actor: 'USER',
        data: { tier: 'category', category: name, label: name },
    });
    toastr.success(`Added category "${name}".`, 'BF Memory');
    const nameEl = document.getElementById('bf_mem_addcat_name');
    if (nameEl) nameEl.value = '';
    refreshDatabaseView();
}

/**
 * AI "Suggest new labels" handler (Database tab button). MANUAL, on-demand: mines the fact DB
 * for homeless facts, makes ONE LLM call (taxonomy-suggest.js, Scribe/Agent-3 profile), then
 * shows the parsed proposals in a MANDATORY human-approval popup. Approved leaves are written
 * through the SAME overlay path the manual "Add your own label" controls use (addUserLeaf /
 * addUserCategory) so dedup/canonicalization/cache-invalidation/refresh are identical — re-running
 * dedup here is correct (a proposal that collides with an existing/just-added leaf is absorbed as
 * a synonym, not duplicated). NOTHING is added without explicit approval. Never throws into the UI.
 * @returns {Promise<void>}
 */
async function onSuggestLabelsClick() {
    const btn = document.getElementById('bf_mem_suggest_labels_btn');
    if (btn && btn.dataset.busy === '1') return; // guard against double-click while the call is in flight
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
    try {
        const { getAgent3ProfileId } = await import('./profiler.js');
        const { runLabelSuggestion } = await import('./taxonomy-suggest.js');
        const profileId = getAgent3ProfileId(extensionSettings);

        toastr.info('Scanning facts and asking the model for label ideas…', 'BF Memory');
        const result = await runLabelSuggestion({ profileId });

        if (result.noCandidates) {
            toastr.info('No homeless facts to analyze — everything already has a specific home.', 'BF Memory');
            return;
        }
        if (result.error) {
            toastr.error(`Suggest labels failed: ${result.error}`, 'BF Memory');
            return;
        }
        if (result.proposals.length === 0 && result.synonyms.length === 0) {
            toastr.info(`Analyzed ${result.candidateCount} fact(s); the model proposed no new labels.`, 'BF Memory');
            return;
        }
        await showLabelSuggestionsPopup(result);
    } catch (err) {
        addDebugLog('fail', `Suggest labels handler failed (non-fatal): ${err.message || err}`);
        toastr.error('Suggest labels failed. See the Debug tab for details.', 'BF Memory');
    } finally {
        if (btn) { btn.dataset.busy = '0'; btn.disabled = false; }
    }
}

/**
 * MANDATORY human-approval popup for AI-suggested labels. Reuses ST's Popup API (same
 * Popup + POPUP_TYPE.TEXT + custom OK/Cancel pattern showEntityPopup uses). Each NEW-leaf
 * proposal gets an Approve/Reject radio (default Reject — dismiss-safe); map-to-existing
 * synonym suggestions are shown read-only (informational; v1 doesn't auto-refile). On Save,
 * each Approved proposal is written via addUserCategory (new category) + addUserLeaf (leaf) —
 * the same dedup+persist+invalidate+refresh the manual controls use. NOTHING is added unless
 * the user explicitly Approves it and clicks Save.
 *
 * NOTE (v1): approved labels are ADDED to the taxonomy only — existing homeless facts are NOT
 * auto-refiled onto the new leaf. The late-bound aspect resolver + future Scribe turns pick the
 * new label up. (TODO: optional opt-in refile via a safe upsertFact of just the clustered facts.)
 *
 * @param {{proposals: Array, synonyms: Array, candidateCount: number}} result
 * @returns {Promise<void>}
 */
async function showLabelSuggestionsPopup(result) {
    const proposals = result.proposals || [];
    const synonyms = result.synonyms || [];

    const ok = await ensurePopup();
    if (!ok || !Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    const proposalRows = proposals.map((p, idx) => {
        const grp = `bf_mem_suggest_choice_${idx}`;
        const examples = (p.examples || []).length
            ? `<div class="bf-mem-suggest-examples" style="font-size:0.85em;opacity:0.8;margin-top:2px;">e.g. ${p.examples.map(e => escapeHtml(e)).join('; ')}</div>`
            : '';
        const catBadge = p.newCategory ? ` <span class="bf-mem-action-badge" title="A brand-new top-level category">NEW CAT</span>` : '';
        return `
            <div class="bf-mem-suggest-row" data-idx="${idx}" style="display:flex;flex-direction:column;gap:4px;padding:8px 0;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
                <div><b>${escapeHtml(p.category)}</b> ▸ ${escapeHtml(p.subArea || 'Custom')} ▸ <b>${escapeHtml(p.label)}</b>${catBadge}</div>
                ${p.definition ? `<div style="font-size:0.9em;">${escapeHtml(p.definition)}</div>` : ''}
                ${examples}
                <div class="bf-mem-suggest-choices" style="display:flex;gap:14px;flex-wrap:wrap;">
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="approve" /> <span>Approve</span></label>
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="reject" checked /> <span>Reject</span></label>
                </div>
            </div>`;
    }).join('');

    const synonymRows = synonyms.length
        ? `<div class="bf-mem-suggest-synonyms" style="margin-top:10px;">
                <h4 style="margin:0 0 4px 0;">Already covered (the model suggests these clusters fit an existing leaf — informational, not added)</h4>
                ${synonyms.map(s => `<div style="font-size:0.9em;padding:2px 0;">${escapeHtml(s.category)}/<b>${escapeHtml(s.leaf)}</b>${s.reason ? ` — ${escapeHtml(s.reason)}` : ''}</div>`).join('')}
            </div>`
        : '';

    const html = `
        <div class="bf-mem-suggest-popup" data-count="${proposals.length}">
            <h3>AI label suggestions (${proposals.length})</h3>
            <p>Reviewed ${result.candidateCount} homeless fact(s). Approve the labels you want added to your taxonomy. Approved labels are de-duplicated against the existing vocab before they're added. Nothing is added unless you Approve it and click Save.</p>
            ${proposals.length ? `<div class="bf-mem-suggest-list" style="max-height:50vh;overflow-y:auto;">${proposalRows}</div>` : '<p><i>No new-label proposals.</i></p>'}
            ${synonymRows}
        </div>`;

    let decisions = [];
    try {
        const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
            okButton: 'Save approved',
            cancelButton: 'Cancel (add nothing)',
            wide: true,
            allowVerticalScrolling: true,
        });
        const popupResult = await popup.show();
        const root = popup.dlg || popup.content || document;
        const cancelled = !popupResult;
        if (!cancelled) {
            root.querySelectorAll?.('.bf-mem-suggest-row').forEach((row) => {
                const idx = parseInt(row.getAttribute('data-idx'), 10);
                const p = proposals[idx];
                if (!p) return;
                const sel = row.querySelector('input[type="radio"]:checked');
                if (sel && sel.value === 'approve') decisions.push(p);
            });
        }
    } catch (err) {
        addDebugLog('fail', `Suggest labels popup failed (non-fatal): ${err.message || err}`);
        return;
    }

    if (decisions.length === 0) {
        addDebugLog('info', `Suggest labels: user approved 0 of ${proposals.length} proposal(s)`, {
            subsystem: 'settings', event: 'taxonomy.suggest', reason: 'NONE_APPROVED', actor: 'USER',
            data: { proposed: proposals.length },
        });
        toastr.info('No labels added.', 'BF Memory');
        return;
    }

    // Apply approved proposals through the SAME overlay path the manual add controls use. A new
    // category is added first (so its leaf can attach to it), then the leaf — both re-run their
    // own dedup (a collision is absorbed as a synonym, never duplicated). They each persist,
    // invalidate the taxonomy memo, and refresh the Database view, and emit label.added /
    // label.merged logs, so no extra wiring is needed here.
    for (const p of decisions) {
        try {
            if (p.newCategory) {
                await addUserCategory(p.category);
            }
            await addUserLeaf(p.category, p.label, p.subArea);
        } catch (err) {
            addDebugLog('fail', `Suggest labels: failed to add "${p.category}/${p.label}" (non-fatal): ${err.message || err}`);
        }
    }
    addDebugLog('pass', `Suggest labels: user approved ${decisions.length} of ${proposals.length} proposal(s)`, {
        subsystem: 'settings', event: 'taxonomy.suggest', reason: 'APPROVED', actor: 'USER',
        data: { approved: decisions.length, proposed: proposals.length, labels: decisions.map(d => `${d.category}/${d.label}`) },
    });
}

async function refreshDatabaseView() {
    const {
        getAllDatabases, withSkeleton, MENU_CATEGORY_ORDER, aspectVocabFor, deriveAspect,
        isActiveFact, isColdFact, effectiveCategories, flatVocab,
    } = await import('./database.js');
    const real = await getAllDatabases();
    // 3-layer model: overlay the empty Layer-1 skeleton so the FULL taxonomy (every category,
    // count 0 when empty) is always shown — never "No databases yet". The skeleton is purely
    // in-memory here (no empty files are written; categories persist only when a fact lands).
    // The skeleton already includes user-added overlay categories (effectiveCategories).
    const databases = withSkeleton(real);
    // Stable Layer-1 order first, then any custom extras.
    const ordered = [];
    for (const c of MENU_CATEGORY_ORDER) if (databases[c]) ordered.push(c);
    for (const c of Object.keys(databases)) if (!ordered.includes(c)) ordered.push(c);
    const categories = ordered;

    // Custom (user-added) markers so the UI can distinguish overlay labels from built-ins.
    const customCats = new Set(effectiveCategories().filter(c => !MENU_CATEGORY_ORDER.includes(c)));
    const overlay = extensionSettings?.taxonomyOverlay || { aspects: {} };

    // Keep the "Add aspect" category dropdown in sync with the effective category set.
    populateAddLabelCategoryDropdown(MENU_CATEGORY_ORDER, customCats);

    const statsEl = document.getElementById('bf_mem_db_stats');
    const listEl = document.getElementById('bf_mem_db_list');

    if (!statsEl || !listEl) return;

    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    statsEl.innerHTML = `<b>${categories.length}</b> databases | <b>${totalFacts}</b> total facts`;

    listEl.innerHTML = categories.map(cat => {
        const db = databases[cat];
        const factCount = db.facts.length;
        // Never-delete / cold-tier: the old 50-cap is gone, so show the real count plus how many
        // are cold-tiered (deprioritized but kept), not a fake "/50".
        const coldCount = db.facts.filter(f => { try { return isColdFact(f); } catch { return false; } }).length;
        const countLabel = coldCount ? `${factCount} (${coldCount} cold)` : `${factCount}`;
        const isCustomCat = customCats.has(cat);
        // Overlay (user-added) leaves for this category, so we can chip them in the breakdown.
        const overlayLeaves = new Set((Array.isArray(overlay.aspects?.[cat]) ? overlay.aspects[cat] : [])
            .map(l => String(l || '').trim().toLowerCase()));
        const knowers = [...new Set(db.facts.flatMap(f => f.knownBy || []))];
        // Layer-2 aspect breakdown: show the full effective vocab for this category (built-in +
        // overlay) with active counts (0 when empty) so the skeleton is visible from turn 1.
        const aspectCounts = new Map();
        for (const f of db.facts) {
            if (!isActiveFact(f)) continue;
            const a = deriveAspect(f);
            aspectCounts.set(a, (aspectCounts.get(a) || 0) + 1);
        }
        const aspectStr = flatVocab(cat).map(a => {
            const label = `${a}:${aspectCounts.get(a) || 0}`;
            return overlayLeaves.has(a) ? `${label}*` : label;
        }).join(', ');
        return `
            <div class="bf-mem-db-card" data-category="${escapeHtml(cat)}">
                <div class="bf-mem-db-card-header">
                    <span class="bf-mem-db-card-name">${escapeHtml(cat)}${isCustomCat ? ' <span class="bf-mem-custom-chip" title="User-added category">custom</span>' : ''}</span>
                    <span class="bf-mem-db-card-count">${escapeHtml(countLabel)}</span>
                </div>
                <div class="bf-mem-db-card-meta">
                    <div class="bf-mem-db-card-aspects">${escapeHtml(aspectStr)}</div>
                    ${overlayLeaves.size ? '<small class="bf-mem-hint">* = your custom aspect</small>' : ''}
                    ${knowers.length ? `Known by: ${escapeHtml(knowers.join(', '))}` : ''}
                </div>
                <div class="bf-mem-db-card-actions">
                    <button class="bf-mem-db-view menu_button" data-category="${escapeHtml(cat)}">
                        <i class="fa-solid fa-eye"></i> View
                    </button>
                    <button class="bf-mem-db-delete menu_button" data-category="${escapeHtml(cat)}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>`;
    }).join('');

    // Bind view buttons
    listEl.querySelectorAll('.bf-mem-db-view').forEach(btn => {
        btn.addEventListener('click', () => viewSingleDatabase(btn.dataset.category, databases));
    });

    // Bind delete buttons
    listEl.querySelectorAll('.bf-mem-db-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const category = btn.dataset.category;
            if (!confirm(`Delete database "${category}"?`)) return;
            const { deleteDatabase, flushSnapshotNow } = await import('./database.js');
            // Layer A (IDB) + Layer B (attachment file) — also cancels the armed snapshot timer.
            await deleteDatabase(category);
            // Layer C (dbProfiles snapshot): prune the category so autoSaveDbProfile can't resurrect
            // it on the next CHAT_CHANGED. Without this, deleting from IDB+attachments leaves the
            // full copy in the linked profile and it reloads on chat switch.
            const { profilesPruned, factsPruned } = pruneActiveProfile(category);
            // Force a reconciling snapshot now so the durable attachment layer reflects the deletion
            // immediately (deletes the emptied category's file) rather than on the throttled cadence.
            await flushSnapshotNow();
            addDebugLog('pass', `Deleted category "${category}" (Layer A+B+C)`, {
                subsystem: 'db', event: 'db.deleteCategory', actor: 'USER', reason: 'USER_DELETE',
                data: { category, profilesPruned, factsPrunedFromProfile: factsPruned },
            });
            toastr.success(`Database "${category}" deleted`, 'BF Memory');
            refreshDatabaseView();
        });
    });
}

async function viewSingleDatabase(category, databases) {
    const db = databases[category];
    if (!db) return;

    let html = `<div class="bf-mem-db-browser">
        <h4>${escapeHtml(category)} (${db.facts.length} facts)</h4>
        <table class="bf-mem-db-table">
            <tr><th>Key</th><th>Value</th><th>Known By</th><th>Tags</th><th>Relationships</th></tr>`;

    for (const fact of db.facts) {
        const rels = fact.relationships || {};
        const relStr = [
            ...(rels.primary || []).map(r => `P:${r}`),
            ...(rels.secondary || []).map(r => `S:${r}`),
            ...(rels.tertiary || []).map(r => `T:${r}`),
        ].join(', ');

        html += `<tr>
            <td><b>${escapeHtml(fact.key)}</b></td>
            <td>${escapeHtml(fact.value)}</td>
            <td>${escapeHtml((fact.knownBy || []).join(', '))}</td>
            <td>${escapeHtml((fact.tags || []).join(', '))}</td>
            <td>${escapeHtml(relStr)}</td>
        </tr>`;
    }
    html += '</table></div>';

    await ensurePopup();
    if (Popup) {
        const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
        await popup.show();
    }
}

async function showAllDatabases() {
    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();
    const categories = Object.keys(databases);

    if (categories.length === 0) {
        toastr.info('No databases yet.', 'BF Memory');
        return;
    }

    let html = '<div class="bf-mem-db-browser">';
    for (const [category, db] of Object.entries(databases)) {
        html += `<div class="bf-mem-db-section">
            <h4>${escapeHtml(category)} (${db.facts.length} facts)</h4>
            <table class="bf-mem-db-table">
                <tr><th>Key</th><th>Value</th><th>Known By</th><th>Tags</th></tr>`;
        for (const fact of db.facts) {
            html += `<tr>
                <td><b>${escapeHtml(fact.key)}</b></td>
                <td>${escapeHtml(fact.value)}</td>
                <td>${escapeHtml((fact.knownBy || []).join(', '))}</td>
                <td>${escapeHtml((fact.tags || []).join(', '))}</td>
            </tr>`;
        }
        html += '</table></div>';
    }
    html += '</div>';

    await ensurePopup();
    if (Popup) {
        const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
        await popup.show();
    }
}

// --- DB Profiles ---

function refreshDbProfileDropdown() {
    const select = document.getElementById('bf_mem_db_profile_select');
    if (!select) return;

    const profiles = extensionSettings?.dbProfiles || {};
    const active = extensionSettings?.activeDbProfile || '';

    select.innerHTML = '<option value="">-- No profile loaded --</option>';
    for (const [name, profile] of Object.entries(profiles)) {
        const option = document.createElement('option');
        option.value = name;
        const factCount = Object.values(profile.databases || {}).reduce((sum, db) => sum + (db.facts?.length || 0), 0);
        const dbCount = Object.keys(profile.databases || {}).length;
        const linkCount = (profile.linkedChats || []).length;
        option.textContent = `${name} (${dbCount} dbs, ${factCount} facts${linkCount ? `, ${linkCount} chats` : ''})`;
        select.appendChild(option);
    }

    if (active && profiles[active]) {
        select.value = active;
    }
}

async function loadDbProfile(profileName) {
    if (!profileName) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) {
        toastr.error(`Profile "${profileName}" not found`, 'BF Memory');
        return;
    }

    const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

    // Clear existing databases
    const existing = await getAllDatabases();
    for (const category of Object.keys(existing)) {
        await deleteDatabase(category);
    }

    // Load profile databases. Skip EMPTY (factless) categories — the Layer-1 skeleton is
    // shown in-memory (withSkeleton); empty categories aren't persisted as attachment files
    // (write-on-first-fact), avoiding empty-upload spam.
    for (const [category, db] of Object.entries(profile.databases || {})) {
        if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
        await saveDatabase({ ...db, category });
    }

    extensionSettings.activeDbProfile = profileName;
    saveSettings();
    refreshDbProfileDropdown();
    refreshDatabaseView();
    toastr.success(`Loaded profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile loaded: "${profileName}"`, {
        subsystem: 'import', event: 'profile.switched', actor: 'USER', data: { profileName },
    });
}

async function saveDbProfile(profileName) {
    if (!profileName) return;

    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();

    if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
    const existing = (extensionSettings.dbProfiles[profileName] && typeof extensionSettings.dbProfiles[profileName] === 'object')
        ? extensionSettings.dbProfiles[profileName]
        : {};
    extensionSettings.dbProfiles[profileName] = {
        ...existing,
        databases: JSON.parse(JSON.stringify(databases)),
        savedAt: Date.now(),
    };
    extensionSettings.activeDbProfile = profileName;
    saveSettings();
    refreshDbProfileDropdown();
    toastr.success(`Saved profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile saved: "${profileName}" (${Object.keys(databases).length} dbs)`);
}

async function deleteDbProfile(profileName) {
    if (!profileName) return;
    if (!confirm(`Delete saved profile "${profileName}"? This cannot be undone.`)) return;

    delete extensionSettings.dbProfiles[profileName];
    if (extensionSettings.activeDbProfile === profileName) {
        extensionSettings.activeDbProfile = '';
    }
    saveSettings();
    refreshDbProfileDropdown();
    toastr.success(`Deleted profile "${profileName}"`, 'BF Memory');
}

// --- Auto-save DB as chat-named profile ---

// Was named lastAutoSavedChat — kept the variable but the save logic is gone;
// it now only tracks the last chat we LOADED to skip redundant loads.
let lastAutoLoadedChat = '';

function getCurrentChatId() {
    const context = getContext();
    // ST stores the current chat filename (unique per chat)
    return context.getCurrentChatId?.() || context.chatId || '';
}

function getCurrentChatLabel() {
    const context = getContext();
    const charName = context.characters?.[context.characterId]?.name || '';
    const chatId = getCurrentChatId();
    // Use character name as the default profile name
    return charName || chatId || '';
}

/** Find which profile is linked to a given chat ID */
function findProfileForChat(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    for (const [name, profile] of Object.entries(extensionSettings.dbProfiles)) {
        if ((profile.linkedChats || []).includes(chatId)) return name;
    }
    return null;
}

/** Link a chat to a profile */
function linkChatToProfile(profileName, chatId) {
    if (!profileName || !chatId) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) return;

    if (!profile.linkedChats) profile.linkedChats = [];

    // Remove this chat from any other profile first
    for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
        if (name !== profileName && p.linkedChats) {
            p.linkedChats = p.linkedChats.filter(id => id !== chatId);
        }
    }

    if (!profile.linkedChats.includes(chatId)) {
        profile.linkedChats.push(chatId);
    }
    saveSettings();
}

/**
 * Save current databases to the active profile (call after DB changes).
 *
 * @param {string|null} profileKey - target profile (defaults to the active profile)
 * @param {{ allowEmpty?: boolean }} [options]
 * @param {boolean} [options.allowEmpty=false] - when false (the default for the every-turn
 *   extraction call sites) a totally-empty working store is NOT written through — this guards
 *   against a transient/failed getAllDatabases() load clobbering a populated profile with `{}`.
 *   USER-initiated destructive ops (Clear All / per-category delete) pass `allowEmpty:true` so an
 *   INTENTIONAL clear-to-empty actually persists to the profile (Layer C) and can no longer be
 *   resurrected by autoSaveDbProfile on the next CHAT_CHANGED.
 */
export async function saveCurrentToActiveProfile(profileKey = null, { allowEmpty = false } = {}) {
    const profileName = profileKey || extensionSettings?.activeDbProfile;
    if (!profileName) return;
    // Integrity guard: refuse to write to a profile that no longer exists
    // (prevents resurrecting a deleted profile or clobbering wrong slot after rename)
    if (!extensionSettings.dbProfiles?.[profileName]) {
        addDebugLog('fail', `Skipped save: profile "${profileName}" no longer exists (was current profile deleted?)`);
        if (typeof toastr !== 'undefined') {
            toastr.warning(`BF Memory: skipped saving facts — profile "${profileName}" was deleted.`);
        }
        return;
    }
    try {
        const { getAllDatabases } = await import('./database.js');
        const databases = await getAllDatabases();
        const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
        // Empty-store guard: by default an empty map is treated as "nothing to save" so a transient
        // load failure can't wipe a populated profile. An explicit clear/delete passes allowEmpty so
        // the genuinely-cleared state is persisted (the populated copy must NOT survive a wipe).
        if (totalFacts === 0 && !allowEmpty) return;

        extensionSettings.dbProfiles[profileName] = {
            ...extensionSettings.dbProfiles[profileName],
            databases: JSON.parse(JSON.stringify(databases)),
            savedAt: Date.now(),
        };
        saveSettings();
        addDebugLog('info', `Saved to active profile "${profileName}" (${totalFacts} facts)`, {
            subsystem: 'db', event: 'profile.saved', data: { profileName, totalFacts, allowEmpty },
        });
    } catch (err) {
        addDebugLog('fail', `Failed to save active profile: ${err.message}`);
    }
}

/**
 * Prune Layer C (the dbProfiles snapshot) so a USER-initiated delete/clear actually STICKS and
 * cannot be resurrected by autoSaveDbProfile on the next CHAT_CHANGED. Without this, deleting from
 * IDB + attachments leaves the full fact copy in extensionSettings.dbProfiles[active].databases,
 * which autoSaveDbProfile reloads on chat switch.
 *
 * Prunes EVERY profile linked to the current chat (not just the active one) plus the active profile
 * itself, so a re-link to a linked-but-not-active profile can't bring the data back.
 *
 * @param {string|null} category - a single category to remove, or null to empty ALL categories
 * @returns {{ profilesPruned: string[], factsPruned: number }}
 */
function pruneActiveProfile(category = null) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || typeof profiles !== 'object') return { profilesPruned: [], factsPruned: 0 };

    // Build the target set: the active profile + every profile linked to the current chat.
    const targets = new Set();
    const active = extensionSettings?.activeDbProfile;
    if (active && profiles[active]) targets.add(active);
    const chatId = getCurrentChatId();
    if (chatId) {
        for (const [name, profile] of Object.entries(profiles)) {
            if ((profile?.linkedChats || []).includes(chatId)) targets.add(name);
        }
    }

    const profilesPruned = [];
    let factsPruned = 0;
    for (const name of targets) {
        const profile = profiles[name];
        if (!profile || typeof profile !== 'object' || !profile.databases) continue;
        let changed = false;
        if (category == null) {
            // Empty ALL categories. Replace the snapshot with a fresh empty skeleton so the full
            // taxonomy still "exists" (zero facts) but no stored fact survives.
            for (const db of Object.values(profile.databases)) {
                factsPruned += (db?.facts?.length || 0);
            }
            profile.databases = {};
            changed = true;
        } else if (Object.prototype.hasOwnProperty.call(profile.databases, category)) {
            factsPruned += (profile.databases[category]?.facts?.length || 0);
            delete profile.databases[category];
            changed = true;
        }
        if (changed) {
            profile.savedAt = Date.now();
            profilesPruned.push(name);
        }
    }
    if (profilesPruned.length > 0) saveSettings();
    return { profilesPruned, factsPruned };
}

/**
 * FIX #9: Cheap client-side filter — returns true for messages that almost
 * certainly carry zero extractable facts, so the backfill can skip them WITHOUT
 * spending an LLM call. Conservative on purpose (only obvious no-ops):
 *   - empty / whitespace-only
 *   - very short (< 15 visible chars after stripping markup) — greetings,
 *     "ok", "*nods*", emoji, etc.
 *   - pure OOC lines: every non-empty line wrapped in (( )) or prefixed OOC:
 */
function isTriviallyEmptyForExtraction(mes) {
    const raw = String(mes ?? '');
    // Strip simple action-asterisks and collapse whitespace for the length test.
    const visible = raw.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (visible.length === 0) return true;
    if (visible.length < 15) return true;

    // Pure OOC: all non-blank lines are out-of-character chatter.
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
        const allOoc = lines.every(l =>
            /^\(\(.*\)\)$/.test(l) || /^ooc\b/i.test(l) || /^\[ooc/i.test(l));
        if (allOoc) return true;
    }
    return false;
}

/**
 * FIX #9: Estimate how many LLM calls a backfill will make, so the confirm
 * dialog can warn the user about cost up front. Mirrors the skip logic in
 * runAgent3OnFullChat WITHOUT making any calls.
 */
export function estimateFullChatCalls({ skipAlreadyProcessed = true } = {}) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    let calls = 0;
    for (const msg of chat) {
        if (!msg || !msg.mes) continue;
        if (msg.is_system) continue;
        if (msg.extra?.type) continue;
        if (skipAlreadyProcessed && msg.extra?.bf_mem_processed) continue;
        if (isTriviallyEmptyForExtraction(msg.mes)) continue;
        calls++;
    }
    return { calls, total: chat.length };
}

/**
 * Process every message in the current chat through Agent 3 sequentially.
 * Used by the "Run on current chat" button — for users who installed the
 * extension after their chat was already going.
 *
 * @param {object} options
 * @param {boolean} options.skipAlreadyProcessed - if true, skip messages whose
 *   extra.bf_mem_processed is already true (default true)
 * @param {(progress: {current: number, total: number, factsAdded: number}) => void} options.onProgress
 * @param {() => boolean} options.shouldCancel - return true to abort
 */
export async function runAgent3OnFullChat({ skipAlreadyProcessed = true, onProgress, shouldCancel } = {}) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) {
        toastr.warning('No messages in current chat', 'BF Memory');
        return { processed: 0, skipped: 0, factsAdded: 0 };
    }

    const { runMemoryUpdater } = await import('./agent-memory.js');
    const { getAgent3ProfileId } = await import('./profiler.js');
    const { getAllDatabases } = await import('./database.js');

    const profileId = getAgent3ProfileId(extensionSettings);
    const charInfo = (function() {
        const char = ctx.characters?.[ctx.characterId];
        if (!char) return '';
        const parts = [];
        if (char.name) parts.push(`Name: ${char.name}`);
        if (char.description) parts.push(`Description: ${char.description.substring(0, 2000)}`);
        if (char.personality) parts.push(`Personality: ${char.personality.substring(0, 1000)}`);
        if (char.scenario) parts.push(`Scenario: ${char.scenario.substring(0, 1000)}`);
        return parts.join('\n');
    })();
    const userPersona = ctx.persona?.description || ctx.name1 || '';

    // PERF (fix): load the databases ONCE before the loop instead of re-fetching every
    // iteration. applyUpdates() mutates this map IN PLACE (via upsertFact) and persists
    // each touched category through saveDatabase(), so the same reference stays current
    // across iterations — passing it forward is both correct and avoids a fresh round of
    // fetch()+JSON.parse per message (which on a long chat was a huge serial cost and,
    // combined with the per-message LLM call below, could hang the UI). saveDatabase()
    // also invalidates the per-turn getAllDatabases() cache, so any later reader (the
    // Database tab, the next turn's pipeline) still re-reads fresh from disk.
    const databases = await getAllDatabases();

    let processed = 0, skipped = 0, factsAdded = 0;
    const total = chat.length;
    const backfillStart = Date.now();
    addDebugLog('info', `Full-chat backfill start (${total} messages)`, {
        subsystem: 'import', event: 'backfill.start', actor: 'USER',
        data: { total, profileId: profileId || null, skipAlreadyProcessed },
    });
    // FIX #7: accumulate proposed + committed facts so the Last Generated /
    // Last Inserted tabs reflect what THIS backfill produced (mirrors pipeline.js).
    const allUpdates = [];
    const allApplied = [];

    for (let i = 0; i < chat.length; i++) {
        if (shouldCancel?.()) {
            addDebugLog('info', `Full-chat extraction cancelled at message ${i}/${total}`, {
                subsystem: 'import', event: 'backfill.cancelled', data: { msgIndex: i, total },
            });
            break;
        }
        // PERF (fix): yield to the event loop periodically so a long chat with many
        // SKIPPED (synchronous) messages doesn't freeze the UI between LLM calls. The
        // processed path already awaits an LLM call (a natural yield); this covers long
        // runs of skips (system messages, already-processed, trivially-empty) that would
        // otherwise spin the main thread with no chance for the cancel button to paint.
        if (i > 0 && i % 25 === 0) await new Promise(r => setTimeout(r, 0));
        const msg = chat[i];
        const skip = (reason) => addDebugLog('debug', `Full-chat: msg ${i + 1} skipped (${reason})`, {
            subsystem: 'import', event: 'backfill.skipped', reason, data: { msgIndex: i },
        });
        if (!msg || !msg.mes) { skipped++; skip('EMPTY'); continue; }
        if (msg.is_system) { skipped++; skip('SYSTEM'); continue; }
        if (msg.extra?.type) { skipped++; skip('EXTRA_TYPE'); continue; }
        // FIX #9: skip already-processed BEFORE spending an LLM call (short-circuit,
        // not just tally). On by default via skipAlreadyProcessed.
        if (skipAlreadyProcessed && msg.extra?.bf_mem_processed) { skipped++; skip('ALREADY_PROCESSED'); continue; }
        // FIX #9: client-side pre-filter of trivially-empty messages so we don't burn
        // a ~1200-token call on content the prompt would return zero facts for anyway.
        if (isTriviallyEmptyForExtraction(msg.mes)) {
            skipped++;
            skip('TRIVIALLY_EMPTY');
            // Still mark processed so a re-run doesn't re-evaluate the same dead message.
            msg.extra = { ...(msg.extra || {}), bf_mem_processed: true };
            continue;
        }

        try {
            // Reuse the single pre-loaded map (mutated in place + persisted by applyUpdates).
            const result = await runMemoryUpdater(
                msg.mes,
                i,
                charInfo,
                databases,
                profileId,
                !!msg.is_user,
                userPersona,
                [],  // no prior context — process each message in isolation for retro extraction
            );
            const n = result?.updates?.length || 0;
            factsAdded += n;
            if (Array.isArray(result?.updates)) allUpdates.push(...result.updates);
            // .applied = committed/changed subset (NEW/UPDATED/SKIPPED), like pipeline.js
            if (Array.isArray(result?.applied)) allApplied.push(...result.applied);
            msg.extra = { ...(msg.extra || {}), bf_mem_processed: true };
            processed++;
            onProgress?.({ current: i + 1, total, factsAdded });
            addDebugLog('info', `Full-chat: msg ${i + 1}/${total} → +${n} facts`, {
                subsystem: 'import', event: 'backfill.perMsg', data: { msgIndex: i, total, factsAdded: n },
            });
        } catch (err) {
            addDebugLog('fail', `Full-chat: msg ${i + 1} failed: ${err.message || err}`, {
                subsystem: 'import', event: 'backfill.msgFailed', reason: 'ERROR', data: { msgIndex: i, error: err.message || String(err) },
            });
        }
    }

    // FIX #7: surface this backfill's results in the Generated / Inserted panels.
    // Replace (not append) so the tabs show what this backfill produced.
    setLastGenerated(allUpdates);
    setLastInserted(allApplied);

    // Persist chat (the extra.bf_mem_processed flags) + active DB profile
    ctx.saveChatDebounced?.();
    await saveCurrentToActiveProfile();

    addDebugLog('pass', `Full-chat backfill complete: ${processed} processed, ${skipped} skipped, +${factsAdded} facts`, {
        subsystem: 'import', event: 'backfill.complete', actor: 'USER',
        data: { processed, skipped, factsAdded, durationMs: Date.now() - backfillStart },
    });
    return { processed, skipped, factsAdded };
}

async function autoSaveDbProfile() {
    try {
        const context = getContext();
        const chatId = getCurrentChatId();
        const chatLabel = getCurrentChatLabel();

        if (!chatId) return;
        if (chatId === lastAutoLoadedChat) return; // same chat, already loaded

        // NOTE: CHAT_CHANGED only LOADS, never SAVES. Saving here is unsafe because
        // ST may have already mutated state by flush time, causing the in-memory DB
        // (belonging to the previous chat) to be written into the wrong profile slot.
        // Persistence is handled at extraction time via saveCurrentToActiveProfile()
        // called from pipeline.js after every Agent 3 write (capture-at-write).

        // Check if this chat has a linked profile
        let profileToLoad = findProfileForChat(chatId);

        // If no linked profile exists, create one named after the chat/character
        if (!profileToLoad && chatLabel) {
            // Only auto-create if we're entering a chat for the first time
            if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
            if (!extensionSettings.dbProfiles[chatLabel]) {
                // 3-layer model: seed the new profile's in-memory databases with the empty
                // Layer-1 skeleton so the full taxonomy "exists" from turn 1 (visible in the
                // menu / Database tab, pickable by Agent 1). These are EMPTY (zero facts) and
                // are NOT written as attachment files here — a category file is persisted only
                // when a real fact lands (write-on-first-fact via Agent 3 / saveDatabase), so
                // we never spam the backend with empty uploads.
                const { buildSkeletonDatabases } = await import('./database.js');
                const seeded = buildSkeletonDatabases();
                extensionSettings.dbProfiles[chatLabel] = {
                    databases: seeded,
                    savedAt: Date.now(),
                    linkedChats: [chatId],
                };
                addDebugLog('info', `Auto-created DB profile "${chatLabel}" (seeded Layer-1 skeleton) for chat ${chatId}`, {
                    subsystem: 'import', event: 'db.seeded', actor: 'SYSTEM',
                    data: { profileName: chatLabel, chatId, categoriesSeeded: Object.keys(seeded) },
                });
            } else {
                // Profile with that name exists, link this chat to it
                linkChatToProfile(chatLabel, chatId);
            }
            profileToLoad = chatLabel;
        }

        // Load the linked profile
        if (profileToLoad && extensionSettings.dbProfiles?.[profileToLoad]) {
            const profile = extensionSettings.dbProfiles[profileToLoad];
            const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

            // Clear existing
            const existing = await getAllDatabases();
            for (const category of Object.keys(existing)) {
                await deleteDatabase(category);
            }

            // Load saved. Skip EMPTY (factless) categories: the Layer-1 skeleton is seeded in
            // memory and shown via withSkeleton — persisting empty categories as attachments
            // would spam the backend with empty uploads (write-on-first-fact instead).
            for (const [category, db] of Object.entries(profile.databases || {})) {
                if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
                await saveDatabase({ ...db, category });
            }

            extensionSettings.activeDbProfile = profileToLoad;
            saveSettings();
            refreshDbProfileDropdown();
            refreshLinkedChatsField();
            addDebugLog('info', `Auto-loaded DB profile "${profileToLoad}" (linked to chat ${chatId})`, {
                subsystem: 'import', event: 'profile.switched', actor: 'SYSTEM', reason: 'AUTO_LOADED', data: { profileName: profileToLoad, chatId },
            });
        }

        lastAutoLoadedChat = chatId;
    } catch (err) {
        addDebugLog('fail', `Auto-save DB profile failed: ${err.message}`);
    }
}

function refreshLinkedChatsField() {
    const display = document.getElementById('bf_mem_db_linked_chats');
    if (!display) return;
    const selected = document.getElementById('bf_mem_db_profile_select')?.value;
    const profileName = selected || extensionSettings?.activeDbProfile;
    if (!profileName || !extensionSettings?.dbProfiles?.[profileName]) {
        display.textContent = '(none)';
        return;
    }
    const profile = extensionSettings.dbProfiles[profileName];
    const chats = profile.linkedChats || [];
    display.textContent = chats.length > 0 ? chats.join(', ') : '(none)';
}

async function showLinkedChatsPopup() {
    const selected = document.getElementById('bf_mem_db_profile_select')?.value;
    const profileName = selected || extensionSettings?.activeDbProfile;
    if (!profileName || !extensionSettings?.dbProfiles?.[profileName]) {
        toastr.warning('No profile selected', 'BF Memory');
        return;
    }

    const profile = extensionSettings.dbProfiles[profileName];
    const linkedChats = [...(profile.linkedChats || [])];
    const currentChatId = getCurrentChatId();

    let html = `<div class="bf-mem-linked-popup">
        <h4>Linked Chats for "${escapeHtml(profileName)}"</h4>
        <p>These chats will auto-load this DB profile when opened.</p>
        <div class="bf-mem-linked-list" id="bf_mem_linked_list">`;

    if (linkedChats.length === 0) {
        html += '<div class="bf-mem-empty">No chats linked yet.</div>';
    } else {
        for (const chatId of linkedChats) {
            const isCurrent = chatId === currentChatId;
            html += `<div class="bf-mem-linked-item">
                <span class="bf-mem-linked-name">${escapeHtml(chatId)}${isCurrent ? ' (current)' : ''}</span>
                <button class="bf-mem-linked-remove menu_button" data-chat="${escapeHtml(chatId)}" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
        }
    }

    html += `</div>
        <div class="bf-mem-linked-add-row" style="margin-top: 10px;">
            <button id="bf_mem_link_current" class="menu_button">
                <i class="fa-solid fa-plus"></i> Link Current Chat
            </button>
        </div>
    </div>`;

    await ensurePopup();
    if (!Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true });
    await popup.show();

    // Bind remove buttons
    document.querySelectorAll('.bf-mem-linked-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const chatId = btn.dataset.chat;
            const idx = profile.linkedChats.indexOf(chatId);
            if (idx >= 0) {
                profile.linkedChats.splice(idx, 1);
                saveSettings();
                refreshLinkedChatsField();
                refreshDbProfileDropdown();
                btn.closest('.bf-mem-linked-item').remove();
                toastr.success(`Unlinked "${chatId}"`, 'BF Memory');
            }
        });
    });

    // Bind "Link Current Chat" button
    document.getElementById('bf_mem_link_current')?.addEventListener('click', () => {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.warning('No chat currently open', 'BF Memory');
            return;
        }
        if (!profile.linkedChats) profile.linkedChats = [];
        if (profile.linkedChats.includes(chatId)) {
            toastr.info('Current chat is already linked', 'BF Memory');
            return;
        }
        // Remove from other profiles first
        for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
            if (name !== profileName && p.linkedChats) {
                p.linkedChats = p.linkedChats.filter(id => id !== chatId);
            }
        }
        profile.linkedChats.push(chatId);
        saveSettings();
        refreshLinkedChatsField();
        refreshDbProfileDropdown();
        toastr.success(`Linked current chat to "${profileName}"`, 'BF Memory');
        // Refresh the popup list
        const listEl = document.getElementById('bf_mem_linked_list');
        if (listEl) {
            const item = document.createElement('div');
            item.className = 'bf-mem-linked-item';
            item.innerHTML = `<span class="bf-mem-linked-name">${escapeHtml(chatId)} (current)</span>
                <button class="bf-mem-linked-remove menu_button" data-chat="${escapeHtml(chatId)}" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>`;
            listEl.querySelector('.bf-mem-empty')?.remove();
            listEl.appendChild(item);
        }
    });
}

// --- Init ---

export async function initSettings() {
    const context = getContext();

    // Load saved settings (guard against null, arrays, primitives, or corrupted blobs)
    if (!context.extensionSettings) context.extensionSettings = {};
    let resetClobberedEnabled = false; // FIX #10: track if a reset flipped enabled true->false
    try {
        const current = context.extensionSettings[EXTENSION_NAME];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            if (current && typeof current === 'object' && current.enabled === true) resetClobberedEnabled = true;
            context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
    } catch (err) {
        console.error('[BFMemory] corrupt settings, resetting:', err);
        try { if (context.extensionSettings?.[EXTENSION_NAME]?.enabled === true) resetClobberedEnabled = true; } catch { /* ignore */ }
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        if (typeof toastr !== 'undefined') {
            toastr.warning('BF Memory settings were corrupt and have been reset.');
        }
    }
    extensionSettings = context.extensionSettings[EXTENSION_NAME];

    // Merge missing defaults
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings, key)) {
            extensionSettings[key] = value;
        }
    }

    // Migrate legacy settings keys (soft migration — leaves old key for rollback)
    migrateLegacySettings(extensionSettings);

    // Type-coerce and clamp values (defends against persisted garbage)
    validateSettings(extensionSettings);

    // FIX #10: log if a corrupt-settings reset silently turned the pipeline off.
    if (resetClobberedEnabled && !extensionSettings.enabled) {
        addDebugLog('fail', 'Pipeline DISABLED by corrupt-settings reset (was enabled before reset)');
    }

    // Load HTML template
    let path = `scripts/extensions/third-party/${EXTENSION_NAME}`;
    let html = null;

    try {
        html = await $.get(`${path}/templates/settings.html`);
    } catch {
        path = `scripts/extensions/${EXTENSION_NAME}`;
        try {
            html = await $.get(`${path}/templates/settings.html`);
        } catch {
            console.error('[BFMemory] Failed to load UI template');
            return;
        }
    }

    $('#extensions_settings').append(html);

    // Populate version label from manifest (single source of truth — no risk of drift).
    // If the fetch fails, the placeholder "v?.?.?" remains so testers can see it didn't load.
    try {
        const manifest = await $.getJSON(`${path}/manifest.json`);
        if (manifest?.version) {
            $('#bf_mem_version').text(`v${manifest.version}`);
        }
    } catch (err) {
        console.warn('[BFMemory] Could not load manifest for version label:', err?.message);
    }

    // --- Setup Tabs ---
    setupTabs();

    // --- Pipeline Tab ---
    $('#bf_mem_enabled').prop('checked', extensionSettings.enabled).on('change', function () {
        const next = $(this).prop('checked');
        // FIX #10: log enable/disable state changes.
        if (next !== extensionSettings.enabled) {
            addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} by user`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled' }, before: !!extensionSettings.enabled, after: !!next });
        }
        extensionSettings.enabled = next;
        updateStatus('idle');
        saveSettings();
        // CANCEL ON DISABLE: toggling OFF must HALT an in-flight run promptly, not let it finish
        // ~75s later and inject. cancelActiveRun() sets the cancel flag AND aborts in-flight agent
        // LLM calls. Dynamic import avoids a static circular dep (pipeline.js imports settings.js).
        if (!next) {
            import('./pipeline.js')
                .then(({ cancelActiveRun }) => cancelActiveRun?.('disabled'))
                .catch(() => { /* pipeline not ready yet — nothing in flight to cancel */ });
        }
    });

    // "Use separate profiles" toggle REMOVED (v0.21.x menu cleanup): per-agent profiles are
    // now ALWAYS active. The useMemoryProfile key is kept (default true) for back-compat;
    // profiler.js no longer gates on it (getAgent1/3/4ProfileId always honor configured profiles).

    reloadProfiles();
    $('#bf_mem_agent1_profile').val(extensionSettings.agent1Profile || '').on('change', function () {
        extensionSettings.agent1Profile = $(this).val() || '';
        addDebugLog('info', `Agent 1 profile changed`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent1Profile', value: extensionSettings.agent1Profile } });
        saveSettings();
    });
    $('#bf_mem_agent3_profile').val(extensionSettings.agent3Profile || '').on('change', function () {
        extensionSettings.agent3Profile = $(this).val() || '';
        addDebugLog('info', `Agent 3 profile changed`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent3Profile', value: extensionSettings.agent3Profile } });
        saveSettings();
    });

    $('#bf_mem_refresh_profiles').on('click', () => {
        reloadProfiles();
        toastr.info('Profiles refreshed', 'BF Memory');
    });

    // Agent 4 (Fact Finder) — toggle + profile selector (Agent 2 tab / Fact Finder section).
    // reloadProfiles() above already populated the dropdown; just bind value + change.
    $('#bf_mem_finder_enabled').prop('checked', extensionSettings.useFinderAgent !== false).on('change', function () {
        const before = extensionSettings.useFinderAgent !== false;
        extensionSettings.useFinderAgent = $(this).prop('checked');
        addDebugLog('info', `Finder agent ${extensionSettings.useFinderAgent ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'useFinderAgent' }, before, after: !!extensionSettings.useFinderAgent });
        saveSettings();
    });
    $('#bf_mem_agent4_profile').val(extensionSettings.agent4Profile || '').on('change', function () {
        extensionSettings.agent4Profile = $(this).val() || '';
        addDebugLog('info', `Finder profile changed`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent4Profile', value: extensionSettings.agent4Profile } });
        saveSettings();
    });

    // Agent 1 context slider
    $('#bf_mem_agent1_context').val(extensionSettings.agent1ContextMessages);
    $('#bf_mem_agent1_context_val').text(extensionSettings.agent1ContextMessages);
    $('#bf_mem_agent1_context').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.agent1ContextMessages;
        extensionSettings.agent1ContextMessages = val;
        $('#bf_mem_agent1_context_val').text(val);
        if (before !== val) addDebugLog('debug', `Agent 1 context messages: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent1ContextMessages' }, before, after: val });
        saveSettings();
    });

    // Agent 3 context slider
    $('#bf_mem_agent3_context').val(extensionSettings.agent3ContextMessages);
    $('#bf_mem_agent3_context_val').text(extensionSettings.agent3ContextMessages);
    $('#bf_mem_agent3_context').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.agent3ContextMessages;
        extensionSettings.agent3ContextMessages = val;
        $('#bf_mem_agent3_context_val').text(val);
        if (before !== val) addDebugLog('debug', `Agent 3 context messages: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent3ContextMessages' }, before, after: val });
        saveSettings();
    });

    // Agent 2 context slider (force-attention duplication)
    $('#bf_mem_agent2_context').val(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context_val').text(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.agent2ContextMessages = val;
        $('#bf_mem_agent2_context_val').text(val);
        saveSettings();
    });

    // Writer recall tool toggle (pull-detail / "infinite reach"). Default OFF. Toggling it
    // register/unregisters the optional search_memory function-tool via syncWriterRecallTool().
    $('#bf_mem_recall_tool_enabled').prop('checked', extensionSettings.enableWriterRecallTool === true).on('change', function () {
        const before = extensionSettings.enableWriterRecallTool === true;
        const next = $(this).prop('checked');
        extensionSettings.enableWriterRecallTool = next;
        addDebugLog('info', `Writer recall tool ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enableWriterRecallTool' }, before, after: !!next });
        saveSettings();
        // Re-sync registration to the new state (cycle-safe lazy import).
        import('./agent-writer.js').then(m => m.syncWriterRecallTool?.()).catch(() => {});
    });

    // Summary pyramid "Big Picture" injection toggle. Default OFF. Gates ONLY whether the
    // story+shelf summaries are injected into the Writer's context — shelf summaries are
    // still generated on the reflection cadence regardless. No registration side-effect.
    $('#bf_mem_pyramid_enabled').prop('checked', extensionSettings.enableSummaryPyramid === true).on('change', function () {
        const before = extensionSettings.enableSummaryPyramid === true;
        const next = $(this).prop('checked');
        extensionSettings.enableSummaryPyramid = next;
        addDebugLog('info', `Summary pyramid Big Picture injection ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enableSummaryPyramid' }, before, after: !!next });
        saveSettings();
    });

    // Auto-linking toggle (A-MEM style associative linking). DEFAULT ON (free + deterministic),
    // so the checkbox reflects `!== false`. Gates whether applyUpdates auto-connects a fresh fact
    // to related existing facts via `relationships`. No registration side-effect.
    $('#bf_mem_autolink_enabled').prop('checked', extensionSettings.enableAutoLinking !== false).on('change', function () {
        const before = extensionSettings.enableAutoLinking !== false;
        const next = $(this).prop('checked');
        extensionSettings.enableAutoLinking = next;
        addDebugLog('info', `Automatic associative linking ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enableAutoLinking' }, before, after: !!next });
        saveSettings();
    });

    // Review interval slider
    $('#bf_mem_review_interval').val(extensionSettings.reviewInterval);
    $('#bf_mem_review_val').text(extensionSettings.reviewInterval);
    $('#bf_mem_review_interval').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.reviewInterval;
        extensionSettings.reviewInterval = val;
        $('#bf_mem_review_val').text(val);
        if (before !== val) addDebugLog('debug', `Review interval: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'reviewInterval' }, before, after: val });
        saveSettings();
    });

    // Secondary/Tertiary fact-chance sliders REMOVED (v0.21.x menu cleanup): retrieval became
    // deterministic, so these gated nothing. The settings keys (secondaryChance/tertiaryChance)
    // are retained inert in DEFAULT_SETTINGS/validateSettings for back-compat only.

    // Depth-dice sliders (Feature #4). Stored as 0..1 floats; UI shows percent.
    [1, 2, 3, 4].forEach(n => {
        const slider = `#bf_mem_depth${n}`;
        const label = `#bf_mem_depth${n}_val`;
        const key = `depthDice${n}`;
        const pct = Math.round((Number(extensionSettings[key]) || 0) * 100);
        $(slider).val(pct);
        $(label).text(`${pct}%`);
        $(slider).on('input', function () {
            const v = parseInt($(this).val());
            extensionSettings[key] = v / 100;
            $(label).text(`${v}%`);
            saveSettings();
        });
    });

    // Toast
    $('#bf_mem_toast').prop('checked', extensionSettings.showToast).on('change', function () {
        extensionSettings.showToast = $(this).prop('checked');
        saveSettings();
    });

    // Scene card enable toggle (Agent 1 tab)
    $('#bf_mem_scene_enabled').prop('checked', extensionSettings.sceneCardEnabled).on('change', function () {
        extensionSettings.sceneCardEnabled = $(this).prop('checked');
        saveSettings();
    });
    // Render the current live scene card (read-only)
    renderScene();

    // Reflection / consolidation (Agent 3 tab)
    $('#bf_mem_reflection_enabled').prop('checked', extensionSettings.reflectionEnabled).on('change', function () {
        extensionSettings.reflectionEnabled = $(this).prop('checked');
        saveSettings();
    });
    // "Inject story so far" checkbox REMOVED (v0.21.x menu cleanup): the summary is no longer
    // injected into the writer under any setting. reflectionInject key is kept (default false)
    // in DEFAULT_SETTINGS/validateSettings for back-compat only.
    $('#bf_mem_reflection_interval').val(extensionSettings.reflectionInterval);
    $('#bf_mem_reflection_interval_val').text(extensionSettings.reflectionInterval);
    $('#bf_mem_reflection_interval').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.reflectionInterval;
        extensionSettings.reflectionInterval = val;
        $('#bf_mem_reflection_interval_val').text(val);
        if (before !== val) addDebugLog('debug', `Reflection interval changed: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'reflectionInterval' }, before, after: val });
        saveSettings();
    });
    $('#bf_mem_reflection_prompt').val(extensionSettings.reflectionPrompt || DEFAULT_REFLECT_PROMPT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.reflectionPrompt = (val === DEFAULT_REFLECT_PROMPT) ? '' : val;
        saveSettings();
    });
    $('#bf_mem_reset_reflection_prompt').on('click', () => {
        extensionSettings.reflectionPrompt = '';
        $('#bf_mem_reflection_prompt').val(DEFAULT_REFLECT_PROMPT);
        addDebugLog('info', 'Reflection prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'reflectionPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Reflection prompt reset', 'BF Memory');
    });
    // Render the current live reflection summary (read-only)
    renderReflection();

    // --- Character Registry (Agent 3 tab) ---
    $('#bf_mem_charreg_enabled').prop('checked', extensionSettings.characterRegistryEnabled !== false).on('change', function () {
        extensionSettings.characterRegistryEnabled = $(this).prop('checked');
        saveSettings();
    });
    $('#bf_mem_charcheck_interval').val(extensionSettings.characterCheckInterval);
    $('#bf_mem_charcheck_interval_val').text(extensionSettings.characterCheckInterval);
    $('#bf_mem_charcheck_interval').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.characterCheckInterval;
        extensionSettings.characterCheckInterval = val;
        $('#bf_mem_charcheck_interval_val').text(val);
        if (before !== val) addDebugLog('debug', `Character-check interval changed: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'characterCheckInterval' }, before, after: val });
        saveSettings();
    });
    // Manual "scan now": run the deterministic scan and, if there are unclassified named
    // candidates, open the batched popup immediately (off the normal interval gate).
    $('#bf_mem_charreg_scan').on('click', async () => {
        try {
            const { getAllDatabases } = await import('./database.js');
            const databases = await getAllDatabases();
            const candidates = scanForNamedCandidates(databases);
            if (candidates.length === 0) {
                toastr.info('No new named characters found.', 'BF Memory');
                renderEntities();
                return;
            }
            await showEntityPopup(candidates);
            renderEntities();
        } catch (err) {
            addDebugLog('fail', `Manual character scan failed: ${err.message || err}`);
        }
    });
    // Render the current live registry list.
    renderEntities();

    // --- Prompts Tab ---
    $('#bf_mem_draft_prompt').val(extensionSettings.draftPrompt || DEFAULT_DRAFT_PROMPT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.draftPrompt = (val === DEFAULT_DRAFT_PROMPT) ? '' : val;
        saveSettings();
    });

    $('#bf_mem_memory_prompt').val(extensionSettings.memoryPrompt || DEFAULT_MEMORY_PROMPT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.memoryPrompt = (val === DEFAULT_MEMORY_PROMPT) ? '' : val;
        saveSettings();
    });

    $('#bf_mem_writer_format').val(extensionSettings.writerFormat || DEFAULT_WRITER_FORMAT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.writerFormat = (val === DEFAULT_WRITER_FORMAT) ? '' : val;
        saveSettings();
    });

    $('#bf_mem_reset_draft_prompt').on('click', () => {
        extensionSettings.draftPrompt = '';
        $('#bf_mem_draft_prompt').val(DEFAULT_DRAFT_PROMPT);
        addDebugLog('info', 'Agent 1 (draft) prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'draftPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Draft prompt reset', 'BF Memory');
    });

    $('#bf_mem_reset_memory_prompt').on('click', () => {
        extensionSettings.memoryPrompt = '';
        $('#bf_mem_memory_prompt').val(DEFAULT_MEMORY_PROMPT);
        addDebugLog('info', 'Agent 3 (memory) prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'memoryPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Memory prompt reset', 'BF Memory');
    });

    $('#bf_mem_reset_writer_format').on('click', () => {
        extensionSettings.writerFormat = '';
        $('#bf_mem_writer_format').val(DEFAULT_WRITER_FORMAT);
        saveSettings();
        toastr.info('Writer format reset', 'BF Memory');
    });

    // Fact Finder (Agent 4) prompt editor + reset (Agent 2 tab).
    $('#bf_mem_finder_prompt').val(extensionSettings.finderPrompt || DEFAULT_FINDER_PROMPT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.finderPrompt = (val === DEFAULT_FINDER_PROMPT) ? '' : val;
        saveSettings();
    });
    $('#bf_mem_reset_finder_prompt').on('click', () => {
        extensionSettings.finderPrompt = '';
        $('#bf_mem_finder_prompt').val(DEFAULT_FINDER_PROMPT);
        addDebugLog('info', 'Finder prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'finderPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Librarian prompt reset', 'BF Memory');
    });

    // --- Database Tab: Profiles ---
    refreshDbProfileDropdown();

    $('#bf_mem_db_profile_load').on('click', () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select a profile to load', 'BF Memory');
            return;
        }
        loadDbProfile(selected);
    });

    $('#bf_mem_db_profile_save').on('click', () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select an existing profile to overwrite, or use "Save As New"', 'BF Memory');
            return;
        }
        saveDbProfile(selected);
    });

    $('#bf_mem_db_profile_save_new').on('click', () => {
        const name = prompt('Enter a name for this database profile:');
        if (!name || !name.trim()) return;
        const cleanName = name.trim();
        if (extensionSettings.dbProfiles?.[cleanName]) {
            if (!confirm(`Profile "${cleanName}" already exists. Overwrite?`)) return;
        }
        saveDbProfile(cleanName);
    });

    $('#bf_mem_db_profile_delete').on('click', () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select a profile to delete', 'BF Memory');
            return;
        }
        deleteDbProfile(selected);
    });

    // Linked chats display + manage button
    refreshLinkedChatsField();
    $('#bf_mem_db_profile_select').on('change', () => refreshLinkedChatsField());
    $('#bf_mem_db_linked_manage').on('click', () => showLinkedChatsPopup());

    // --- Database Tab ---
    $('#bf_mem_refresh_db').on('click', () => refreshDatabaseView());
    $('#bf_mem_browse_db').on('click', () => showAllDatabases());

    // Add-label (user taxonomy overlay) controls.
    $('#bf_mem_addleaf_btn').on('click', () => {
        addUserLeaf(
            $('#bf_mem_addleaf_category').val(),
            $('#bf_mem_addleaf_name').val(),
            $('#bf_mem_addleaf_subarea').val(),
        );
    });
    $('#bf_mem_addleaf_name').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#bf_mem_addleaf_btn').trigger('click'); } });
    $('#bf_mem_addcat_btn').on('click', () => addUserCategory($('#bf_mem_addcat_name').val()));
    $('#bf_mem_addcat_name').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#bf_mem_addcat_btn').trigger('click'); } });
    // AI suggest-new-labels (manual, on-demand — mines homeless facts, one LLM call, approval gate).
    $('#bf_mem_suggest_labels_btn').on('click', () => onSuggestLabelsClick());
    $('#bf_mem_export_db').on('click', async () => {
        const { getAllDatabases } = await import('./database.js');
        const databases = await getAllDatabases();
        const json = JSON.stringify(databases, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bf-memory-export-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        const dbCount = Object.keys(databases).length;
        const totalFacts = Object.values(databases).reduce((s, db) => s + (db.facts?.length || 0), 0);
        addDebugLog('info', `Databases exported (${dbCount} dbs, ${totalFacts} facts)`, {
            subsystem: 'import', event: 'db.exported', actor: 'USER', data: { dbCount, totalFacts },
        });
        toastr.success('Databases exported', 'BF Memory');
    });

    $('#bf_mem_clear_db').on('click', async () => {
        if (!confirm('Reset memory to EMPTY for this character? This wipes every stored fact across all storage layers. This cannot be undone.')) return;
        const { getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
        const dbs = await getAllDatabases();
        const clearedCats = Object.keys(dbs);
        const clearedFacts = Object.values(dbs).reduce((s, db) => s + (db.facts?.length || 0), 0);
        // Cancel any armed snapshot up-front so it can't fire mid-loop and re-write a deleted file.
        cancelPendingSnapshot();
        // Layer A (IDB) + Layer B (attachment files): deleteDatabase wipes both per category.
        for (const category of clearedCats) {
            await deleteDatabase(category);
        }
        // Layer C (dbProfiles snapshot): empty the active + every chat-linked profile so
        // autoSaveDbProfile reloads an EMPTY profile on the next CHAT_CHANGED instead of resurrecting.
        const { profilesPruned, factsPruned } = pruneActiveProfile(null);
        // Belt-and-suspenders: persist the genuinely-empty working store into the active profile too
        // (allowEmpty bypasses the empty-store guard that normally blocks an empty save).
        await saveCurrentToActiveProfile(null, { allowEmpty: true });
        // Force a reconciling durable snapshot NOW: reconcileDeletedAttachments deletes attachment
        // files for every category no longer live in IDB, so no leftover file can rehydrate.
        await flushSnapshotNow();
        addDebugLog('pass', `Reset to empty: cleared ${clearedFacts} facts across ${clearedCats.length} categories + profile pruned`, {
            subsystem: 'db', event: 'db.cleared', actor: 'USER', reason: 'USER_CLEAR_ALL',
            data: {
                dbCount: clearedCats.length, totalFacts: clearedFacts, categories: clearedCats,
                profilesPruned, factsPrunedFromProfile: factsPruned,
            },
        });
        toastr.success('Memory reset to empty (all layers)', 'BF Memory');
        refreshDatabaseView();
    });

    // --- Run Agent 3 on full chat (retroactive extraction) ---
    let fullChatCancel = false;
    $('#bf_mem_run_full_chat').on('click', async () => {
        const skipDone = $('#bf_mem_skip_processed').is(':checked');
        // FIX #9: estimate LLM calls (post-skip, post-prefilter) so the user sees cost.
        const { calls, total } = estimateFullChatCalls({ skipAlreadyProcessed: skipDone });
        if (calls === 0) {
            toastr.info(`Nothing to process: all ${total} message(s) are already done or trivially empty.`, 'BF Memory');
            return;
        }
        if (!confirm(`Run the Scribe on this chat?\n\nThis will make ~${calls} LLM call(s) (one per eligible message, out of ${total} total). Each call costs tokens. Already-processed and trivially-empty messages are skipped.\n\nProceed?`)) return;
        const btn = $('#bf_mem_run_full_chat');
        const progress = $('#bf_mem_full_chat_progress');
        const cancelBtn = $('#bf_mem_run_full_chat_cancel');

        fullChatCancel = false;
        btn.prop('disabled', true).text('Running...');
        cancelBtn.show();
        progress.show().text('Starting…');

        try {
            const result = await runAgent3OnFullChat({
                skipAlreadyProcessed: skipDone,
                onProgress: ({ current, total, factsAdded }) => {
                    progress.text(`Message ${current}/${total} · ${factsAdded} facts added`);
                },
                shouldCancel: () => fullChatCancel,
            });
            const verb = fullChatCancel ? 'cancelled' : 'finished';
            toastr.success(`Full-chat ${verb}: ${result.processed} processed, ${result.skipped} skipped, ${result.factsAdded} facts added`, 'BF Memory');
            progress.text(`${verb}: ${result.processed} processed, ${result.skipped} skipped, ${result.factsAdded} facts`);
        } catch (err) {
            toastr.error(`Full-chat failed: ${err.message}`, 'BF Memory');
            progress.text(`Failed: ${err.message}`);
        } finally {
            btn.prop('disabled', false).text('Run the Scribe on full chat');
            cancelBtn.hide();
        }
    });

    $('#bf_mem_run_full_chat_cancel').on('click', () => {
        fullChatCancel = true;
        $('#bf_mem_run_full_chat_cancel').prop('disabled', true).text('Cancelling…');
    });

    // --- Tokens Tab ---
    $('#bf_mem_tokens_reset').on('click', () => {
        sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
        saveTokensToMeta();
        renderTokens();
    });

    // --- Debug Tab ---
    $('#bf_mem_debug').prop('checked', extensionSettings.debugMode).on('change', function () {
        extensionSettings.debugMode = $(this).prop('checked');
        saveSettings();
    });

    // Verbose tier toggle (opt-in firehose). When OFF, addDebugLog drops level:'verbose'
    // at INGESTION (see addDebugLog) — this is the capture-side volume control, not just a
    // display filter. Greys out the verbose display checkbox to match (nothing to show).
    const syncVerboseLevelControl = () => {
        const on = !!extensionSettings.debugVerbose;
        const vbox = document.querySelector('.bf-mem-log-level[value="verbose"]');
        const wrap = document.getElementById('bf_mem_log_level_verbose_wrap');
        if (vbox) { vbox.disabled = !on; if (!on) vbox.checked = false; }
        if (wrap) wrap.classList.toggle('bf-mem-disabled', !on);
    };
    $('#bf_mem_debug_verbose').prop('checked', extensionSettings.debugVerbose).on('change', function () {
        extensionSettings.debugVerbose = $(this).prop('checked');
        saveSettings();
        syncVerboseLevelControl();
        renderDebugLog();
    });
    syncVerboseLevelControl();

    // Filter toolbar: pure client-side re-render over the in-memory buffer on any change.
    $(document).on('change', '.bf-mem-log-level', () => renderDebugLog());
    $('#bf_mem_log_subsystem').on('change', () => renderDebugLog());
    $('#bf_mem_log_search').on('input', () => renderDebugLog());

    $('#bf_mem_clear_log').on('click', () => {
        debugLog = [];
        saveDebugLogToMeta(); // also clear the persistent metadata slice
        // Also delete the dedicated debug-log FILE for this chat (best-effort, async).
        logFileDirty = false;
        let chatId = '';
        try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
        if (chatId) {
            (async () => {
                try { const { deleteDebugLogFile } = await import('./database.js'); await deleteDebugLogFile(chatId); }
                catch { /* best-effort */ }
            })();
        }
        renderDebugLog();
    });

    // Export the full RAM ring buffer as machine-readable JSON. Mirrors the Copy button's
    // clipboard-with-mobile-fallback pattern, plus a file download.
    $('#bf_mem_export_json').on('click', async () => {
        const json = exportLogsJSON();
        let chatId = 'log';
        try { chatId = String(getContext().chatId ?? 'log'); } catch { /* no chat */ }
        const fname = `bf-mem-log-${chatId}-${Date.now()}.json`;
        // Download as a file.
        try {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch { /* download best-effort */ }
        // Also copy to clipboard for convenience.
        try {
            await navigator.clipboard.writeText(json);
            toastr.success(`Log JSON downloaded + copied (${debugLog.length} entries)`, 'BF Memory');
        } catch {
            toastr.success(`Log JSON downloaded (${debugLog.length} entries)`, 'BF Memory');
        }
    });

    // "Why not fact X?" retrieval probe — explains a single fact's fate this turn.
    const runProbe = async () => {
        const input = document.getElementById('bf_mem_probe_key');
        const out = document.getElementById('bf_mem_probe_result');
        if (!out) return;
        const key = (input?.value || '').trim();
        if (!key) { out.textContent = 'Enter a fact key (e.g. Status/location) to probe.'; return; }
        out.textContent = 'Checking…';
        try {
            const res = await explainFactRetrieval(key);
            const detail = res.detail ? safeStringify(res.detail) : '';
            out.innerHTML =
                `<span class="bf-mem-probe-reason ${res.found ? 'found' : 'missing'}">${escapeHtml(res.reason || 'unknown')}</span> ` +
                `<span class="bf-mem-probe-detail">${escapeHtml(detail)}</span>`;
        } catch (err) {
            out.textContent = `Probe failed: ${err?.message || err}`;
        }
    };
    $('#bf_mem_probe_btn').on('click', runProbe);
    $('#bf_mem_probe_key').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runProbe(); } });

    $('#bf_mem_copy_log').on('click', async () => {
        const logText = exportLogs();
        try {
            await navigator.clipboard.writeText(logText);
            toastr.success('Logs copied to clipboard', 'BF Memory');
        } catch {
            // Mobile-friendly fallback: prompt() truncates and lacks select-all.
            // Build a textarea overlay that the user can long-press to select-all.
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1a1a2e);padding:16px;border-radius:8px;max-width:600px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:8px;';
            const title = document.createElement('div');
            title.textContent = 'Copy debug log';
            title.style.cssText = 'font-weight:bold;color:#7bb3ff;';
            const hint = document.createElement('div');
            hint.textContent = 'Long-press the text area to Select All, then Copy.';
            hint.style.cssText = 'font-size:12px;opacity:0.7;';
            const textarea = document.createElement('textarea');
            textarea.value = logText;
            textarea.readOnly = true;
            textarea.style.cssText = 'width:100%;min-height:200px;flex:1;font-family:monospace;font-size:11px;background:#000;color:#eee;padding:8px;';
            const buttonRow = document.createElement('div');
            buttonRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            const selectAllBtn = document.createElement('button');
            selectAllBtn.textContent = 'Select All';
            selectAllBtn.className = 'menu_button';
            selectAllBtn.onclick = () => { textarea.select(); textarea.setSelectionRange(0, textarea.value.length); };
            const closeBtn = document.createElement('button');
            closeBtn.textContent = 'Close';
            closeBtn.className = 'menu_button';
            closeBtn.onclick = () => overlay.remove();
            buttonRow.appendChild(selectAllBtn);
            buttonRow.appendChild(closeBtn);
            card.appendChild(title);
            card.appendChild(hint);
            card.appendChild(textarea);
            card.appendChild(buttonRow);
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            // Auto-select on open for desktop convenience
            setTimeout(() => { textarea.focus(); textarea.select(); }, 0);
        }
    });

    // --- Auto-refresh profiles on change ---
    context.eventSource?.on(context.eventTypes?.CONNECTION_PROFILE_LOADED, () => reloadProfiles());

    // --- Auto-save DB profile on chat change (named after current chat) ---
    context.eventSource?.on(context.eventTypes?.CHAT_CHANGED, async () => {
        // FIX #59: flush the OUTGOING chat's debug-log tail to its own file BEFORE we swap the
        // buffer to the new chat — otherwise the last few (esp. verbose) lines of the chat you're
        // leaving are lost. Targets the tracked old chatId (the live one has already advanced).
        await flushOutgoingChatLog();
        await autoSaveDbProfile();
        // Reload the persistent debug log AND fact panels from the new chat's metadata
        // so each chat shows its own history (not a stale cross-chat snapshot).
        reloadDebugLogFromChat();
        reloadFactsFromChat();
        reloadTokensFromChat();
        reloadSceneFromChat();
        reloadReflectionFromChat();
        reloadPyramidFromChat();
        reloadEntitiesUI();
    });

    // Initial load: pull any previously-persisted log entries + facts for the current chat
    reloadDebugLogFromChat();
    reloadFactsFromChat();
    reloadTokensFromChat();
    reloadSceneFromChat();
    reloadReflectionFromChat();
    reloadPyramidFromChat();
    reloadEntitiesUI();

    // Save to active profile on page close/refresh
    window.addEventListener('beforeunload', () => {
        // Synchronous best-effort save to settings (no async file ops)
        const profileName = extensionSettings?.activeDbProfile;
        if (profileName && extensionSettings?.dbProfiles?.[profileName]) {
            // Can't do async here, but saveSettings is synchronous (debounced flush)
            saveSettings();
        }
        // FIX #8: guarantee the debug log reaches disk before reload. saveMetadata()
        // is debounced, so a synchronous immediate chat save here is the primary fix —
        // reload is exactly when the buffered entries would otherwise be lost.
        flushDebugLogNow();
        // HYBRID PERSISTENCE: best-effort flush of the durable IDB→attachment snapshot so the
        // newest facts reach the backend before reload. beforeunload can't reliably AWAIT the
        // async upload, so the throttled cadence (every ~15s) remains the real guarantee; this
        // is a final nudge. Fire-and-forget + self-guarded (never throws). Imported lazily to
        // avoid a static settings.js→database.js cycle.
        import('./database.js').then(m => m.flushSnapshotNow?.()).catch(() => {});
    });

    // Note: removed MESSAGE_RECEIVED → saveCurrentToActiveProfile() handler.
    // pipeline.js now persists via saveCurrentToActiveProfile(capturedDbProfile)
    // after every Agent 3 write, with capture-at-write semantics. The old
    // unprotected handler here was a residual leak path (same class as Issue #2).

    // --- Initial state ---
    updateStatus('idle');

    console.log('[BFMemory] Settings initialized');
}
