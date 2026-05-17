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
let lastPipelineSummary = null;

const DEFAULT_SETTINGS = {
    enabled: false,
    useMemoryProfile: true,
    memoryProfile: '',
    contextMessages: 5,
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
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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

// --- Debug Log ---

export function addDebugLog(type, message) {
    const timestamp = new Date().toLocaleTimeString();
    debugLog.unshift({ type, message, timestamp });
    if (debugLog.length > MAX_DEBUG_ENTRIES) debugLog = debugLog.slice(0, MAX_DEBUG_ENTRIES);

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

// --- Pipeline Summary (Debug Light) ---

export function updatePipelineSummary(summary) {
    lastPipelineSummary = summary;
    renderSummary();
}

function renderSummary() {
    const container = document.getElementById('bf_mem_summary');
    if (!container) return;

    if (!lastPipelineSummary) {
        container.innerHTML = '<div class="bf-mem-summary-empty">No pipeline runs yet. Send a message to see the workflow summary.</div>';
        return;
    }

    const s = lastPipelineSummary;
    const lines = [];

    lines.push(`### Pipeline Run`);
    lines.push(`**Time:** ${s.timestamp} | **Duration:** ${s.durationMs}ms`);
    lines.push('');

    // Agent 1
    lines.push(`#### Agent 1 — Draft`);
    if (s.agent1Error) {
        lines.push(`- Status: **FAILED** (${s.agent1Error})`);
    } else {
        lines.push(`- Status: **OK**`);
        lines.push(`- Draft: *${s.draftSnippet || '(empty)'}*`);
        lines.push(`- Needed facts: ${s.neededFacts?.length ? s.neededFacts.join(', ') : '(none)'}`);
    }
    lines.push('');

    // Agent 3
    lines.push(`#### Agent 3 — Memory`);
    if (s.agent3Skipped) {
        lines.push(`- Status: **Skipped** (no new message to process)`);
    } else if (s.agent3Error) {
        lines.push(`- Status: **FAILED** (${s.agent3Error})`);
    } else {
        lines.push(`- Status: **OK** — ${s.memoryUpdates} update(s)`);
        if (s.memorySummary) lines.push(`- Summary: ${s.memorySummary}`);
    }
    lines.push('');

    // Retrieval
    lines.push(`#### Fact Retrieval`);
    lines.push(`- Primary: **${s.stats?.primary || 0}** | Secondary: **${s.stats?.secondary || 0}** | Tertiary: **${s.stats?.tertiary || 0}**`);
    if (s.contextKeywords?.length) lines.push(`- Context keywords: ${s.contextKeywords.join(', ')}`);
    if (s.deltaKeywords?.length) lines.push(`- Delta keywords: ${s.deltaKeywords.join(', ')}`);
    lines.push('');

    // Injection
    lines.push(`#### Injection`);
    lines.push(`- Characters injected: **${s.injectionChars || 0}**`);
    lines.push(`- Status: ${s.injected ? '**Injected**' : '**Failed**'}`);

    // Convert markdown-like to HTML (simple)
    const html = lines.map(line => {
        if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`;
        if (line.startsWith('#### ')) return `<h4>${line.slice(5)}</h4>`;
        if (line.startsWith('- ')) return `<div class="bf-mem-summary-item">${formatInline(line.slice(2))}</div>`;
        if (line === '') return '';
        return `<p>${formatInline(line)}</p>`;
    }).join('\n');

    container.innerHTML = html;
}

function formatInline(text) {
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function exportLogs() {
    const header = `=== BF Memory Pipeline Debug Logs ===\nExported: ${new Date().toISOString()}\nEntries: ${debugLog.length}\n${'='.repeat(40)}\n\n`;
    const logText = debugLog.map(entry => `[${entry.timestamp}] [${entry.type.toUpperCase().padEnd(5)}] ${entry.message}`).join('\n');
    return header + logText;
}

// --- Profile Dropdown ---

function reloadProfiles() {
    const select = document.getElementById('bf_mem_profile');
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">-- Select Memory Profile --</option>';

    const profiles = getConnectionProfiles();
    const activeProfile = getCurrentProfileId();

    profiles.forEach(profile => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name + (profile.id === activeProfile ? ' (current)' : '');
        select.appendChild(option);
    });

    if (currentValue && profiles.find(p => p.id === currentValue)) {
        select.value = currentValue;
    } else if (extensionSettings?.memoryProfile) {
        select.value = extensionSettings.memoryProfile;
    }
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
        option.textContent = `${name} (${dbCount} dbs, ${factCount} facts)`;
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
    extensionSettings.dbProfiles[profileName] = {
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

let lastAutoSavedChat = '';

async function autoSaveDbProfile() {
    try {
        const context = getContext();
        // Get current chat name from ST context
        const chatName = context.characters?.[context.characterId]?.name
            || context.groups?.find(g => g.id === context.groupId)?.name
            || '';

        if (!chatName) return;
        if (chatName === lastAutoSavedChat) return; // same chat, already saved

        // Save previous chat's databases before switching
        if (lastAutoSavedChat) {
            const { getAllDatabases } = await import('./database.js');
            const databases = await getAllDatabases();
            const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);

            // Only save if there are actual facts
            if (totalFacts > 0) {
                if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
                extensionSettings.dbProfiles[lastAutoSavedChat] = {
                    databases: JSON.parse(JSON.stringify(databases)),
                    savedAt: Date.now(),
                };
                extensionSettings.activeDbProfile = lastAutoSavedChat;
                saveSettings();
                refreshDbProfileDropdown();
                addDebugLog('info', `Auto-saved DB profile "${lastAutoSavedChat}" (${totalFacts} facts)`);
            }
        }

        // Load the new chat's profile if it exists
        if (extensionSettings.dbProfiles?.[chatName]) {
            const profile = extensionSettings.dbProfiles[chatName];
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

            extensionSettings.activeDbProfile = chatName;
            saveSettings();
            refreshDbProfileDropdown();
            addDebugLog('info', `Auto-loaded DB profile "${chatName}"`);
        }

        lastAutoSavedChat = chatName;
    } catch (err) {
        addDebugLog('fail', `Auto-save DB profile failed: ${err.message}`);
    }
}

// --- Init ---

export async function initSettings() {
    const context = getContext();

    // Load saved settings
    if (!context.extensionSettings) context.extensionSettings = {};
    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    }
    extensionSettings = context.extensionSettings[EXTENSION_NAME];

    // Merge missing defaults
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extensionSettings[key] === undefined) {
            extensionSettings[key] = value;
        }
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
        $('#bf_mem_profile_section').toggle(extensionSettings.useMemoryProfile);
        saveSettings();
    });
    $('#bf_mem_profile_section').toggle(extensionSettings.useMemoryProfile);

    reloadProfiles();
    $('#bf_mem_profile').val(extensionSettings.memoryProfile || '').on('change', function () {
        extensionSettings.memoryProfile = $(this).val() || '';
        saveSettings();
    });

    $('#bf_mem_refresh_profiles').on('click', () => {
        reloadProfiles();
        toastr.info('Profiles refreshed', 'BF Memory');
    });

    // Context slider
    $('#bf_mem_context').val(extensionSettings.contextMessages);
    $('#bf_mem_context_val').text(extensionSettings.contextMessages);
    $('#bf_mem_context').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.contextMessages = val;
        $('#bf_mem_context_val').text(val);
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
    $('#bf_mem_draft_prompt').val(extensionSettings.draftPrompt || DEFAULT_DRAFT_PROMPT).on('change', function () {
        const val = $(this).val().trim();
        extensionSettings.draftPrompt = (val === DEFAULT_DRAFT_PROMPT) ? '' : val;
        saveSettings();
    });

    $('#bf_mem_memory_prompt').val(extensionSettings.memoryPrompt || DEFAULT_MEMORY_PROMPT).on('change', function () {
        const val = $(this).val().trim();
        extensionSettings.memoryPrompt = (val === DEFAULT_MEMORY_PROMPT) ? '' : val;
        saveSettings();
    });

    $('#bf_mem_writer_format').val(extensionSettings.writerFormat || DEFAULT_WRITER_FORMAT).on('change', function () {
        const val = $(this).val().trim();
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

    // --- Debug Tab ---
    $('#bf_mem_debug').prop('checked', extensionSettings.debugMode).on('change', function () {
        extensionSettings.debugMode = $(this).prop('checked');
        saveSettings();
    });

    $('#bf_mem_clear_log').on('click', () => {
        debugLog = [];
        renderDebugLog();
    });

    $('#bf_mem_copy_log').on('click', async () => {
        const logText = exportLogs();
        try {
            await navigator.clipboard.writeText(logText);
            toastr.success('Logs copied to clipboard', 'BF Memory');
        } catch {
            prompt('Copy logs:', logText);
        }
    });

    // --- Auto-refresh profiles on change ---
    context.eventSource?.on(context.eventTypes?.CONNECTION_PROFILE_LOADED, () => reloadProfiles());

    // --- Auto-save DB profile on chat change (named after current chat) ---
    context.eventSource?.on(context.eventTypes?.CHAT_CHANGED, async () => {
        await autoSaveDbProfile();
    });

    // --- Initial state ---
    updateStatus('idle');

    console.log('[BFMemory] Settings initialized');
}
