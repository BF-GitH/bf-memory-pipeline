// BF Memory Pipeline - Agent 2: Writer
// Uses the DEFAULT SillyTavern profile (main model)
// Receives: draft + retrieved facts + character cards + system prompt
// Output: injected into the prompt so the main model writes a fact-grounded response

// host.js is dependency-free (imports nothing from the extension), so a STATIC import
// of it is cycle-safe even though this module dynamically imports settings/fact-retrieval
// below to dodge their cycles.
import * as host from './host.js';

// Lazy access to avoid circular dependency (settings imports our DEFAULT_WRITER_FORMAT)
function getSettingsSafe() {
    return host.getExtensionSettings();
}

export const DEFAULT_WRITER_FORMAT = `[Memory Context - established truth for this scene]

#Established Facts (Category/key = value):
{facts}

#Scene Direction:
{draft}

[How to use the facts above:
- Treat every fact as ESTABLISHED TRUTH. Weave the relevant ones into the scene naturally — through action, dialogue, and detail — rather than listing them.
- PREFER these stored facts over inventing new details. When a fact covers something, use it instead of making something up.
- Never contradict a fact. If the scene needs a detail a fact already defines, match the fact exactly.
- A character only knows facts whose [bracketed] names include that character. Do not let a character act on facts they don't know.]`;

/**
 * Build the compact always-on scene block (MemGPT-style core working memory).
 * One line: [Scene] Location: <loc> | Present: <a, b> | Goal: <g> | Recently: <b1>; <b2>
 * Hard-capped (~maxTokens) with defensive char-budget truncation so a runaway scene
 * can never blow up the prompt. Returns '' when no usable scene exists.
 * @param {object|null} scene - { location, present[], goals[], beats[] }
 * @param {number} [maxTokens=150] - approximate hard cap (1 token ≈ 4 chars heuristic)
 * @returns {string}
 */
export function buildSceneBlock(scene, maxTokens = 150) {
    if (!scene || typeof scene !== 'object') return '';
    const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];
    const loc = typeof scene.location === 'string' ? scene.location.trim() : '';
    const present = arr(scene.present);
    const goals = arr(scene.goals);
    const beats = arr(scene.beats);
    if (!loc && present.length === 0 && goals.length === 0 && beats.length === 0) return '';

    const parts = [];
    if (loc) parts.push(`Location: ${loc}`);
    if (present.length) parts.push(`Present: ${present.join(', ')}`);
    if (goals.length) parts.push(`Goal: ${goals.join('; ')}`);
    if (beats.length) parts.push(`Recently: ${beats.join('; ')}`);

    let block = `[Scene] ${parts.join(' | ')}`;

    // Hard cap: approximate tokens at 4 chars/token. Truncate the body defensively,
    // never letting the scene block exceed the budget (clip mid-string + ellipsis).
    const charBudget = Math.max(40, Math.floor((Number(maxTokens) || 150) * 4));
    if (block.length > charBudget) {
        block = block.slice(0, charBudget - 1).trimEnd() + '…';
    }
    return block;
}

/**
 * Build the optional "Big Picture" overview block (top of the summary pyramid + the relevant
 * shelf summaries) — the cheap zoom-out the Writer anchors on before reading individual facts.
 * DEFAULT-OFF feature: only called when `enableSummaryPyramid` is on (gated by the caller).
 *
 * RELEVANCE: rather than dump ALL shelf summaries (which would defeat the purpose on a huge
 * store), we include only the shelves whose (category, aspect) bucket touches the CURRENT
 * scene focus — derived from the scene's location/present/goals/beats text. The whole-story
 * summary is always included (it's the single cheapest big-picture line). Hard token-capped via
 * the same char-budget truncation style as buildSceneBlock so it can never balloon the prompt.
 *
 * @param {{story?:string, shelves?:Object<string,{text:string}>}|null} pyramid - stored pyramid
 * @param {object|null} scene - current scene card ({ location, present[], goals[], beats[] })
 * @param {number} [maxTokens=250] - approximate hard cap (1 token ≈ 4 chars heuristic)
 * @returns {{block:string, shelvesIncluded:string[]}} block text ('' when nothing usable) + which shelf keys were included
 */
