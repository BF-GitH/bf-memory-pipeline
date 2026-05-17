// BF Memory Pipeline - Main Orchestrator (v2 - Inline Blocking)
// Runs agents during prompt assembly. Never aborts, never re-triggers.
// ST's EventEmitter awaits async handlers, so generation waits for us.

import { runDraftAgent } from './agent-draft.js';
import { buildWriterInjection, injectMemoryContext } from './agent-writer.js';
import { runMemoryUpdater } from './agent-memory.js';
import { retrieveFacts, extractContextKeywords } from './fact-retrieval.js';
import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact } from './database.js';
import { getMemoryProfileId } from './profiler.js';
import { trackUpdate, tickMessageCounter, showReviewPopup } from './review-popup.js';
import { getSettings, addDebugLog, updateStatus, updatePipelineSummary, saveCurrentToActiveProfile } from './settings.js';

// Pipeline state
let lastProcessedMessageIndex = -1;
let isInternalCall = false; // true when our agents are making LLM calls
let chatChangedAt = 0;
let lastTriggeredUserMsgIndex = -1;
let lastInjection = null; // cached injection text for swipes/regens
let pipelineJustInjected = false; // guards against double-fire of CHAT_COMPLETION_PROMPT_READY

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

// --- Determine if this generation should trigger the pipeline ---

function shouldRunPipeline(data) {
    const settings = getSettings();
    if (!settings || !settings.enabled) return false;

    // Skip our own internal LLM calls (Agent 1, Agent 3)
    if (isInternalCall) {
        addDebugLog('info', 'Skipping pipeline (internal agent call)');
        return false;
    }

    // Skip dry runs
    if (data?.dryRun) return false;

    // Cooldown after chat change
    if (Date.now() - chatChangedAt < 5000) {
        addDebugLog('info', 'Skipping pipeline (chat just loaded, cooldown active)');
        return false;
    }

    // Only run for new user messages we haven't processed
    const freshChat = SillyTavern.getContext().chat;
    if (!freshChat || freshChat.length === 0) return false;

    let lastUserMsgIndex = -1;
    for (let i = freshChat.length - 1; i >= 0; i--) {
        if (freshChat[i] && freshChat[i].is_user) {
            lastUserMsgIndex = i;
            break;
        }
    }

    if (lastUserMsgIndex < 0) return false;

    if (lastUserMsgIndex <= lastTriggeredUserMsgIndex) {
        addDebugLog('info', `Skipping pipeline (already triggered for user msg index ${lastUserMsgIndex})`);
        return false;
    }

    return true;
}

// --- Core Pipeline Logic (runs inline, blocks generation) ---

