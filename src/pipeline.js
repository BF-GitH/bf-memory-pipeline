// BF Memory Pipeline - Main Orchestrator
// Blocking approach: intercept user message, run Agent 1 + retrieval,
// then trigger generation with facts injected. Hides response area while working.

import { runDraftAgent } from './agent-draft.js';
import { buildWriterInjection, injectMemoryContext } from './agent-writer.js';
import { runMemoryUpdater } from './agent-memory.js';
import { retrieveFacts, extractContextKeywords } from './fact-retrieval.js';
import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact } from './database.js';
import { runWithMemoryProfile } from './profiler.js';
import { trackUpdate, tickMessageCounter, showReviewPopup } from './review-popup.js';
import { getSettings, addDebugLog, updateStatus } from './settings.js';

// Pipeline state
let pipelineActive = false;
let pendingInjection = null;
let lastProcessedMessageIndex = -1;
let interceptedGeneration = false;
let isInternalCall = false; // Guard: true when our agents are making LLM calls
let isOurAbort = false; // Guard: true when WE called /abort (so GENERATION_STOPPED ignores it)
let chatChangedAt = 0; // Timestamp of last chat change (cooldown)

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

// --- Pre-generation: Agent 3 (memory) + Agent 1 (draft) in parallel, then fact retrieval ---

