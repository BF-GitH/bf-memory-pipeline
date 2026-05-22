// BF Memory Pipeline - Settings Module
// Handles UI, settings persistence, and debug logging

import { getConnectionProfiles, getCurrentProfileId } from './profiler.js';
import { DEFAULT_DRAFT_PROMPT } from './agent-draft.js';
import { DEFAULT_MEMORY_PROMPT } from './agent-memory.js';
import { DEFAULT_WRITER_FORMAT } from './agent-writer.js';

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
let debugLog = [];
const MAX_DEBUG_ENTRIES = 200;
let lastGenerated = { runId: null, timestamp: null, updates: [] };
let lastInserted = { runId: null, timestamp: null, updates: [] };
let lastRunTokens = null; // {baselineInput, actualInput, agent1Input, agent1Output, agent3Input, agent3Output, mainOutput, ts, approx}
let sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };

const DEFAULT_SETTINGS = {
    enabled: false,
    useMemoryProfile: true,
    // Per-agent connection profiles (replacing single memoryProfile).
    // Old `memoryProfile` is kept on the stored object for rollback safety
    // and migrated forward in migrateLegacySettings().
    agent1Profile: '',
    agent3Profile: '',
    // Per-agent context message counts (replacing single contextMessages).
    // Agent 3 default = 2 preserves the prior behavior of looking at the
    // latest user + AI exchange.
    agent1ContextMessages: 5,
    agent3ContextMessages: 2,
    // Agent 2 (Writer) context limit: default 0 = off (main model sees full chat as ST
    // sends it). When > 0, we trim data.chat IN-PLACE to the last N user/AI messages
    // before sending — the main model sees only those + our injected facts. Lets you
    // shrink the prompt and rely on facts to replace older history. Reversible: just
    // change the slider back to 0.
    agent2ContextMessages: 0,
    reviewInterval: 10,
    secondaryChance: 50,
    tertiaryChance: 15,
    showToast: true,
    debugMode: false,
    draftPrompt: '',
    memoryPrompt: '',
    writerFormat: '',
    dbProfiles: {},
    activeDbProfile: '',
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
    s.agent3ContextMessages = Math.floor(clamp(s.agent3ContextMessages, 1, 20, 2));
    s.agent2ContextMessages = Math.floor(clamp(s.agent2ContextMessages, 0, 50, 0));
    s.reviewInterval  = Math.floor(clamp(s.reviewInterval,  3, 100, 10));
    s.secondaryChance = Math.floor(clamp(s.secondaryChance, 0, 100, 50));
    s.tertiaryChance  = Math.floor(clamp(s.tertiaryChance,  0, 100, 15));
    if (typeof s.enabled !== 'boolean')          s.enabled = false;
    if (typeof s.useMemoryProfile !== 'boolean') s.useMemoryProfile = true;
    if (typeof s.showToast !== 'boolean')        s.showToast = true;
    if (typeof s.debugMode !== 'boolean')        s.debugMode = false;
    if (typeof s.memoryProfile !== 'string')     s.memoryProfile = '';
    if (typeof s.agent1Profile !== 'string')     s.agent1Profile = '';
    if (typeof s.agent3Profile !== 'string')     s.agent3Profile = '';
    if (typeof s.draftPrompt !== 'string')       s.draftPrompt = '';
    if (typeof s.memoryPrompt !== 'string')      s.memoryPrompt = '';
    if (typeof s.writerFormat !== 'string')      s.writerFormat = '';
    if (typeof s.activeDbProfile !== 'string')   s.activeDbProfile = '';
    if (!s.dbProfiles || typeof s.dbProfiles !== 'object' || Array.isArray(s.dbProfiles)) {
        s.dbProfiles = {};
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
        text.textContent = extensionSettings?.enabled
            ? `Active${extensionSettings.useMemoryProfile ? ' (separate profile)' : ''}`
            : 'Disabled';
    }
}

// --- Debug Log (persistent — stored in chat_metadata.bf_mem_log so it survives page reload) ---

const LOG_META_KEY = 'bf_mem_log';

function loadDebugLogFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return [];
        const stored = md[LOG_META_KEY];
        // Shape-check: must be array of {type, message, timestamp}
        if (!Array.isArray(stored)) return [];
        return stored.filter(e => e && typeof e === 'object' && typeof e.message === 'string');
    } catch { return []; }
}

function saveDebugLogToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return; // no chat loaded — log lives in-memory only until a chat opens
        md[LOG_META_KEY] = debugLog.slice(0, MAX_DEBUG_ENTRIES);
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/** Re-load the debug log from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadDebugLogFromChat() {
    debugLog = loadDebugLogFromMeta();
    renderDebugLog();
}

export function addDebugLog(type, message) {
    const timestamp = new Date().toLocaleTimeString();
    debugLog.unshift({ type, message, timestamp });
    if (debugLog.length > MAX_DEBUG_ENTRIES) debugLog = debugLog.slice(0, MAX_DEBUG_ENTRIES);

    saveDebugLogToMeta(); // persist to chat_metadata so logs survive page reload
    renderDebugLog();

    if (extensionSettings?.debugMode) {
        const prefix = type === 'pass' ? '[PASS]' : type === 'fail' ? '[FAIL]' : '[INFO]';
        console.log(`[BFMemory] ${prefix} ${message}`);
    }
}

function renderDebugLog() {
    const container = document.getElementById('bf_mem_debug_log');
    if (!container) return;

    container.innerHTML = debugLog.map(entry => `
        <div class="bf-mem-debug-entry ${entry.type}">
            <span class="bf-mem-log-time">[${entry.timestamp}]</span> ${escapeHtml(entry.message).replace(/\n/g, '<br>')}
        </div>
    `).join('');
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
        emptyMsg: 'No pipeline runs yet. Send a message to see what Agent 3 extracts.',
        zeroMsg: 'Last run extracted 0 facts (Agent 3 found nothing worth storing).',
    });
}

function renderInserted() {
    renderFactList('bf_mem_inserted_list', lastInserted, {
        emptyMsg: 'No pipeline runs yet.',
        zeroMsg: 'Nothing to insert (Agent 3 returned no facts, or run was cancelled).',
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
    lastRunTokens = { ...run, ts: Date.now(), approx: true };
    // accumulate session
    sessionTokens.baselineInput += run.baselineInput || 0;
    sessionTokens.actualInput   += run.actualInput || 0;
    sessionTokens.agentInput    += (run.agent1Input || 0) + (run.agent3Input || 0);
    sessionTokens.agentOutput   += (run.agent1Output || 0) + (run.agent3Output || 0);
    sessionTokens.runs          += 1;
    saveTokensToMeta();
    renderTokens();
}

// Called by pipeline.js MESSAGE_RECEIVED handler when the main reply lands.
export function setMainOutputTokens(n) {
    if (lastRunTokens) lastRunTokens.mainOutput = n || 0;
    sessionTokens.mainOutput += n || 0;
    saveTokensToMeta();
    renderTokens();
}

export function reloadTokensFromChat() {
    lastRunTokens = null;
    sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
    loadTokensFromMeta();
    renderTokens();
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
            ? 'Agent 2 trim is OFF — the main model sees the full chat, so there are no input savings. The agent calls below are pure overhead (the tradeoff for memory recall). Turn on "Agent 2 Context Limit" in the Pipeline tab to save input tokens.'
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
                <tr><td>— Agent 1 (Draft)</td><td>${fmt(L.agent1Input)}</td><td>${fmt(L.agent1Output)}</td></tr>
                <tr><td>— Agent 3 (Memory)</td><td>${fmt(L.agent3Input)}</td><td>${fmt(L.agent3Output)}</td></tr>
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
    return header + logText;
}

// --- Profile Dropdown ---

function reloadProfiles() {
    const agent1Select = document.getElementById('bf_mem_agent1_profile');
    const agent3Select = document.getElementById('bf_mem_agent3_profile');
    if (!agent1Select && !agent3Select) return;

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

async function refreshDatabaseView() {
    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();
    const categories = Object.keys(databases);

    const statsEl = document.getElementById('bf_mem_db_stats');
    const listEl = document.getElementById('bf_mem_db_list');

    if (!statsEl || !listEl) return;

    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    statsEl.innerHTML = `<b>${categories.length}</b> databases | <b>${totalFacts}</b> total facts`;

    if (categories.length === 0) {
        listEl.innerHTML = '<div class="bf-mem-empty">No databases yet. They will be created as you chat.</div>';
        return;
    }

    listEl.innerHTML = categories.map(cat => {
        const db = databases[cat];
        const factCount = db.facts.length;
        const knowers = [...new Set(db.facts.flatMap(f => f.knownBy || []))];
        return `
            <div class="bf-mem-db-card" data-category="${escapeHtml(cat)}">
                <div class="bf-mem-db-card-header">
                    <span class="bf-mem-db-card-name">${escapeHtml(cat)}</span>
                    <span class="bf-mem-db-card-count">${factCount}/50</span>
                </div>
                <div class="bf-mem-db-card-meta">
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
            if (!confirm(`Delete database "${btn.dataset.category}"?`)) return;
            const { deleteDatabase } = await import('./database.js');
            await deleteDatabase(btn.dataset.category);
            toastr.success(`Database "${btn.dataset.category}" deleted`, 'BF Memory');
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

    // Load profile databases
    for (const [category, db] of Object.entries(profile.databases || {})) {
        await saveDatabase({ ...db, category });
    }

    extensionSettings.activeDbProfile = profileName;
    saveSettings();
    refreshDbProfileDropdown();
    refreshDatabaseView();
    toastr.success(`Loaded profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile loaded: "${profileName}"`);
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

/** Save current databases to the active profile (call after DB changes) */
export async function saveCurrentToActiveProfile(profileKey = null) {
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
        if (totalFacts === 0) return;

        extensionSettings.dbProfiles[profileName] = {
            ...extensionSettings.dbProfiles[profileName],
            databases: JSON.parse(JSON.stringify(databases)),
            savedAt: Date.now(),
        };
        saveSettings();
        addDebugLog('info', `Saved to active profile "${profileName}" (${totalFacts} facts)`);
    } catch (err) {
        addDebugLog('fail', `Failed to save active profile: ${err.message}`);
    }
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

    let processed = 0, skipped = 0, factsAdded = 0;
    const total = chat.length;

    for (let i = 0; i < chat.length; i++) {
        if (shouldCancel?.()) {
            addDebugLog('info', `Full-chat extraction cancelled at message ${i}/${total}`);
            break;
        }
        const msg = chat[i];
        if (!msg || !msg.mes) { skipped++; continue; }
        if (msg.is_system) { skipped++; continue; }
        if (msg.extra?.type) { skipped++; continue; }
        if (skipAlreadyProcessed && msg.extra?.bf_mem_processed) { skipped++; continue; }

        try {
            const databases = await getAllDatabases();
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
            msg.extra = { ...(msg.extra || {}), bf_mem_processed: true };
            processed++;
            onProgress?.({ current: i + 1, total, factsAdded });
            addDebugLog('info', `Full-chat: msg ${i + 1}/${total} → +${n} facts`);
        } catch (err) {
            addDebugLog('fail', `Full-chat: msg ${i + 1} failed: ${err.message || err}`);
        }
    }

    // Persist chat (the extra.bf_mem_processed flags) + active DB profile
    ctx.saveChatDebounced?.();
    await saveCurrentToActiveProfile();

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
                extensionSettings.dbProfiles[chatLabel] = {
                    databases: {},
                    savedAt: Date.now(),
                    linkedChats: [chatId],
                };
                addDebugLog('info', `Auto-created DB profile "${chatLabel}" for chat ${chatId}`);
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

            // Load saved
            for (const [category, db] of Object.entries(profile.databases || {})) {
                await saveDatabase({ ...db, category });
            }

            extensionSettings.activeDbProfile = profileToLoad;
            saveSettings();
            refreshDbProfileDropdown();
            refreshLinkedChatsField();
            addDebugLog('info', `Auto-loaded DB profile "${profileToLoad}" (linked to chat ${chatId})`);
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
    try {
        const current = context.extensionSettings[EXTENSION_NAME];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
    } catch (err) {
        console.error('[BFMemory] corrupt settings, resetting:', err);
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
        extensionSettings.enabled = $(this).prop('checked');
        updateStatus('idle');
        saveSettings();
    });

    $('#bf_mem_use_profile').prop('checked', extensionSettings.useMemoryProfile).on('change', function () {
        extensionSettings.useMemoryProfile = $(this).prop('checked');
        // Note: profile dropdowns now live in the per-agent tabs (always visible).
        // This flag still gates whether the agents USE those profiles
        // (see getAgent1ProfileId / getAgent3ProfileId in profiler.js).
        saveSettings();
    });

    reloadProfiles();
    $('#bf_mem_agent1_profile').val(extensionSettings.agent1Profile || '').on('change', function () {
        extensionSettings.agent1Profile = $(this).val() || '';
        saveSettings();
    });
    $('#bf_mem_agent3_profile').val(extensionSettings.agent3Profile || '').on('change', function () {
        extensionSettings.agent3Profile = $(this).val() || '';
        saveSettings();
    });

    $('#bf_mem_refresh_profiles').on('click', () => {
        reloadProfiles();
        toastr.info('Profiles refreshed', 'BF Memory');
    });

    // Agent 1 context slider
    $('#bf_mem_agent1_context').val(extensionSettings.agent1ContextMessages);
    $('#bf_mem_agent1_context_val').text(extensionSettings.agent1ContextMessages);
    $('#bf_mem_agent1_context').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.agent1ContextMessages = val;
        $('#bf_mem_agent1_context_val').text(val);
        saveSettings();
    });

    // Agent 3 context slider
    $('#bf_mem_agent3_context').val(extensionSettings.agent3ContextMessages);
    $('#bf_mem_agent3_context_val').text(extensionSettings.agent3ContextMessages);
    $('#bf_mem_agent3_context').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.agent3ContextMessages = val;
        $('#bf_mem_agent3_context_val').text(val);
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

    // Review interval slider
    $('#bf_mem_review_interval').val(extensionSettings.reviewInterval);
    $('#bf_mem_review_val').text(extensionSettings.reviewInterval);
    $('#bf_mem_review_interval').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.reviewInterval = val;
        $('#bf_mem_review_val').text(val);
        saveSettings();
    });

    // Secondary chance
    $('#bf_mem_secondary').val(extensionSettings.secondaryChance);
    $('#bf_mem_secondary_val').text(`${extensionSettings.secondaryChance}%`);
    $('#bf_mem_secondary').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.secondaryChance = val;
        $('#bf_mem_secondary_val').text(`${val}%`);
        saveSettings();
    });

    // Tertiary chance
    $('#bf_mem_tertiary').val(extensionSettings.tertiaryChance);
    $('#bf_mem_tertiary_val').text(`${extensionSettings.tertiaryChance}%`);
    $('#bf_mem_tertiary').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.tertiaryChance = val;
        $('#bf_mem_tertiary_val').text(`${val}%`);
        saveSettings();
    });

    // Toast
    $('#bf_mem_toast').prop('checked', extensionSettings.showToast).on('change', function () {
        extensionSettings.showToast = $(this).prop('checked');
        saveSettings();
    });

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
        saveSettings();
        toastr.info('Draft prompt reset', 'BF Memory');
    });

    $('#bf_mem_reset_memory_prompt').on('click', () => {
        extensionSettings.memoryPrompt = '';
        $('#bf_mem_memory_prompt').val(DEFAULT_MEMORY_PROMPT);
        saveSettings();
        toastr.info('Memory prompt reset', 'BF Memory');
    });

    $('#bf_mem_reset_writer_format').on('click', () => {
        extensionSettings.writerFormat = '';
        $('#bf_mem_writer_format').val(DEFAULT_WRITER_FORMAT);
        saveSettings();
        toastr.info('Writer format reset', 'BF Memory');
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
        toastr.success('Databases exported', 'BF Memory');
    });

    $('#bf_mem_clear_db').on('click', async () => {
        if (!confirm('Clear ALL memory databases for this character? This cannot be undone.')) return;
        const { getAllDatabases, deleteDatabase } = await import('./database.js');
        const dbs = await getAllDatabases();
        for (const category of Object.keys(dbs)) {
            await deleteDatabase(category);
        }
        addDebugLog('info', 'All databases cleared');
        toastr.success('All databases cleared', 'BF Memory');
        refreshDatabaseView();
    });

    // --- Run Agent 3 on full chat (retroactive extraction) ---
    let fullChatCancel = false;
    $('#bf_mem_run_full_chat').on('click', async () => {
        if (!confirm('Run Agent 3 on every message in this chat? This can be slow and costs LLM tokens per message.')) return;
        const btn = $('#bf_mem_run_full_chat');
        const progress = $('#bf_mem_full_chat_progress');
        const cancelBtn = $('#bf_mem_run_full_chat_cancel');
        const skipDone = $('#bf_mem_skip_processed').is(':checked');

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
            btn.prop('disabled', false).text('Run Agent 3 on full chat');
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

    $('#bf_mem_clear_log').on('click', () => {
        debugLog = [];
        saveDebugLogToMeta(); // also clear the persistent copy
        renderDebugLog();
    });

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
        await autoSaveDbProfile();
        // Reload the persistent debug log AND fact panels from the new chat's metadata
        // so each chat shows its own history (not a stale cross-chat snapshot).
        reloadDebugLogFromChat();
        reloadFactsFromChat();
        reloadTokensFromChat();
    });

    // Initial load: pull any previously-persisted log entries + facts for the current chat
    reloadDebugLogFromChat();
    reloadFactsFromChat();
    reloadTokensFromChat();

    // Save to active profile on page close/refresh
    window.addEventListener('beforeunload', () => {
        // Synchronous best-effort save to settings (no async file ops)
        const profileName = extensionSettings?.activeDbProfile;
        if (profileName && extensionSettings?.dbProfiles?.[profileName]) {
            // Can't do async here, but saveSettings is synchronous (debounced flush)
            saveSettings();
        }
    });

    // Note: removed MESSAGE_RECEIVED → saveCurrentToActiveProfile() handler.
    // pipeline.js now persists via saveCurrentToActiveProfile(capturedDbProfile)
    // after every Agent 3 write, with capture-at-write semantics. The old
    // unprotected handler here was a residual leak path (same class as Issue #2).

    // --- Initial state ---
    updateStatus('idle');

    console.log('[BFMemory] Settings initialized');
}
