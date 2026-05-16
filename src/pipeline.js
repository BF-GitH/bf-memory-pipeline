// BF Memory Pipeline - Main Orchestrator
// Coordinates the 3-agent pipeline: Draft -> Retrieve -> Write -> Update Memory

import { runDraftAgent } from './agent-draft.js';
import { buildWriterInjection, injectMemoryContext } from './agent-writer.js';
import { runMemoryUpdater } from './agent-memory.js';
import { retrieveFacts, extractContextKeywords } from './fact-retrieval.js';
import { getAllDatabases, saveDatabase } from './database.js';
import { runWithMemoryProfile } from './profiler.js';
import { trackUpdate, tickMessageCounter, showReviewPopup, clearPendingItems } from './review-popup.js';
import { getSettings, addDebugLog } from './settings.js';

// Pipeline state
let pipelineActive = false;
let pendingInjection = null;
let lastProcessedMessageIndex = -1;
let isMemoryUpdateRunning = false;

/**
 * Get recent chat messages
 * @param {number} count - Number of messages to get
 * @returns {Array} Recent message objects
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

/**
 * Phase 1 + 2: Run Draft Agent and Fact Retrieval
 * Called BEFORE the main generation starts
 * @returns {Promise<string|null>} Injection text for the writer, or null
 */
async function runPreGeneration() {
    const settings = getSettings();
    if (!settings || !settings.enabled) return null;

    const startTime = Date.now();
    addDebugLog('info', 'Pipeline Phase 1: Starting draft agent...');

    const recentMessages = getRecentMessages(settings.contextMessages || 5);
    if (recentMessages.length === 0) {
        addDebugLog('info', 'No messages in chat, skipping pipeline');
        return null;
    }

    const formattedChat = formatMessagesForDraft(recentMessages);
    const characterInfo = getCharacterInfo();
    const userPersona = getUserPersona();

    // Agent 1: Draft (runs on memory profile)
    let draftResult;
    try {
        draftResult = await runWithMemoryProfile(async () => {
            return await runDraftAgent(formattedChat, characterInfo, userPersona);
        }, settings);
    } catch (error) {
        addDebugLog('fail', `Agent 1 error: ${error.message}`);
        return null;
    }

    if (draftResult.error) {
        addDebugLog('fail', `Agent 1 failed: ${draftResult.error}`);
        return null;
    }

    addDebugLog('info', `Agent 1 complete: "${draftResult.draft.substring(0, 80)}..."`);
    addDebugLog('info', `Needed facts: ${draftResult.neededFacts.join('; ')}`);

    // Automation Step 1: Fact Retrieval (no LLM, pure DB lookup)
    addDebugLog('info', 'Pipeline Phase 2: Retrieving facts...');

    const contextKeywords = extractContextKeywords(recentMessages);
    const retrieval = await retrieveFacts(draftResult.neededFacts, contextKeywords);

    addDebugLog('info', `Retrieved ${retrieval.stats.primary}P/${retrieval.stats.secondary}S/${retrieval.stats.tertiary}T facts`);

    // Build injection for Agent 2 (Writer = main model)
    const injection = buildWriterInjection(draftResult.draft, retrieval.formatted);
    addDebugLog('info', `Injection ready (${injection.length} chars)`);
    addDebugLog('info', `Pipeline Phase 1+2 took ${Date.now() - startTime}ms`);

    return injection;
}

/**
 * Phase 3: Run Memory Updater on confirmed messages
 * Called AFTER a response is displayed
 * @param {number} currentMessageIndex - Index of the just-displayed message
 */
async function runPostGeneration(currentMessageIndex) {
    const settings = getSettings();
    if (!settings || !settings.enabled) return;

    // Only process the message BEFORE current (N-1 safety for swipes)
    const targetIndex = currentMessageIndex - 1;
    if (targetIndex < 0) return;

    // Don't re-process messages
    if (targetIndex <= lastProcessedMessageIndex) return;

    // Prevent concurrent memory updates
    if (isMemoryUpdateRunning) {
        addDebugLog('info', 'Memory update already running, skipping');
        return;
    }

    const context = SillyTavern.getContext();
    const chat = context.chat;
    const targetMessage = chat?.[targetIndex];

    if (!targetMessage || !targetMessage.mes) return;

    isMemoryUpdateRunning = true;
    addDebugLog('info', `Pipeline Phase 3: Updating memory for message ${targetIndex}...`);

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

            // Track updates for review popup
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
                    // Re-apply edited items
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
    }
}

/**
 * Initialize the pipeline event listeners
 */
export function initPipeline() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // BEFORE generation: Run Agent 1 + Fact Retrieval
    eventSource.on(eventTypes.GENERATION_STARTED, async () => {
        const settings = getSettings();
        if (!settings || !settings.enabled) return;
        if (pipelineActive) return;

        pipelineActive = true;
        addDebugLog('info', '--- Pipeline triggered ---');

        try {
            pendingInjection = await runPreGeneration();
        } catch (error) {
            addDebugLog('fail', `Pre-generation error: ${error.message}`);
            pendingInjection = null;
        }
    });

    // Inject memory context into the prompt
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, (data) => {
        if (!pendingInjection) return;
        if (data?.dryRun) return;

        const success = injectMemoryContext(data, pendingInjection);
        if (success) {
            addDebugLog('pass', 'Memory context injected into prompt');
        } else {
            addDebugLog('fail', 'Failed to inject memory context');
        }

        // Clear after injection
        pendingInjection = null;
    });

    // Also handle text completion APIs
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, (data, dryRun) => {
        if (!pendingInjection || dryRun) return;

        if (data && typeof data.prompt === 'string') {
            data.prompt = pendingInjection + '\n\n' + data.prompt;
            addDebugLog('pass', 'Memory context injected into text prompt');
            pendingInjection = null;
        }
    });

    // AFTER generation: Run Memory Updater on confirmed message
    eventSource.on(eventTypes.MESSAGE_RECEIVED, async (messageIndex) => {
        pipelineActive = false;

        const settings = getSettings();
        if (!settings || !settings.enabled) return;

        // Small delay to ensure message is committed
        setTimeout(() => {
            runPostGeneration(messageIndex);
        }, 1000);
    });

    // Handle generation stopped
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        pipelineActive = false;
        pendingInjection = null;
    });

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        pipelineActive = false;
        pendingInjection = null;
        lastProcessedMessageIndex = -1;
        isMemoryUpdateRunning = false;
        addDebugLog('info', 'Chat changed - pipeline state reset');
    });

    console.log('[BFMemory] Pipeline initialized');
}
