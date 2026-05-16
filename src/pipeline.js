// BF Memory Pipeline - Main Orchestrator
// Blocking approach: intercept user message, run Agent 1 + retrieval,
// then trigger generation with facts injected. Hides response area while working.

import { runDraftAgent } from './agent-draft.js';
import { buildWriterInjection, injectMemoryContext } from './agent-writer.js';
import { runMemoryUpdater } from './agent-memory.js';
import { retrieveFacts, extractContextKeywords } from './fact-retrieval.js';
import { getAllDatabases, saveDatabase } from './database.js';
import { runWithMemoryProfile } from './profiler.js';
import { trackUpdate, tickMessageCounter, showReviewPopup } from './review-popup.js';
import { getSettings, addDebugLog, updateStatus } from './settings.js';

// Pipeline state
let pipelineActive = false;
let pendingInjection = null;
let lastProcessedMessageIndex = -1;
let isMemoryUpdateRunning = false;
let interceptedGeneration = false;
let isInternalCall = false; // Guard: true when our agents are making LLM calls

/**
 * Get recent chat messages
 */
function getRecentMessages(count) {
    const context = SillyTavern.getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return [];

    const messages = [];
    const startIndex = Math.max(0, chat.length - count);
    for (let i = startIndex; i < chat.length; i++) {
        if (chat[i] && chat[i].mes) {
            messages.push(chat[i]);
        }
    }
    return messages;
}

/**
 * Format messages for Agent 1
 */
function formatMessagesForDraft(messages) {
    return messages.map((msg, idx) => {
        const role = msg.is_user ? 'USER' : 'AI';
        return `Message ${idx + 1}: ${role}: ${msg.mes.substring(0, 500)}`;
    }).join('\n');
}

/**
 * Get character info for prompts
 */