async function runPreGeneration() {
    const settings = getSettings();
    if (!settings || !settings.enabled) return null;

    const startTime = Date.now();
    const context = SillyTavern.getContext();
    const chat = context.chat;
    const charName = context.characters?.[context.characterId]?.name || '(unknown)';
    const characterInfo = getCharacterInfo();
    const userPersona = getUserPersona();

    const recentMessages = getRecentMessages(settings.contextMessages || 5);
    if (recentMessages.length === 0) {
        addDebugLog('info', 'No messages in chat, skipping pipeline');
        return null;
    }

    addDebugLog('info', `Character: ${charName} | Messages: ${recentMessages.length} | Profile: ${settings.memoryProfile || '(default)'}`);
    for (let i = 0; i < recentMessages.length; i++) {
        const msg = recentMessages[i];
        const role = msg.is_user ? 'USER' : 'AI';
        addDebugLog('info', `  [${i + 1}/${recentMessages.length}] ${role}: ${msg.mes}`);
    }

    // Find the last AI message to process for memory (the one before the user's new message)
    let memoryTargetIndex = -1;
    for (let i = chat.length - 2; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user && chat[i].mes) {
            memoryTargetIndex = i;
            break;
        }
    }

    const formattedChat = formatMessagesForDraft(recentMessages);

    // --- Run Agent 3 + Agent 1 in PARALLEL (single profile switch) ---
    updateStatus('running', 'Updating memory + drafting...');
    addDebugLog('info', 'Running Agent 3 (memory) + Agent 1 (draft) in parallel...');

    let draftResult = null;
    let memoryResult = null;

    try {
        await runWithMemoryProfile(async () => {
            const promises = [];

            // Agent 1: Draft
            promises.push(
                runDraftAgent(formattedChat, characterInfo, userPersona)
                    .catch(err => ({ draft: '', neededFacts: [], raw: '', error: err.message })),
            );

            // Agent 3: Memory update (if there's a valid target)
            if (memoryTargetIndex >= 0 && memoryTargetIndex > lastProcessedMessageIndex) {
                const targetMessage = chat[memoryTargetIndex];
                const role = targetMessage.is_user ? 'USER' : 'AI';
                addDebugLog('info', `Agent 3 target [${role}] msg ${memoryTargetIndex}: ${targetMessage.mes}`);

                const databases = await getAllDatabases();
                promises.push(
                    runMemoryUpdater(targetMessage.mes, memoryTargetIndex, characterInfo, databases)
                        .catch(err => ({ updates: [], summary: '', raw: '', error: err.message })),
                );
            } else {
                addDebugLog('info', `Agent 3: no new AI message to process (target=${memoryTargetIndex}, last=${lastProcessedMessageIndex})`);
                promises.push(Promise.resolve(null));
            }

            [draftResult, memoryResult] = await Promise.all(promises);
        }, settings);
    } catch (error) {
        addDebugLog('fail', `Pipeline exception: ${error.message}`);
        return null;
    }

    // --- Process Agent 3 results ---
    if (memoryResult && !memoryResult.error) {
        addDebugLog('info', `Agent 3: ${memoryResult.updates.length} updates. ${memoryResult.summary}`);
        for (const update of memoryResult.updates) {
            trackUpdate(update);
        }
        lastProcessedMessageIndex = memoryTargetIndex;

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
                            dbs[item.category] = createEmptyDatabase(item.category);
                        }
                        upsertFact(dbs[item.category], item);
                        await saveDatabase(dbs[item.category]);
                    }
                },
            );
        }
    } else if (memoryResult?.error) {
        addDebugLog('fail', `Agent 3 error: ${memoryResult.error}`);
    }

    // --- Process Agent 1 results ---
    if (!draftResult || draftResult.error) {
        addDebugLog('fail', `Agent 1 error: ${draftResult?.error || 'no result'}`);
        return null;
    }

    addDebugLog('info', `Agent 1 done: "${draftResult.draft.substring(0, 80)}..."`);
    addDebugLog('info', `Needed facts: ${draftResult.neededFacts.join('; ')}`);

    // --- Fact Retrieval (pure DB lookup, uses Agent 3's fresh data) ---
    addDebugLog('info', 'Retrieving facts...');
    updateStatus('running', 'Retrieving facts...');

    const contextKeywords = extractContextKeywords(recentMessages);
    const retrieval = await retrieveFacts(draftResult.neededFacts, contextKeywords);

    addDebugLog('info', `Retrieved ${retrieval.stats.primary}P/${retrieval.stats.secondary}S/${retrieval.stats.tertiary}T facts`);

    // Build injection
    const injection = buildWriterInjection(draftResult.draft, retrieval.formatted);
    addDebugLog('info', `Injection ready (${injection.length} chars) in ${Date.now() - startTime}ms`);

    return injection;
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

        // Cooldown: ignore generation events within 5s of entering a chat
        // (ST may auto-generate greetings or continue on chat load)
        if (Date.now() - chatChangedAt < 5000) {
            addDebugLog('info', 'Skipping pipeline (chat just loaded, cooldown active)');
            return;
        }

        pipelineActive = true;
        addDebugLog('info', '--- Pipeline triggered: intercepting generation ---');

        // Stop the current generation immediately
        isOurAbort = true;
        try {
            await runner('/abort');
        } catch { /* may fail if nothing running yet, that's ok */ }
        isOurAbort = false;

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

    // AFTER generation complete: reset pipeline state
    eventSource.on(eventTypes.MESSAGE_RECEIVED, async () => {
        pipelineActive = false;
        updateStatus('idle');
    });

    // Handle generation stopped/aborted
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        // Ignore if WE called /abort (we're about to /trigger)
        if (isOurAbort) return;

        if (pipelineActive && !interceptedGeneration) {
            // User aborted during our pipeline work
            pipelineActive = false;
            pendingInjection = null;
            hideWorkingIndicator();
            updateStatus('idle', 'Aborted');
            addDebugLog('info', 'Generation stopped by user during pipeline');
        }
    });

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        pipelineActive = false;
        pendingInjection = null;
        interceptedGeneration = false;
        isInternalCall = false;
        isOurAbort = false;
        lastProcessedMessageIndex = -1;
        chatChangedAt = Date.now();
        hideWorkingIndicator();
        updateStatus('idle');
        addDebugLog('info', 'Chat changed - pipeline state reset');
    });

    console.log('[BFMemory] Pipeline initialized (blocking mode)');
}
