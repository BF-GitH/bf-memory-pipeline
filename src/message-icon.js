// BF Memory Pipeline - per-message Agent 3 icon
// Adds a brain icon next to each message's edit icon. Green = already processed
// by Agent 3, grey = not yet. Click to force Agent 3 on that specific message.

import { addDebugLog } from './settings.js';

const ICON_CLASS = 'bf_mem_msg_icon';
const ICON_PROCESSED_CLASS = 'bf_mem_msg_icon_processed';
const ICON_LOADING_CLASS = 'bf_mem_msg_icon_loading';

/**
 * Inject the brain icon into a single message's button toolbar.
 * Idempotent — if already injected, just updates the state.
 */
function injectIcon(messageEl) {
    if (!messageEl) return;
    const buttons = messageEl.querySelector('.mes_buttons');
    if (!buttons) return;

    const mesId = parseInt(messageEl.getAttribute('mesid'));
    if (Number.isNaN(mesId)) return;

    const chat = SillyTavern.getContext().chat;
    const msg = chat?.[mesId];
    if (!msg) return;

    // Skip system messages / non-user-non-ai
    if (msg.is_system) return;
    if (msg.extra?.type) return;

    let icon = buttons.querySelector(`.${ICON_CLASS}`);
    if (!icon) {
        icon = document.createElement('div');
        icon.className = `mes_button ${ICON_CLASS} fa-solid fa-brain interactable`;
        icon.setAttribute('tabindex', '0');
        icon.addEventListener('click', (e) => onIconClick(e, mesId));
        // Insert before the existing edit button if present, otherwise prepend
        const editBtn = buttons.querySelector('.mes_edit');
        if (editBtn) {
            buttons.insertBefore(icon, editBtn);
        } else {
            buttons.prepend(icon);
        }
    }

    // Update visual state based on current data
    updateIconState(icon, msg);
}

function updateIconState(iconEl, msg) {
    const processed = !!msg.extra?.bf_mem_processed;
    iconEl.classList.toggle(ICON_PROCESSED_CLASS, processed);
    iconEl.title = processed
        ? 'Agent 3 has extracted facts from this message. Click to re-run.'
        : 'Agent 3 has NOT processed this message. Click to force extraction.';
}

async function onIconClick(e, mesId) {
    e.stopPropagation();
    const ctx = SillyTavern.getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg) return;

    const iconEl = e.currentTarget;
    if (iconEl.classList.contains(ICON_LOADING_CLASS)) return; // prevent double-click
    iconEl.classList.add(ICON_LOADING_CLASS);

    try {
        const { runMemoryUpdater } = await import('./agent-memory.js');
        const { getAgent3ProfileId } = await import('./profiler.js');
        const { getAllDatabases } = await import('./database.js');
        const { getSettings, saveCurrentToActiveProfile } = await import('./settings.js');

        const settings = getSettings();
        const profileId = getAgent3ProfileId(settings);

        const char = ctx.characters?.[ctx.characterId];
        const charInfo = char ? [
            char.name && `Name: ${char.name}`,
            char.description && `Description: ${char.description.substring(0, 2000)}`,
            char.personality && `Personality: ${char.personality.substring(0, 1000)}`,
            char.scenario && `Scenario: ${char.scenario.substring(0, 1000)}`,
        ].filter(Boolean).join('\n') : '';
        const userPersona = ctx.persona?.description || ctx.name1 || '';

        const databases = await getAllDatabases();
        addDebugLog('info', `Per-msg icon: forcing Agent 3 on msg ${mesId}`);
        const result = await runMemoryUpdater(
            msg.mes,
            mesId,
            charInfo,
            databases,
            profileId,
            !!msg.is_user,
            userPersona,
            [],
        );
        const n = result?.updates?.length || 0;

        // Mark processed + persist
        msg.extra = { ...(msg.extra || {}), bf_mem_processed: true };
        ctx.saveChatDebounced?.();
        if (n > 0) await saveCurrentToActiveProfile();

        updateIconState(iconEl, msg);
        if (typeof toastr !== 'undefined') {
            toastr.success(`Agent 3: ${n} facts extracted from msg ${mesId}`, 'BF Memory', { timeOut: 3000 });
        }
    } catch (err) {
        addDebugLog('fail', `Per-msg icon failed for msg ${mesId}: ${err.message || err}`);
        if (typeof toastr !== 'undefined') {
            toastr.error(`Extraction failed: ${err.message}`, 'BF Memory');
        }
    } finally {
        iconEl.classList.remove(ICON_LOADING_CLASS);
    }
}

/**
 * Walk every message in the current chat and inject icons.
 * Called on extension load + on CHAT_CHANGED.
 */
function injectAllIcons() {
    document.querySelectorAll('.mes[mesid]').forEach(el => injectIcon(el));
}

/**
 * Wire ST events so icons appear on newly-rendered + edited messages.
 */
export function initMessageIcons() {
    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes } = ctx;

    if (!eventSource || !eventTypes) {
        console.warn('[BFMemory] No eventSource; per-message icons disabled');
        return;
    }

    // Per-message render events
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);
        injectIcon(el);
    });
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);
        injectIcon(el);
    });
    eventSource.on(eventTypes.MESSAGE_UPDATED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);
        // Editing a message invalidates prior extraction — reset the flag.
        const msg = ctx.chat?.[mesId];
        if (msg?.extra?.bf_mem_processed) {
            msg.extra.bf_mem_processed = false;
            ctx.saveChatDebounced?.();
        }
        injectIcon(el);
    });

    // Full re-render on chat change (new chat → all messages rendered fresh)
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        // Defer so ST finishes rendering first
        setTimeout(injectAllIcons, 100);
    });

    // Initial injection in case extension loads after chat already rendered
    setTimeout(injectAllIcons, 500);
}