export function buildBigPictureBlock(pyramid, scene, maxTokens = 250) {
    if (!pyramid || typeof pyramid !== 'object') return { block: '', shelvesIncluded: [] };
    const story = typeof pyramid.story === 'string' ? pyramid.story.trim() : '';
    const shelves = (pyramid.shelves && typeof pyramid.shelves === 'object') ? pyramid.shelves : {};

    // Build a lowercased relevance haystack from the current scene focus.
    const sceneTokens = new Set();
    if (scene && typeof scene === 'object') {
        const collect = (v) => {
            if (typeof v === 'string') {
                for (const tok of v.toLowerCase().split(/[^a-z0-9]+/)) { if (tok.length >= 3) sceneTokens.add(tok); }
            } else if (Array.isArray(v)) { for (const x of v) collect(x); }
        };
        collect(scene.location); collect(scene.present); collect(scene.goals); collect(scene.beats);
    }

    // Pick relevant shelves: a shelf is relevant if its aspect token OR its summary text
    // overlaps the scene tokens. When there is NO scene focus at all, include none (the
    // story line alone is the overview) to keep the block small.
    const picked = [];
    for (const [bucketKey, entry] of Object.entries(shelves)) {
        const text = (entry && typeof entry.text === 'string') ? entry.text.trim() : '';
        if (!text) continue;
        const aspect = bucketKey.includes('||') ? bucketKey.split('||')[1] : bucketKey;
        let relevant = false;
        if (sceneTokens.size) {
            if (sceneTokens.has(aspect)) relevant = true;
            if (!relevant) {
                for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
                    if (tok.length >= 4 && sceneTokens.has(tok)) { relevant = true; break; }
                }
            }
        }
        if (relevant) picked.push({ bucketKey, aspect, text });
    }

    if (!story && picked.length === 0) return { block: '', shelvesIncluded: [] };

    const lines = ['[Big Picture]'];
    if (story) lines.push(`Story so far: ${story}`);
    for (const p of picked) {
        // Pretty Category/aspect label from the bucketKey.
        const [cat, asp] = p.bucketKey.includes('||') ? p.bucketKey.split('||') : ['', p.bucketKey];
        const label = cat ? `${cat.charAt(0).toUpperCase()}${cat.slice(1)}/${asp}` : asp;
        lines.push(`- ${label}: ${p.text}`);
    }
    let block = lines.join('\n');

    // Hard cap (same heuristic + truncation style as buildSceneBlock): clip mid-string.
    const charBudget = Math.max(80, Math.floor((Number(maxTokens) || 250) * 4));
    if (block.length > charBudget) {
        block = block.slice(0, charBudget - 1).trimEnd() + '…';
    }
    return { block, shelvesIncluded: picked.map(p => p.bucketKey) };
}

/**
 * Build the fact injection block that gets inserted into the prompt
 * This doesn't call an LLM - it prepares context for the main generation
 * @param {string} draft - Draft from Agent 1
 * @param {string} factsFormatted - Formatted facts from retrieval
 * @param {string} [sceneBlock] - Optional compact scene block to prepend ABOVE facts
 * @returns {string} Injection text to add to the prompt
 */