function getCharacterInfo() {
    const context = SillyTavern.getContext();
    const char = context.characters?.[context.characterId];
    if (!char) return '';

    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 500)}`);
    if (char.personality) parts.push(`Personality: ${char.personality.substring(0, 300)}`);
    if (char.scenario) parts.push(`Scenario: ${char.scenario.substring(0, 300)}`);
    return parts.join('\n');
}

/**
 * Get user persona info
 */
function getUserPersona() {
    const context = SillyTavern.getContext();
    return context.persona?.description || context.name1 || '';
}

// --- UI: Indicator ---

function showWorkingIndicator() {
    let indicator = document.getElementById('bf_mem_working_indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'bf_mem_working_indicator';
        indicator.innerHTML = '<i class="fa-solid fa-brain fa-spin"></i> Memory Pipeline: preparing facts...';
        indicator.style.cssText = `
            display: flex; align-items: center; gap: 8px;
            padding: 10px 15px; margin: 5px 0;
            background: var(--SmartThemeBlurTintColor, #1a1a2e);
            border: 1px solid var(--SmartThemeBorderColor, #444);
            border-radius: 6px; color: #7bb3ff; font-size: 13px;
        `;
        const sendForm = document.getElementById('send_form');
        if (sendForm) {
            sendForm.parentNode.insertBefore(indicator, sendForm);
        }
    }
    indicator.style.display = 'flex';
}

function hideWorkingIndicator() {
    const indicator = document.getElementById('bf_mem_working_indicator');
    if (indicator) indicator.style.display = 'none';
}

// --- Phase 1+2: Pre-generation (blocking) ---

async function runPreGeneration() {
    const settings = getSettings();
    if (!settings || !settings.enabled) return null;

    const startTime = Date.now();
    addDebugLog('info', 'Phase 1: Running draft agent...');
    updateStatus('running', 'Running draft agent...');

    const recentMessages = getRecentMessages(settings.contextMessages || 5);
    if (recentMessages.length === 0) {
        addDebugLog('info', 'No messages in chat, skipping pipeline');
        return null;
    }

    const formattedChat = formatMessagesForDraft(recentMessages);
    const characterInfo = getCharacterInfo();
    const userPersona = getUserPersona();

    const context = SillyTavern.getContext();
    const charName = context.characters?.[context.characterId]?.name || '(unknown)';
    addDebugLog('info', `Character: ${charName} | Messages: ${recentMessages.length} | Profile: ${settings.memoryProfile || '(default)'}`);

    // Agent 1: Draft (runs on memory profile)
    let draftResult;
    try {
        draftResult = await runWithMemoryProfile(async () => {
            return await runDraftAgent(formattedChat, characterInfo, userPersona);
        }, settings);
    } catch (error) {
        addDebugLog('fail', `Agent 1 exception: ${error.message}`);
        addDebugLog('fail', `Stack: ${(error.stack || '').split('\n').slice(0, 3).join(' | ')}`);
        return null;
    }

    if (draftResult.error) {
        addDebugLog('fail', `Agent 1 returned error: ${draftResult.error}`);
        return null;
    }

    addDebugLog('info', `Agent 1 done: "${draftResult.draft.substring(0, 80)}..."`);
    addDebugLog('info', `Needed facts: ${draftResult.neededFacts.join('; ')}`);

    // Fact Retrieval (no LLM, pure DB lookup)
    addDebugLog('info', 'Phase 2: Retrieving facts...');
    updateStatus('running', 'Retrieving facts...');

    const contextKeywords = extractContextKeywords(recentMessages);
    const retrieval = await retrieveFacts(draftResult.neededFacts, contextKeywords);

    addDebugLog('info', `Retrieved ${retrieval.stats.primary}P/${retrieval.stats.secondary}S/${retrieval.stats.tertiary}T facts`);

    // Build injection
    const injection = buildWriterInjection(draftResult.draft, retrieval.formatted);
    addDebugLog('info', `Injection ready (${injection.length} chars) in ${Date.now() - startTime}ms`);

    return injection;
}

// --- Phase 3: Post-generation (non-blocking) ---

async function runPostGeneration(currentMessageIndex) {
    const settings = getSettings();
    if (!settings || !settings.enabled) return;

    // Only process message BEFORE current (N-1 for swipe safety)
    const targetIndex = currentMessageIndex - 1;
    if (targetIndex < 0) return;
    if (targetIndex <= lastProcessedMessageIndex) return;
    if (isMemoryUpdateRunning) {
        addDebugLog('info', 'Memory update already running, skipping');
        return;
    }

    const context = SillyTavern.getContext();
    const targetMessage = context.chat?.[targetIndex];
    if (!targetMessage || !targetMessage.mes) return;

    isMemoryUpdateRunning = true;
    isInternalCall = true;
    addDebugLog('info', `Phase 3: Updating memory for message ${targetIndex}...`);

    try {
        const characterInfo = getCharacterInfo();
        const databases = await getAllDatabases();

        const result = await runWithMemoryProfile(async () => {
            return await runMemoryUpdater(
                targetMessage.mes,
                targetIndex,
                characterInfo,
                databases,
            );
        }, settings);

        if (result.error) {
            addDebugLog('fail', `Agent 3 error: ${result.error}`);
        } else {
            addDebugLog('info', `Agent 3: ${result.updates.length} updates. ${result.summary}`);
            for (const update of result.updates) {
                trackUpdate(update);
            }
        }

        lastProcessedMessageIndex = targetIndex;

        // Check if review popup is due
        if (tickMessageCounter(settings.reviewInterval || 10)) {
            addDebugLog('info', 'Review interval reached, showing popup');
            await showReviewPopup(
                () => addDebugLog('info', 'User accepted all memory updates'),
                async (editedItems) => {
                    addDebugLog('info', `User edited ${editedItems.length} items`);
                    const dbs = await getAllDatabases();
                    for (const item of editedItems) {
                        if (!dbs[item.category]) {
                            const { createEmptyDatabase } = await import('./database.js');
                            dbs[item.category] = createEmptyDatabase(item.category);
                        }
                        const { upsertFact } = await import('./database.js');
                        upsertFact(dbs[item.category], item);
                        await saveDatabase(dbs[item.category]);
                    }
                },
            );
        }
    } catch (error) {
        addDebugLog('fail', `Memory update error: ${error.message}`);
    } finally {
        isMemoryUpdateRunning = false;
        isInternalCall = false;
    }
}

// --- Main Pipeline Init ---

export function initPipeline() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;
    const runner = context.executeSlashCommandsWithOptions;

    // INTERCEPT: When user sends a message, block generation,
    // run Agent 1 + retrieval, then trigger generation with injection ready.
    eventSource.on(eventTypes.GENERATION_STARTED, async () => {
        const settings = getSettings();
        if (!settings || !settings.enabled) return;
        if (pipelineActive) return;

        // Skip events from our own internal LLM calls (Agent 1, Agent 3)
        if (isInternalCall) return;

        // If this generation was triggered BY US after pipeline, don't intercept again
        if (interceptedGeneration) {
            interceptedGeneration = false;
            return;
        }

        pipelineActive = true;
        addDebugLog('info', '--- Pipeline triggered: intercepting generation ---');

        // Stop the current generation immediately
        try {
            await runner('/abort');
        } catch { /* may fail if nothing running yet, that's ok */ }

        showWorkingIndicator();
        updateStatus('running', 'Preparing facts...');

        try {
            isInternalCall = true;
            pendingInjection = await runPreGeneration();
        } catch (error) {
            addDebugLog('fail', `Pre-generation error: ${error.message}`);
            pendingInjection = null;
        } finally {
            isInternalCall = false;
        }

        hideWorkingIndicator();
        updateStatus('running', 'Generating with facts...');

        // Now trigger the actual generation - injection is ready
        interceptedGeneration = true;
        addDebugLog('info', 'Triggering generation with facts ready...');

        try {
            await runner('/trigger');
        } catch (error) {
            addDebugLog('fail', `Trigger error: ${error.message}`);
            pipelineActive = false;
            interceptedGeneration = false;
            updateStatus('error', 'Generation failed');
        }
    });

    // Inject memory context into the prompt (synchronous - injection is already prepared)
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, (data) => {
        if (!pendingInjection) return;
        if (isInternalCall) return;
        if (data?.dryRun) return;

        addDebugLog('info', `Injecting ${pendingInjection.length} chars into prompt (format: ${data?.chat ? 'chat' : data?.messages ? 'messages' : data?.prompt ? 'text' : 'unknown'})`);
        const success = injectMemoryContext(data, pendingInjection);
        if (success) {
            addDebugLog('pass', 'Memory context injected into prompt');
        } else {
            addDebugLog('fail', 'Failed to inject memory context - no compatible format found');
        }

        pendingInjection = null;
    });

    // Handle text completion APIs
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, (data, dryRun) => {
        if (!pendingInjection || dryRun || isInternalCall) return;

        if (data && typeof data.prompt === 'string') {
            data.prompt = pendingInjection + '\n\n' + data.prompt;
            addDebugLog('pass', 'Memory context injected into text prompt');
            pendingInjection = null;
        }
    });

    // AFTER generation complete: run memory updater in background
    eventSource.on(eventTypes.MESSAGE_RECEIVED, async (messageIndex) => {
        pipelineActive = false;
        updateStatus('idle');

        const settings = getSettings();
        if (!settings || !settings.enabled) return;

        // Delay to let message fully commit
        setTimeout(() => {
            runPostGeneration(messageIndex);
        }, 1000);
    });

    // Handle generation stopped/aborted
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        if (pipelineActive && !interceptedGeneration) {
            // User aborted during our pipeline work
            pipelineActive = false;
            pendingInjection = null;
            hideWorkingIndicator();
            updateStatus('idle', 'Aborted');
            addDebugLog('info', 'Generation stopped during pipeline');
        }
    });

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        pipelineActive = false;
        pendingInjection = null;
        interceptedGeneration = false;
        isInternalCall = false;
        lastProcessedMessageIndex = -1;
        isMemoryUpdateRunning = false;
        hideWorkingIndicator();
        updateStatus('idle');
        addDebugLog('info', 'Chat changed - pipeline state reset');
    });

    console.log('[BFMemory] Pipeline initialized (blocking mode)');
}
