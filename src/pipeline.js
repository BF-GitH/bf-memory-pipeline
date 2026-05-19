// BF Memory Pipeline - Main Orchestrator (v2 - Inline Blocking)
// Runs agents during prompt assembly. Never aborts, never re-triggers.
// ST's EventEmitter awaits async handlers, so generation waits for us.

import { runDraftAgent } from './agent-draft.js';
import { buildWriterInjection, injectMemoryContext } from './agent-writer.js';
import { runMemoryUpdater } from './agent-memory.js';
import { retrieveFacts, extractContextKeywords } from './fact-retrieval.js';
import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact } from './database.js';
import { getAgent1ProfileId, getAgent3ProfileId } from './profiler.js';
import { trackUpdate, tickMessageCounter, showReviewPopup } from './review-popup.js';
import { getSettings, addDebugLog, updateStatus, setLastGenerated, setLastInserted, appendLastInserted, saveCurrentToActiveProfile } from './settings.js';

// Pipeline state
let lastProcessedMessageIndex = -1;
let isInternalCall = false; // true when our agents are making LLM calls
let chatChangedAt = 0;
let lastTriggeredUserMsgIndex = -1;
let lastInjection = null; // cached injection text for swipes/regens
let pipelineJustInjected = false; // guards against double-fire of CHAT_COMPLETION_PROMPT_READY
let pipelineCancelled = false; // set true when user clicks Stop; checked before DB writes
let groupSkipToastShown = false; // show-once toast when skipping group chats

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

    // Bumped from 500/300/300 to 2000/1000/1000 — serious roleplay cards have
    // critical lore in the back half of the description. The prior limits made
    // Agent 1 plan replies that contradicted established lore beyond 500 chars.
    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 2000)}`);
    if (char.personality) parts.push(`Personality: ${char.personality.substring(0, 1000)}`);
    if (char.scenario) parts.push(`Scenario: ${char.scenario.substring(0, 1000)}`);
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

    // Skip group chats: characterId in a group = active speaker, not addressee.
    // Writing facts to the speaker's attachments would cross-contaminate characters.
    // Group support is planned for a future release.
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) {
        addDebugLog('info', 'Skipping pipeline (group chat — not supported in this version)');
        if (!groupSkipToastShown && typeof toastr !== 'undefined') {
            toastr.info('BF Memory: group chats not supported — memory pipeline disabled for this chat.', 'BF Memory', { timeOut: 6000 });
            groupSkipToastShown = true;
        }
        return false;
    }

    // Skip our own internal LLM calls (Agent 1, Agent 3)
    if (isInternalCall) {
        addDebugLog('info', 'Skipping pipeline (internal agent call)');
        return false;
    }

    // Skip dry runs, quiet generations (slash commands like /gen, /sys),
    // impersonations (when the user clicks the Impersonate button), and any
    // other non-genuine generation types. Without this, Quick Reply scripts
    // that call /gen would burn billable Agent 1 + Agent 3 LLM calls per fire.
    if (data?.dryRun) return false;
    if (data?.quiet) return false;
    const generationType = data?.type || data?.generationType;
    if (generationType === 'quiet' || generationType === 'impersonate' || generationType === 'continue') {
        addDebugLog('info', `Skipping pipeline (generation type: ${generationType})`);
        return false;
    }

    // Compute lastUserMsgIndex first — needed to distinguish "real user send" from
    // "spurious chat-load event"
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

    // If a genuine NEW user message exists, fire regardless of cooldown.
    // The cooldown only protects against spurious chat-load events (no new user msg).
    const isNewUserMsg = lastUserMsgIndex > lastTriggeredUserMsgIndex;

    if (!isNewUserMsg) {
        if (Date.now() - chatChangedAt < 5000) {
            addDebugLog('info', 'Skipping pipeline (chat just loaded, cooldown, no new user msg)');
        } else {
            addDebugLog('info', `Skipping pipeline (already triggered for user msg index ${lastUserMsgIndex})`);
        }
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
    // Also capture the character's avatar — if the user switches character before
    // Agent 3 finishes, writing facts would land on the wrong character's
    // attachments (database.js keys storage on the LIVE characterId/avatar).
    const capturedCharAvatar = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.avatar || '';
    pipelineCancelled = false; // fresh run, start uncancelled
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
    const recentMessages = getRecentMessages(settings.agent1ContextMessages || 5);
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
        const msg = chat[i];
        if (!msg || msg.is_user || !msg.mes) continue;
        // Skip system messages and extension-injected synthetic messages
        // (Auto-Summarize, Tracker, etc.) — these aren't genuine character utterances
        // and extracting "facts" from them pollutes the DB with second-order data.
        if (msg.is_system) continue;
        if (msg.extra?.type) continue; // 'narrator', 'comment', 'summary', etc.
        memoryTargetIndex = i;
        break;
    }

    const formattedChat = formatMessagesForDraft(recentMessages);

    // --- Run Agent 3 + Agent 1 + Speculative Retrieval in PARALLEL ---
    // SAFETY: We use CMRS (ConnectionManagerRequestService) to call the memory profile
    // directly by ID, WITHOUT switching the active UI profile. This is safe during
    // mid-generation because it doesn't touch the DOM or active connection state.
    updateStatus('running', 'Updating memory + drafting...');
    addDebugLog('info', 'Running Agent 3 (memory) + Agent 1 (draft) + speculative retrieval in parallel...');

    const agent1ProfileId = getAgent1ProfileId(settings);
    const agent3ProfileId = getAgent3ProfileId(settings);
    if (agent1ProfileId || agent3ProfileId) {
        addDebugLog('info', `Profiles: Agent 1 = "${agent1ProfileId || 'default'}", Agent 3 = "${agent3ProfileId || 'default'}"`);
    } else {
        addDebugLog('info', 'No memory profiles configured, agents will use current connection');
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
            runDraftAgent(formattedChat, characterInfo, userPersona, agent1ProfileId)
                .catch(err => ({ draft: '', neededFacts: [], raw: '', error: err.message })),
        );

        // Agent 3: Memory update — single call that sees BOTH the latest user message
        // (just-sent, safe to extract from) AND the N-1 AI message (already committed).
        // This captures user disclosures ("I'm Bernd, I work at Google") that the prior
        // AI-only target missed entirely.
        if (memoryTargetIndex >= 0 && memoryTargetIndex > lastProcessedMessageIndex) {
            const targetMessage = chat[memoryTargetIndex];
            const role = targetMessage.is_user ? 'USER' : 'AI';
            // Gather up to agent3ContextMessages prior messages for richer Agent 3 context.
            // Default = 2 means just the latest user + AI exchange (current behavior preserved).
            const agent3Count = Math.max(1, settings.agent3ContextMessages || 2);
            const agent3StartIdx = Math.max(0, chat.length - agent3Count - 1); // -1 to exclude memoryTargetIndex itself if it's the latest AI msg
            const agent3PriorMessages = [];
            for (let i = agent3StartIdx; i < chat.length; i++) {
                if (i === memoryTargetIndex) continue; // exclude target, it's passed separately
                if (chat[i] && chat[i].mes) {
                    agent3PriorMessages.push({
                        role: chat[i].is_user ? 'USER' : 'CHAR',
                        text: chat[i].mes,
                    });
                }
            }
            addDebugLog('info', `Agent 3 target [${role}] msg ${memoryTargetIndex}${agent3PriorMessages.length ? ` + ${agent3PriorMessages.length} prior msg(s)` : ''}: ${targetMessage.mes?.substring(0, 100)}`);

            const databases = await getAllDatabases();
            promises.push(
                runMemoryUpdater(targetMessage.mes, memoryTargetIndex, characterInfo, databases, agent3ProfileId, !!targetMessage.is_user, userPersona, agent3PriorMessages)
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
        // Always record what Agent 3 proposed (regardless of guards) for the
        // Last Generated tab.
        setLastGenerated(memoryResult.updates || []);
        if (pipelineCancelled) {
            addDebugLog('info', `Pipeline cancelled — discarding ${memoryResult.updates.length} Agent 3 updates`);
            // Mark all as SKIPPED for Last Inserted tab.
            setLastInserted((memoryResult.updates || []).map(u => ({ ...u, status: 'SKIPPED' })));
        } else {
            const currentCharAvatar = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.avatar || '';
            if (currentCharAvatar !== capturedCharAvatar) {
                addDebugLog('fail', `Character changed mid-pipeline (${capturedCharAvatar} -> ${currentCharAvatar}) — discarding ${memoryResult.updates.length} Agent 3 updates to avoid cross-character contamination`);
                if (typeof toastr !== 'undefined') {
                    toastr.warning('BF Memory: extraction discarded — you switched characters mid-generation');
                }
                // Mark all as SKIPPED for Last Inserted tab.
                setLastInserted((memoryResult.updates || []).map(u => ({ ...u, status: 'SKIPPED' })));
            } else {
                addDebugLog('info', `Agent 3: ${memoryResult.updates.length} updates. ${memoryResult.summary}`);
                // Populate Last Inserted tab — use the wasNew flag set by agent-memory.js applyUpdates
                setLastInserted((memoryResult.updates || []).map(u => ({
                    ...u,
                    status: u.wasNew ? 'NEW' : 'UPDATED',
                })));
                for (const update of memoryResult.updates) {
                    trackUpdate(update);
                }
                lastProcessedMessageIndex = memoryTargetIndex;

                // Check if review popup is due (defer to after generation to avoid blocking)
                if (tickMessageCounter(settings.reviewInterval || 10)) {
                    addDebugLog('info', 'Review interval reached, will show popup after generation');
                    // Schedule popup after generation completes
                    // Capture chat ID at schedule time. If the user switches chats during
                    // the 2s delay, the popup must not pop in the wrong chat or write to
                    // the wrong character's DB.
                    const targetChatIdForPopup = SillyTavern.getContext().chatId;
                    setTimeout(async () => {
                        if (SillyTavern.getContext().chatId !== targetChatIdForPopup) {
                            addDebugLog('info', 'Skipping review popup: chat changed since pipeline finished');
                            return;
                        }
                        await showReviewPopup(
                            () => addDebugLog('info', 'User accepted all memory updates'),
                            async (editedItems) => {
                                addDebugLog('info', `User edited ${editedItems.length} items`);
                                appendLastInserted(editedItems.map(i => ({ ...i, status: 'UPDATED' })));
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
            }
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
    if (pipelineCancelled) {
        addDebugLog('info', 'Pipeline cancelled — skipping injection');
        hideWorkingIndicator();
        updateStatus('idle');
        return;
    }
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

    // Also reset on generation stop/failure (user clicks Stop, or error).
    // Set pipelineCancelled so in-flight Agent 3 writes are discarded — we
    // can't abort the CMRS calls themselves (no AbortSignal exposed by ST),
    // but we can refuse to commit their results.
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        pipelineCancelled = true;
        pipelineJustInjected = false;
        hideWorkingIndicator();
        updateStatus('idle');
        addDebugLog('info', 'Generation stopped — in-flight agent writes will be discarded');
    });

    // Recompute lastTriggeredUserMsgIndex when messages are deleted (e.g. /cut).
    // Otherwise the index becomes stale and the next genuine user message
    // (which may now land at the same numeric index as the deleted one) gets
    // silently skipped by the "already triggered" guard.
    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
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
        // Also reset the Agent 3 dedup counter — indices shift after deletion,
        // and the prior "already processed" guard at runPipelineInline (line ~232)
        // would otherwise silently skip new AI replies that happen to land at
        // indices ≤ the stale lastProcessedMessageIndex.
        lastProcessedMessageIndex = -1;
        addDebugLog('info', `Message deleted — reset lastUserMsg=${lastTriggeredUserMsgIndex}, lastProcessedMessageIndex=-1`);
    });

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        isInternalCall = false;
        lastProcessedMessageIndex = -1;
        lastInjection = null;
        pipelineJustInjected = false;
        groupSkipToastShown = false;
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