export function buildWriterInjection(draft, factsFormatted, sceneBlock = '') {
    const settings = getSettingsSafe();

    const template = settings?.writerFormat || DEFAULT_WRITER_FORMAT;
    const factsText = (factsFormatted && factsFormatted !== '(No stored facts available)') ? factsFormatted : '(none available)';
    const draftText = draft || '(no direction)';

    // Single-pass regex substitution: avoids order-dependent re-substitution
    // (e.g. factsText containing literal "{draft}" can't get re-replaced)
    const vars = { facts: factsText, draft: draftText };
    let rendered = template.replace(/\{(facts|draft)\}/g, (_, key) => vars[key]);

    // Safety guard: if {facts} / {draft} placeholders missing from template, append.
    const missing = [];
    if (!template.includes('{facts}')) missing.push(`#Established Facts:\n${factsText}`);
    if (!template.includes('{draft}')) missing.push(`#Scene Direction:\n${draftText}`);
    if (missing.length > 0) {
        rendered = `${rendered}\n\n${missing.join('\n\n')}`;
    }

    // Scene card goes ABOVE the fact list: it's the present-moment core context the
    // writer should anchor on before reading individual facts. One combined message.
    if (sceneBlock && sceneBlock.trim()) {
        rendered = `${sceneBlock.trim()}\n\n${rendered}`;
    }

    return rendered;
}

/**
 * Best-effort fire-and-forget debug log from the synchronous injection seam. settings.js is
 * imported lazily to dodge the agent-writer <-> settings import cycle; we do NOT await (this seam
 * runs inside ST's synchronous CHAT_COMPLETION_PROMPT_READY handler and must return its boolean
 * immediately). Logging must never break injection — all errors are swallowed.
 * @param {string} level
 * @param {string} message
 * @param {object} [opts]
 */
function writerLog(level, message, opts = {}) {
    import('./settings.js')
        .then(({ addDebugLog }) => { try { addDebugLog(level, message, opts); } catch { /* never throw */ } })
        .catch(() => { /* settings unavailable — logging is non-essential */ });
}

/**
 * Inject the memory context into the chat completion prompt
 * Called via CHAT_COMPLETION_PROMPT_READY event
 * @param {object} data - Prompt data from ST event
 * @param {string} injection - The memory injection text
 * @param {object} [options]
 * @param {number} [options.trimToLast=0] - If > 0, trim the chat history to the last N
 *   user/assistant messages BEFORE injecting (preserves any system prefix). Lets the
 *   main model see only a focused window — relies on stored facts to fill the gap.
 * @returns {boolean} True if injection succeeded
 */
export function injectMemoryContext(data, injection, options = {}) {
    if (!injection) return false;
    const trimToLast = Math.max(0, options.trimToLast || 0);

    // Try the known message-array container shapes IN ORDER. Different ST builds deliver the
    // CHAT_COMPLETION_PROMPT_READY array under different property names; we try each so memory
    // reaches the Writer on more builds than just the documented `data.chat`. The pipeline caller
    // reads `data.chat || data.messages` for its baseline count, so those two are the primary
    // shapes; the rest are defensive fallbacks for builds that nest the array elsewhere.
    const arrCandidate = firstMessageArray(data);
    if (arrCandidate) {
        if (trimToLast > 0) trimChatHistory(arrCandidate, trimToLast);
        return injectIntoMessages(arrCandidate, injection);
    }

    // Text completion format: prompt is a single string, no per-message trimming possible.
    if (data && typeof data.prompt === 'string') {
        data.prompt = injection + '\n\n' + data.prompt;
        return true;
    }

    // FAILURE PATH: no usable prompt container on this ST build. DUMP what was actually received
    // so the next exported Debug log reveals the real container shape (instead of a bare "Failed
    // to inject"). Fire-and-forget — this seam is synchronous and must return its boolean now.
    writerLog('fail', 'injectMemoryContext: no usable prompt container on this event payload', {
        subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
        data: describeInjectPayload(data),
    });
    return false;
}

/**
 * Return the first usable message-ARRAY container on a CHAT_COMPLETION_PROMPT_READY payload,
 * trying the known shapes in order: the documented `data.chat`, then `data.messages`, then a
 * couple of nested fallbacks some ST builds use (`data.prompt` when it is itself an array,
 * `data.chatCompletion`, `data.messageArray`). Returns null when none is an array. Empty arrays
 * ARE returned (a no-op chat is still a valid injection target — injectIntoMessages pushes into
 * it rather than dropping memory on a greeting/first turn).
 * @param {object} data
 * @returns {Array|null}
 */