async function runPipelineInline(data) {
    const settings = getSettings();
    // Capture-at-write: pin the active profile at pipeline start so that if the
    // user switches chat/profile mid-run, our Agent 3 save still lands in the
    // correct slot (the profile this pipeline was reading from).
    const capturedDbProfile = settings?.activeDbProfile;
    const context = SillyTavern.getContext();
    const chat = context.chat;
    const charName = context.characters?.[context.characterId]?.name || '(unknown)';
    const characterInfo = getCharacterInfo();
    const userPersona = getUserPersona();

    // Mark which user message triggered this
    let lastUserMsgIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].is_user) {
            lastUserMsgIndex = i;
            break;
        }
    }
    lastTriggeredUserMsgIndex = lastUserMsgIndex;

    const startTime = Date.now();
    const recentMessages = getRecentMessages(settings.contextMessages || 5);
    if (recentMessages.length === 0) {
        addDebugLog('info', 'No messages in chat, skipping pipeline');
        return;
    }

    addDebugLog('info', `--- Pipeline inline start (char: ${charName}, msgs: ${recentMessages.length}) ---`);
    for (let i = 0; i < recentMessages.length; i++) {
        const msg = recentMessages[i];
        const role = msg.is_user ? 'USER' : 'AI';
        addDebugLog('info', `  [${i + 1}/${recentMessages.length}] ${role}: ${msg.mes}`);
    }

    showWorkingIndicator();
    updateStatus('running', 'Preparing facts...');

    // Find memory target (last AI message before the new user message)
    // TODO: consider running Agent 3 on the previous USER message as well, not only the AI message,
    // so explicit user disclosures (e.g. "I work at Google") get extracted from the user side directly.
    let memoryTargetIndex = -1;
    for (let i = chat.length - 2; i >= 0; i--) {
        if (chat[i] && !chat[i].is_user && chat[i].mes) {
            memoryTargetIndex = i;
            break;
        }
    }

    const formattedChat = formatMessagesForDraft(recentMessages);

    // --- Run Agent 3 + Agent 1 + Speculative Retrieval in PARALLEL ---
    // SAFETY: We use CMRS (ConnectionManagerRequestService) to call the memory profile
    // directly by ID, WITHOUT switching the active UI profile. This is safe during
    // mid-generation because it doesn't touch the DOM or active connection state.
    updateStatus('running', 'Updating memory + drafting...');
    addDebugLog('info', 'Running Agent 3 (memory) + Agent 1 (draft) + speculative retrieval in parallel...');

    const memoryProfileId = getMemoryProfileId(settings);
    if (memoryProfileId) {
        addDebugLog('info', `Using memory profile "${memoryProfileId}" via CMRS (no profile switching)`);
    } else {
        addDebugLog('info', 'No memory profile configured, agents will use current connection');
    }

    let draftResult = null;
    let memoryResult = null;
    let speculativeRetrieval = null;

    // Start speculative fact retrieval using context keywords (no LLM needed)
    const contextKeywords = extractContextKeywords(recentMessages);
    addDebugLog('info', `Speculative retrieval keywords: ${contextKeywords.join(', ')}`);

    try {
        isInternalCall = true;
        const promises = [];

        // Agent 1: Draft
        promises.push(
            runDraftAgent(formattedChat, characterInfo, userPersona, memoryProfileId)
                .catch(err => ({ draft: '', neededFacts: [], raw: '', error: err.message })),
        );

        // Agent 3: Memory update — single call that sees BOTH the latest user message
        // (just-sent, safe to extract from) AND the N-1 AI message (already committed).
        // This captures user disclosures ("I'm Bernd, I work at Google") that the prior
        // AI-only target missed entirely.
        if (memoryTargetIndex >= 0 && memoryTargetIndex > lastProcessedMessageIndex) {
            const targetMessage = chat[memoryTargetIndex];
            const role = targetMessage.is_user ? 'USER' : 'AI';
            // Find latest user message; pass to Agent 3 alongside the AI target.
            // Skip if it IS the target (avoids duplicating same message).
            const prevUserMsg = (lastUserMsgIndex >= 0 && lastUserMsgIndex !== memoryTargetIndex)
                ? chat[lastUserMsgIndex]?.mes
                : null;
            addDebugLog('info', `Agent 3 target [${role}] msg ${memoryTargetIndex}${prevUserMsg ? ` + user msg ${lastUserMsgIndex}` : ''}: ${targetMessage.mes?.substring(0, 100)}`);

            const databases = await getAllDatabases();
            promises.push(
                runMemoryUpdater(targetMessage.mes, memoryTargetIndex, characterInfo, databases, memoryProfileId, !!targetMessage.is_user, userPersona, prevUserMsg)
                    .catch(err => ({ updates: [], summary: '', raw: '', error: err.message })),
            );
        } else {
            addDebugLog('info', `Agent 3: no new AI message to process (target=${memoryTargetIndex}, last=${lastProcessedMessageIndex})`);
            promises.push(Promise.resolve(null));
        }

        // Speculative retrieval: start fact lookup with context keywords NOW (no LLM wait)
        promises.push(
            retrieveFacts(contextKeywords, [])
                .catch(err => { addDebugLog('info', `Speculative retrieval failed: ${err.message}`); return null; }),
        );

        [draftResult, memoryResult, speculativeRetrieval] = await Promise.all(promises);
    } catch (error) {
        addDebugLog('fail', `Pipeline exception: ${error.message}`);
        hideWorkingIndicator();
        updateStatus('error', 'Pipeline failed');
        return;
    } finally {
        isInternalCall = false;
    }

    // --- Process Agent 3 results ---
    if (memoryResult && !memoryResult.error) {
        addDebugLog('info', `Agent 3: ${memoryResult.updates.length} updates. ${memoryResult.summary}`);
        for (const update of memoryResult.updates) {
            trackUpdate(update);
        }
        lastProcessedMessageIndex = memoryTargetIndex;

        // Check if review popup is due (defer to after generation to avoid blocking)
        if (tickMessageCounter(settings.reviewInterval || 10)) {
            addDebugLog('info', 'Review interval reached, will show popup after generation');
            // Schedule popup after generation completes
            setTimeout(async () => {
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
            }, 2000);
        }
        // Persist to active DB profile immediately after Agent 3 writes
        // Use the profile captured at pipeline start, not whatever is active now —
        // user may have switched chats while Agent 3 was running.
        if (memoryResult.updates.length > 0) {
            await saveCurrentToActiveProfile(capturedDbProfile);
        }
    } else if (memoryResult?.error) {
        addDebugLog('fail', `Agent 3 error: ${memoryResult.error}`);
    }

    // --- Process Agent 1 results + merge with speculative retrieval ---
    // GRACEFUL DEGRADATION: if Agent 1 errored (e.g. provider returned empty completion
    // even after retry), don't abort the whole pipeline — the writer can still inject
    // the retrieved facts with no draft. Memory > nothing.
    if (!draftResult || draftResult.error) {
        addDebugLog('fail', `Agent 1 error: ${draftResult?.error || 'no result'} — continuing with facts only (no draft)`);
        draftResult = { draft: '', neededFacts: [], raw: '' };
    }

    addDebugLog('info', `Agent 1 done: "${draftResult.draft.substring(0, 80)}..."`);
    addDebugLog('info', `Needed facts: ${draftResult.neededFacts.join('; ')}`);

    // --- Fact Retrieval: merge speculative + Agent 1's specific requests ---
    updateStatus('running', 'Merging facts...');

    // Find keywords Agent 1 requested that weren't already in speculative retrieval
    const speculativeKeywordSet = new Set(contextKeywords.map(k => k.toLowerCase()));
    const deltaKeywords = draftResult.neededFacts.filter(k => !speculativeKeywordSet.has(k.toLowerCase()));

    let retrieval = speculativeRetrieval || { facts: [], formatted: '', stats: { primary: 0, secondary: 0, tertiary: 0 } };

    if (deltaKeywords.length > 0) {
        addDebugLog('info', `Delta retrieval for Agent 1 keywords: ${deltaKeywords.join(', ')}`);
        const deltaRetrieval = await retrieveFacts(deltaKeywords, []);

        // Merge: add delta facts not already in speculative results
        const existingKeys = new Set(retrieval.facts.map(r => `${r.category}:${r.fact.key}`));
        for (const fact of deltaRetrieval.facts) {
            const id = `${fact.category}:${fact.fact.key}`;
            if (!existingKeys.has(id)) {
                retrieval.facts.push(fact);
                existingKeys.add(id);
            }
        }

        // Recalculate stats and formatted output
        retrieval.stats = {
            primary: retrieval.facts.filter(r => r.tier === 'primary').length,
            secondary: retrieval.facts.filter(r => r.tier === 'secondary').length,
            tertiary: retrieval.facts.filter(r => r.tier === 'tertiary').length,
        };
        retrieval.formatted = retrieval.facts.length > 0
            ? retrieval.facts.map(({ fact, category }) => {
                const knownBy = (fact.knownBy || []).join(', ');
                const prefix = knownBy ? `[${knownBy}]` : '[everyone]';
                return `${prefix} ${category}: ${fact.value}`;
            }).join('\n')
            : '(No stored facts available)';
    } else {
        addDebugLog('info', 'No delta keywords needed — speculative retrieval covered everything');
    }

    addDebugLog('info', `Retrieved ${retrieval.stats.primary}P/${retrieval.stats.secondary}S/${retrieval.stats.tertiary}T facts`);

    // --- Build & Inject ---
    const injection = buildWriterInjection(draftResult.draft, retrieval.formatted);
    lastInjection = injection; // Cache for swipes/regens
    addDebugLog('info', `Injection ready (${injection.length} chars) in ${Date.now() - startTime}ms`);

    const success = injectMemoryContext(data, injection);
    if (success) {
        addDebugLog('pass', 'Memory context injected into prompt');
        pipelineJustInjected = true; // prevent double-injection on second event fire
    } else {
        addDebugLog('fail', 'Failed to inject memory context');
    }

    hideWorkingIndicator();
    updateStatus('running', 'Generating with facts...');

    // --- Update Summary (Debug Light) ---
    updatePipelineSummary({
        timestamp: new Date().toLocaleTimeString(),
        durationMs: Date.now() - startTime,
        agent1Error: draftResult?.error || null,
        draftSnippet: draftResult?.draft?.substring(0, 100) || '',
        neededFacts: draftResult?.neededFacts || [],
        agent3Skipped: !memoryResult,
        agent3Error: memoryResult?.error || null,
        memoryUpdates: memoryResult?.updates?.length || 0,
        memorySummary: memoryResult?.summary || '',
        stats: retrieval.stats,
        contextKeywords,
        deltaKeywords,
        injectionChars: injection.length,
        injected: success,
    });
}

