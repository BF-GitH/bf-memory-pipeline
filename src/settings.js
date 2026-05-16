// BF Memory Pipeline - Settings Module
// Handles UI, settings persistence, and debug logging

import { getConnectionProfiles, getCurrentProfileId } from './profiler.js';

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
};

function getContext() {
    return SillyTavern.getContext();
}

export function getSettings() {
    return extensionSettings;
}

export function addDebugLog(type, message) {
    const entry = {
        time: new Date().toLocaleTimeString(),
        type,
        message,
    };
    debugLog.push(entry);
    if (debugLog.length > MAX_DEBUG_ENTRIES) debugLog.shift();

    const settings = getSettings();
    if (settings?.debugMode) {
        updateDebugPanel();
    }

    // Also console log
    const prefix = type === 'fail' ? '!' : type === 'pass' ? '+' : '-';
    console.log(`[BFMemory] ${prefix} ${message}`);
}

function updateDebugPanel() {
    const panel = document.getElementById('bf_mem_debug_log');
    if (!panel) return;

    const html = debugLog.slice(-50).reverse().map(entry => {
        const cls = entry.type === 'fail' ? 'bf-mem-log-fail' : entry.type === 'pass' ? 'bf-mem-log-pass' : 'bf-mem-log-info';
        return `<div class="${cls}"><span class="bf-mem-log-time">${entry.time}</span> ${escapeHtml(entry.message)}</div>`;
    }).join('');

    panel.innerHTML = html;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function saveSettings() {
    const context = getContext();
    if (context.extension_settings) {
        context.extension_settings[EXTENSION_NAME] = extensionSettings;
    }
    context.saveSettingsDebounced?.();
}

function buildProfileDropdown(selectedId) {
    const profiles = getConnectionProfiles();
    let options = '<option value="">-- Select Memory Profile --</option>';
    for (const profile of profiles) {
        const selected = profile.id === selectedId ? 'selected' : '';
        const name = profile.name || profile.id;
        options += `<option value="${profile.id}" ${selected}>${name}</option>`;
    }
    return options;
}

export async function initSettings() {
    const context = getContext();

    // Load saved settings
    if (!context.extension_settings) context.extension_settings = {};
    if (!context.extension_settings[EXTENSION_NAME]) {
        context.extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    }
    extensionSettings = context.extension_settings[EXTENSION_NAME];

    // Merge any missing defaults
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extensionSettings[key] === undefined) {
            extensionSettings[key] = value;
        }
    }

    // Build settings UI
    const settingsHtml = `
    <div id="bf_memory_settings" class="bf-mem-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>BF's Memory Pipeline</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <!-- Enable Toggle -->
                <div class="bf-mem-row">
                    <label class="checkbox_label">
                        <input type="checkbox" id="bf_mem_enabled" ${extensionSettings.enabled ? 'checked' : ''} />
                        <span>Enable Memory Pipeline</span>
                    </label>
                </div>

                <!-- Memory Profile -->
                <div class="bf-mem-row">
                    <label>Memory Profile (for Draft + Memory agents)</label>
                    <div class="bf-mem-row-inner">
                        <label class="checkbox_label">
                            <input type="checkbox" id="bf_mem_use_profile" ${extensionSettings.useMemoryProfile ? 'checked' : ''} />
                            <span>Use separate profile</span>
                        </label>
                        <select id="bf_mem_profile" class="text_pole">
                            ${buildProfileDropdown(extensionSettings.memoryProfile)}
                        </select>
                    </div>
                </div>

                <!-- Context Messages -->
                <div class="bf-mem-row">
                    <label>Context Messages (sent to Draft Agent)</label>
                    <input type="number" id="bf_mem_context" class="text_pole" min="1" max="100"
                        value="${extensionSettings.contextMessages}" />
                    <small class="bf-mem-hint">Number of recent chat messages Agent 1 sees (1-100)</small>
                </div>

                <!-- Review Interval -->
                <div class="bf-mem-row">
                    <label>Review Popup Interval (messages)</label>
                    <input type="number" id="bf_mem_review_interval" class="text_pole" min="1" max="200"
                        value="${extensionSettings.reviewInterval}" />
                    <small class="bf-mem-hint">How many messages before the fact review popup appears (1-200)</small>
                </div>

                <!-- Retrieval Probabilities -->
                <div class="bf-mem-row">
                    <label>Secondary Fact Chance: <span id="bf_mem_secondary_val">${extensionSettings.secondaryChance}%</span></label>
                    <input type="range" id="bf_mem_secondary" class="bf-mem-slider" min="0" max="100" step="5"
                        value="${extensionSettings.secondaryChance}" />
                    <small class="bf-mem-hint">How often related but not directly requested facts are included</small>
                </div>
                <div class="bf-mem-row">
                    <label>Tertiary Fact Chance: <span id="bf_mem_tertiary_val">${extensionSettings.tertiaryChance}%</span></label>
                    <input type="range" id="bf_mem_tertiary" class="bf-mem-slider" min="0" max="100" step="5"
                        value="${extensionSettings.tertiaryChance}" />
                    <small class="bf-mem-hint">How often distant/thematic facts are included (e.g. food mention -> a restaurant memory)</small>
                </div>

                <!-- General Settings -->
                <div class="bf-mem-row">
                    <label class="checkbox_label">
                        <input type="checkbox" id="bf_mem_toast" ${extensionSettings.showToast ? 'checked' : ''} />
                        <span>Show toast notifications</span>
                    </label>
                </div>
                <div class="bf-mem-row">
                    <label class="checkbox_label">
                        <input type="checkbox" id="bf_mem_debug" ${extensionSettings.debugMode ? 'checked' : ''} />
                        <span>Debug mode</span>
                    </label>
                </div>

                <!-- Database Browser -->
                <div class="bf-mem-row">
                    <button id="bf_mem_browse_db" class="menu_button">Browse Databases</button>
                    <button id="bf_mem_clear_db" class="menu_button redWarningBG">Clear All Databases</button>
                </div>

                <!-- Debug Panel -->
                <div id="bf_mem_debug_panel" class="bf-mem-debug-panel" style="display: ${extensionSettings.debugMode ? 'block' : 'none'}">
                    <div class="bf-mem-debug-header">
                        <b>Debug Log</b>
                        <button id="bf_mem_clear_log" class="menu_button">Clear</button>
                    </div>
                    <div id="bf_mem_debug_log" class="bf-mem-debug-log"></div>
                </div>
            </div>
        </div>
    </div>`;

    // Insert into extensions panel
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);
    }

    // Bind events
    document.getElementById('bf_mem_enabled')?.addEventListener('change', (e) => {
        extensionSettings.enabled = e.target.checked;
        saveSettings();
    });

    document.getElementById('bf_mem_use_profile')?.addEventListener('change', (e) => {
        extensionSettings.useMemoryProfile = e.target.checked;
        saveSettings();
    });

    document.getElementById('bf_mem_profile')?.addEventListener('change', (e) => {
        extensionSettings.memoryProfile = e.target.value;
        saveSettings();
    });

    document.getElementById('bf_mem_context')?.addEventListener('change', (e) => {
        extensionSettings.contextMessages = parseInt(e.target.value) || 5;
        saveSettings();
    });

    document.getElementById('bf_mem_review_interval')?.addEventListener('change', (e) => {
        extensionSettings.reviewInterval = parseInt(e.target.value) || 10;
        saveSettings();
    });

    document.getElementById('bf_mem_secondary')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value) || 0;
        extensionSettings.secondaryChance = val;
        document.getElementById('bf_mem_secondary_val').textContent = `${val}%`;
        saveSettings();
    });

    document.getElementById('bf_mem_tertiary')?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value) || 0;
        extensionSettings.tertiaryChance = val;
        document.getElementById('bf_mem_tertiary_val').textContent = `${val}%`;
        saveSettings();
    });

    document.getElementById('bf_mem_toast')?.addEventListener('change', (e) => {
        extensionSettings.showToast = e.target.checked;
        saveSettings();
    });

    document.getElementById('bf_mem_debug')?.addEventListener('change', (e) => {
        extensionSettings.debugMode = e.target.checked;
        const panel = document.getElementById('bf_mem_debug_panel');
        if (panel) panel.style.display = e.target.checked ? 'block' : 'none';
        saveSettings();
    });

    document.getElementById('bf_mem_clear_log')?.addEventListener('click', () => {
        debugLog = [];
        updateDebugPanel();
    });

    document.getElementById('bf_mem_browse_db')?.addEventListener('click', async () => {
        await showDatabaseBrowser();
    });

    document.getElementById('bf_mem_clear_db')?.addEventListener('click', async () => {
        await ensurePopup();
        if (Popup) {
            const result = await Popup.show.confirm('Clear ALL memory databases for this character?', 'This cannot be undone.');
            if (result) {
                const { getAllDatabases, deleteDatabase } = await import('./database.js');
                const dbs = await getAllDatabases();
                for (const category of Object.keys(dbs)) {
                    await deleteDatabase(category);
                }
                addDebugLog('info', 'All databases cleared');
                toastr.success('All memory databases cleared', 'BF Memory');
            }
        }
    });

    // Refresh profile dropdown when profiles change
    context.eventSource?.on(context.eventTypes?.CONNECTION_PROFILE_LOADED, () => {
        const dropdown = document.getElementById('bf_mem_profile');
        if (dropdown) {
            dropdown.innerHTML = buildProfileDropdown(extensionSettings.memoryProfile);
        }
    });

    console.log('[BFMemory] Settings initialized');
}

async function showDatabaseBrowser() {
    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();
    const categories = Object.keys(databases);

    if (categories.length === 0) {
        toastr.info('No memory databases yet. They will be created as you chat.', 'BF Memory');
        return;
    }

    let html = '<div class="bf-mem-db-browser">';
    for (const [category, db] of Object.entries(databases)) {
        html += `<div class="bf-mem-db-section">`;
        html += `<h4>${escapeHtml(category)} (${db.facts.length} facts)</h4>`;
        html += '<table class="bf-mem-db-table"><tr><th>Key</th><th>Value</th><th>Known By</th><th>Tags</th></tr>';
        for (const fact of db.facts) {
            html += `<tr>
                <td>${escapeHtml(fact.key)}</td>
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
        await Popup.show.text('Memory Databases', html);
    }
}