function firstMessageArray(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [data.chat, data.messages, data.prompt, data.chatCompletion, data.messageArray];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return null;
}

/**
 * Build a compact, non-throwing diagnostic of a CHAT_COMPLETION_PROMPT_READY payload for the
 * fail-level inject log: the keys present on `data` and the type/length of the candidate
 * containers, so a maintainer reading the exported log can see exactly which container shape the
 * user's ST build delivered. Never includes message CONTENT (privacy + log size).
 * @param {*} data
 * @returns {object}
 */
function describeInjectPayload(data) {
    const out = { dataType: typeof data, keys: [] };
    if (!data || typeof data !== 'object') return out;
    try { out.keys = Object.keys(data); } catch { /* exotic object — leave keys empty */ }
    const describe = (v) => {
        if (Array.isArray(v)) return { type: 'array', length: v.length };
        if (typeof v === 'string') return { type: 'string', length: v.length };
        return { type: typeof v };
    };
    out.chat = describe(data.chat);
    out.messages = describe(data.messages);
    out.prompt = describe(data.prompt);
    return out;
}

/**
 * Trim a messages array IN-PLACE to keep at most `keepLast` user/assistant messages.
 * System messages at the start (character card, system prompt) are preserved.
 * Used to hide old chat history from the main model when the user opts into facts-
 * replace-history mode.
 */
function trimChatHistory(messages, keepLast) {
    // Find where the system-prefix ends and actual chat begins
    let chatStart = 0;
    while (chatStart < messages.length && messages[chatStart]?.role === 'system') {
        chatStart++;
    }
    const chatLen = messages.length - chatStart;
    if (chatLen > keepLast) {
        const removeCount = chatLen - keepLast;
        messages.splice(chatStart, removeCount);
    }
}

/**
 * Insert memory context as a system message near the end of the messages array
 * Places it before the last user message so the model sees facts before responding
 * @param {Array} messages
 * @param {string} injection
 * @returns {boolean}
 */
function injectIntoMessages(messages, injection) {
    if (!Array.isArray(messages)) return false;

    // Empty messages array (greeting / first turn): a no-op chat is still a valid injection
    // target — PUSH the system message rather than dropping memory by returning false.
    if (messages.length === 0) {
        messages.push({ role: 'system', content: injection });
        console.log('[BFMemory] Memory context injected into empty prompt');
        return true;
    }

    // Find the last user message
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            lastUserIdx = i;
            break;
        }
    }

    if (lastUserIdx === -1) {
        // No user message found, insert at end
        messages.push({ role: 'system', content: injection });
    } else {
        // Insert before the last user message
        messages.splice(lastUserIdx, 0, { role: 'system', content: injection });
    }

    console.log('[BFMemory] Memory context injected into prompt');
    return true;
}

// =============================================================================
// WRITER RECALL TOOL — optional `search_memory` function-tool (pull-detail / "infinite reach")
// =============================================================================
//
// The pipeline PUSHES a compact gist of the most-salient facts into the Writer's prompt every
// turn. This tool is the PULL half: when the Writer (the MAIN model) needs a fact that was NOT
// pushed, it calls search_memory to fetch it on demand. SillyTavern's tool-calling loop only
// runs on the MAIN generation path (not the background/quiet agent paths), so the Writer is the
// only legitimate place to expose a tool.
//
// Gated behind the default-OFF `enableWriterRecallTool` setting. READ-ONLY + DETERMINISTIC +
// ZERO-API: the action delegates to searchMemoryForRecall (fact-retrieval.js), which reuses the
// exact same retrieval/visibility/ranking/format machinery as the push path. Registration is
// idempotent (guarded by _recallToolRegistered); unregistered cleanly when toggled off.
//
// IMPORTS are LAZY (dynamic import inside the action / logging helpers) to avoid a static import
// cycle — settings.js statically imports DEFAULT_WRITER_FORMAT from THIS module.
// =============================================================================