// --- Main Pipeline Init ---

export function initPipeline() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // THE KEY HOOK: async handler on CHAT_COMPLETION_PROMPT_READY
    // ST's EventEmitter awaits each listener, so this blocks generation until we're done.
    // No abort. No re-trigger. Pipeline runs inline.
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, async (data) => {
        if (shouldRunPipeline(data)) {
            await runPipelineInline(data);
            return;
        }

        // Swipe/regen: re-inject cached facts (no agents, instant)
        // Skip if pipeline just injected in this same generation cycle (double-fire guard)
        if (lastInjection && !isInternalCall && !data?.dryRun && !pipelineJustInjected) {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;

            const success = injectMemoryContext(data, lastInjection);
            if (success) {
                addDebugLog('info', `Swipe/regen: re-injected cached facts (${lastInjection.length} chars)`);
            }
        }
    });

    // Handle text completion APIs (same inline blocking approach)
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, async (data, dryRun) => {
        if (dryRun || isInternalCall) return;
        if (shouldRunPipeline({ dryRun: false })) {
            await runPipelineInline(data);
            return;
        }

        // Swipe/regen: re-inject cached facts
        if (lastInjection && data && typeof data.prompt === 'string') {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;

            data.prompt = lastInjection + '\n\n' + data.prompt;
            addDebugLog('info', `Swipe/regen (text): re-injected cached facts (${lastInjection.length} chars)`);
        }
    });

    // After generation complete: reset status and double-fire guard
    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
        pipelineJustInjected = false;
        updateStatus('idle');
    });

    // Also reset on generation stop/failure (user clicks Stop, or error)
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        pipelineJustInjected = false;
        updateStatus('idle');
    });

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        isInternalCall = false;
        lastProcessedMessageIndex = -1;
        lastInjection = null;
        pipelineJustInjected = false;
        chatChangedAt = Date.now();
        hideWorkingIndicator();
        updateStatus('idle');

        // Initialize lastTriggeredUserMsgIndex to current last user message
        // so only NEW messages (sent after chat load) trigger the pipeline
        const currentChat = SillyTavern.getContext().chat;
        lastTriggeredUserMsgIndex = -1;
        if (currentChat && currentChat.length > 0) {
            for (let i = currentChat.length - 1; i >= 0; i--) {
                if (currentChat[i] && currentChat[i].is_user) {
                    lastTriggeredUserMsgIndex = i;
                    break;
                }
            }
        }

        addDebugLog('info', `Chat changed - state reset (lastUserMsg=${lastTriggeredUserMsgIndex})`);
    });

    console.log('[BFMemory] Pipeline initialized (inline blocking mode)');
}