const RECALL_TOOL_NAME = 'search_memory';
// Module-level guard so register/unregister stay idempotent across init + toggle re-runs.
let _recallToolRegistered = false;
let _recallToolApiUnavailableLogged = false; // fail-level "API missing" notice fires once

/**
 * Best-effort debug log that never throws (settings.js is imported lazily to dodge the
 * agent-writer <-> settings import cycle). A runId may not exist inside ST's generation loop —
 * we log without one; absence is never an error.
 * @param {string} level
 * @param {string} message
 * @param {object} [opts]
 */
async function recallToolLog(level, message, opts = {}) {
    try {
        const { addDebugLog } = await import('./settings.js');
        addDebugLog(level, message, opts);
    } catch { /* logging must never break the tool */ }
}

/**
 * Feature-detect SillyTavern's function-tool API. Centralized in the host seam
 * (host.js) so all host coupling lives in one place; this is a behavior-identical
 * passthrough. Returns the resolved { register, unregister } functions, or null when
 * neither exists (caller logs a single fail-level notice and no-ops — NEVER throws).
 * @returns {{register: Function, unregister: Function|null}|null}
 */
function getToolApi() {
    return host.getToolApi();
}

/**
 * Read the enableWriterRecallTool setting (lazily, cycle-safe). Default OFF.
 * @returns {boolean}
 */
function recallToolEnabled() {
    const s = getSettingsSafe();
    return !!(s && s.enableWriterRecallTool === true);
}

/**
 * The tool action: search long-term memory for facts not already in the Writer's context.
 * READ-ONLY, deterministic, zero-API. Returns a STRING (the ST tool contract). Logs each
 * invocation at debug level with query/category/result-count metadata (NOT full fact bodies).
 * Never throws — returns a safe error string on any failure.
 * @param {{query?: string, category?: string, limit?: number, scene?: (number|string), with?: string}} args
 * @returns {Promise<string>}
 */
async function searchMemoryAction({ query, category, limit, scene, with: withPair } = {}) {
    try {
        const { searchMemoryForRecall } = await import('./fact-retrieval.js');
        const { text, count } = await searchMemoryForRecall({ query, category, limit, scene, with: withPair });
        await recallToolLog('debug', `Writer recall: search_memory "${String(query ?? '').slice(0, 80)}" → ${count} fact(s)`, {
            subsystem: 'writer', event: 'tool.search_memory',
            data: { query: String(query ?? '').slice(0, 120), category: category || null, with: withPair ? String(withPair).slice(0, 80) : null, resultCount: count },
        });
        return text;
    } catch (e) {
        await recallToolLog('fail', `Writer recall: search_memory failed — ${e?.message || e}`, {
            subsystem: 'writer', event: 'tool.search_memory', reason: 'RECALL_ERROR',
        });
        return 'Memory search failed.';
    }
}

/**
 * Register the optional `search_memory` Writer recall tool. Idempotent (guarded by
 * _recallToolRegistered). No-op + single fail-level log when the ST tool API is unavailable.
 * Never throws. Call on init (when enabled) and whenever the setting is toggled on.
 */
export function registerWriterRecallTool() {
    if (_recallToolRegistered) return;
    const api = getToolApi();
    if (!api) {
        if (!_recallToolApiUnavailableLogged) {
            _recallToolApiUnavailableLogged = true;
            void recallToolLog('fail', 'Writer recall: SillyTavern function-tool API unavailable — search_memory not registered', {
                subsystem: 'writer', event: 'tool.unregistered', reason: 'TOOL_API_UNAVAILABLE',
            });
        }
        return;
    }
    try {
        api.register({
            name: RECALL_TOOL_NAME,
            displayName: 'Search Memory',
            description: 'Search long-term memory for stored facts that are NOT already in your context. '
                + 'Pass a keyword query; optionally narrow by category, or pass an exact "Category/key" handle '
                + '(as shown in the established-facts list) to pull that full record. To RECAP a whole scene, '
                + 'pass the scene number or name in "scene" (or just ask in the query, e.g. "recap the drugged-bar '
                + 'scene") — a scene recap returns the full scene including older/superseded details. '
                + 'When THIS moment is an emotional callback or turning point between two characters (a confession, '
                + 'a betrayal resurfacing, a reunion), recall their shared history by passing both names in "with" '
                + '(e.g. "<name> and <other>") — this returns the pair\'s significant moments across all scenes, in order. '
                + 'Read-only.',
            parameters: {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Keyword(s) to search for, an exact "Category/key" handle to pull one record, '
                            + 'or a scene-recap phrase like "recap the drugged-bar scene" / "what happened in scene 3".',
                    },
                    category: {
                        type: 'string',
                        description: 'Optional category to restrict the search to (e.g. People, Places, Events).',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Optional max number of facts to return (default 20).',
                    },
                    scene: {
                        type: 'string',
                        description: 'Optional scene to RECAP: a scene number (e.g. "3") or scene name (e.g. "the drugged bar"). '
                            + 'Returns that scene\'s full set of facts, including older/superseded details. Takes precedence over the keyword query.',
                    },
                    with: {
                        type: 'string',
                        description: 'Optional relationship recall: two character names (e.g. "<name> and <other>", or comma-separated) '
                            + 'to pull the PAIR\'s emotional history — their significant moments (confessions, betrayals, reunions) across '
                            + 'all scenes, in chronological order, including older/superseded details. Use it when the present beat echoes '
                            + 'a turning point between two characters. One name returns that character\'s own significant moments. '
                            + 'Takes precedence over the keyword query (the "scene" arg wins over this).',
                    },
                },
                required: ['query'],
            },
            action: searchMemoryAction,
            formatMessage: ({ query } = {}) => `Searching memory for "${String(query ?? '').slice(0, 80)}"…`,
            shouldRegister: () => recallToolEnabled(),
            stealth: false,
        });
        _recallToolRegistered = true;
        void recallToolLog('info', 'Writer recall: search_memory tool registered', {
            subsystem: 'writer', event: 'tool.registered',
        });
    } catch (e) {
        void recallToolLog('fail', `Writer recall: failed to register search_memory — ${e?.message || e}`, {
            subsystem: 'writer', event: 'tool.unregistered', reason: 'REGISTER_FAILED',
        });
    }
}

/**
 * Unregister the `search_memory` tool. Idempotent. If ST exposes no unregister fn we rely on
 * the tool's own shouldRegister() returning false to keep it inert. Never throws.
 */
export function unregisterWriterRecallTool() {
    if (!_recallToolRegistered) return;
    const api = getToolApi();
    try {
        if (api && typeof api.unregister === 'function') {
            api.unregister(RECALL_TOOL_NAME);
        }
        // Whether or not an unregister fn exists, drop our guard: shouldRegister() (which reads
        // the now-off setting) keeps the tool inert even if it lingers in ST's registry.
        _recallToolRegistered = false;
        void recallToolLog('info', 'Writer recall: search_memory tool unregistered', {
            subsystem: 'writer', event: 'tool.unregistered',
        });
    } catch (e) {
        void recallToolLog('fail', `Writer recall: failed to unregister search_memory — ${e?.message || e}`, {
            subsystem: 'writer', event: 'tool.unregistered', reason: 'UNREGISTER_FAILED',
        });
    }
}

/**
 * Sync the recall tool's registration to the current setting. Register when enabled, unregister
 * when not. Safe to call on init and on every settings change. Never throws.
 */
export function syncWriterRecallTool() {
    if (recallToolEnabled()) registerWriterRecallTool();
    else unregisterWriterRecallTool();
}
