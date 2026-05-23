// BF Memory Pipeline - Main Orchestrator (v2 - Inline Blocking)
// Runs agents during prompt assembly. Never aborts, never re-triggers.
// ST's EventEmitter awaits async handlers, so generation waits for us.

import { runDraftAgent } from './agent-draft.js';
import { runFinderAgent, formatChosenFacts } from './agent-finder.js';
import { buildWriterInjection, injectMemoryContext, buildSceneBlock } from './agent-writer.js';
import { runMemoryUpdater } from './agent-memory.js';
import { runReflection } from './agent-reflect.js';
import { retrieveFacts, extractContextKeywords, isFactVisible } from './fact-retrieval.js';
import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact, summarizeKeys, summarizeMenu, collectBranchFacts } from './database.js';
import { getAgent1ProfileId, getAgent3ProfileId, getAgent4ProfileId } from './profiler.js';
import { trackUpdate, tickMessageCounter, showReviewPopup } from './review-popup.js';
import { getSettings, addDebugLog, updateStatus, setLastGenerated, setLastInserted, appendLastInserted, saveCurrentToActiveProfile, setRunTokens, setMainOutputTokens, setScene, getScene, getReflection } from './settings.js';

// Pipeline state
let lastProcessedMessageIndex = -1;
let isInternalCall = false; // true when our agents are making LLM calls
let chatChangedAt = 0;
let lastTriggeredUserMsgIndex = -1;
let lastInjection = null; // cached injection text for swipes/regens
let pipelineJustInjected = false; // guards against double-fire of CHAT_COMPLETION_PROMPT_READY
let pipelineCancelled = false; // set true when user clicks Stop; checked before DB writes
let groupSkipToastShown = false; // show-once toast when skipping group chats
let runRecordedInput = false; // true once setRunTokens fired this generation cycle; gates main-output attribution so swipes don't desync the counters
// Reflection / consolidation: count successful pipeline runs (Agent 3 committed facts).
// When this hits reflectionInterval we schedule ONE consolidation LLM call on the
// post-turn path (after MESSAGE_RECEIVED), off the latency-critical generation path.
let successfulRunsSinceReflection = 0;
let reflectionPending = null; // {runId, charAvatar} captured at the run that armed it; consumed on MESSAGE_RECEIVED
let reflectionInFlight = false; // guard so overlapping turns can't double-fire the pass

/**
 * Count tokens for a chat-completion message array (role wrappers included).
 * Uses ST's local tokenizer — approximate, but same tokenizer both sides so the delta holds.
 */
async function countChatTokens(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const ctx = SillyTavern.getContext();
    try {
        if (ctx.countTokensOpenAIAsync) return await ctx.countTokensOpenAIAsync(arr, true);
        // fallback: sum per-message
        let total = 0;
        for (const m of arr) total += await (ctx.getTokenCountAsync?.(m.content || m.mes || '') ?? 0);
        return total;
    } catch { return 0; }
}

/**
 * Record this run's token metrics for the Tokens tab. Wrapped in try/catch so a
 * tokenizer failure can never abort the pipeline run. Sets runRecordedInput so the
 * MESSAGE_RECEIVED handler only attributes main-model output to a run that actually
 * recorded input this generation cycle (prevents swipe-driven counter desync).
 */
function recordRunTokens({ baselineInput, actualInput, draftResult, memoryResult }) {
    try {
        setRunTokens({
            baselineInput: baselineInput || 0,
            actualInput: actualInput || 0,
            agent1Input: draftResult?.tokensIn || 0,
            agent1Output: draftResult?.tokensOut || 0,
            agent3Input: memoryResult?.tokensIn || 0,
            agent3Output: memoryResult?.tokensOut || 0,
            mainOutput: 0,
        });
        runRecordedInput = true;
    } catch (err) {
        addDebugLog('info', `Token recording failed (non-fatal): ${err.message || err}`);
    }
}

/**
 * FIX #10: Emit a single consolidated per-run SUMMARY debug entry, grouping the
 * run's outcome under a runId: durations, Agent 1 ok/failed, Agent 3 fact
 * NEW/UPDATED/SKIPPED counts, and token numbers. mainOutput is usually not known
 * yet at this point (it lands on MESSAGE_RECEIVED), so it is reported when present.
 */
function logRunSummary({ runId, startTime, baselineInput, actualInput, draftResult, memoryResult, cancelled }) {
    try {
        const duration = Date.now() - startTime;
        const agent1Ok = !!(draftResult && !draftResult.error && draftResult.draft);
        const updates = Array.isArray(memoryResult?.updates) ? memoryResult.updates : [];
        const applied = Array.isArray(memoryResult?.applied)
            ? memoryResult.applied
            : updates.filter(u => u.changed ?? u.wasNew);
        let nNew = 0, nUpd = 0, nSkip = 0;
        for (const u of applied) {
            const st = (u.status || (u.wasNew ? 'NEW' : 'UPDATED')).toUpperCase();
            if (st === 'NEW') nNew++;
            else if (st === 'UPDATED') nUpd++;
            else if (st === 'SKIPPED') nSkip++;
        }
        const a1In = Number(draftResult?.tokensIn) || 0;
        const a1Out = Number(draftResult?.tokensOut) || 0;
        const a3In = Number(memoryResult?.tokensIn) || 0;
        const a3Out = Number(memoryResult?.tokensOut) || 0;
        const bIn = Number(baselineInput) || 0;
        const aIn = Number(actualInput) || 0;
        const mainOut = Number(memoryResult?.mainOutput) || 0; // usually 0 here
        const netIn = (aIn + a1In + a3In) - bIn;
        addDebugLog('info',
            `[${runId}] SUMMARY ${cancelled ? '(cancelled) ' : ''}` +
            `dur=${duration}ms | Agent1=${agent1Ok ? 'ok' : 'failed'} | ` +
            `Agent3 NEW=${nNew} UPDATED=${nUpd} SKIPPED=${nSkip} | ` +
            `tokens: baselineIn=${bIn} actualIn=${aIn} a1(in/out)=${a1In}/${a1Out} ` +
            `a3(in/out)=${a3In}/${a3Out}${mainOut ? ` mainOut=${mainOut}` : ''} net=${netIn >= 0 ? '+' : ''}${netIn}`,
        );
    } catch (err) {
        addDebugLog('info', `Run summary failed (non-fatal): ${err.message || err}`);
    }
}

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

    // Determine what Agent 3 *would* target this turn (last genuine AI message),
    // mirroring the loop in runPipelineInline. We gate on the per-message
    // bf_mem_processed flag rather than relying solely on the monotonic
    // lastTriggeredUserMsgIndex — that index only advances on a successful run and
    // never rewinds on swipe/regenerate, so once it raced ahead of reality every
    // later turn was silently skipped forever.
    const memoryTargetIndex = findMemoryTargetIndex(freshChat);

    // "Unprocessed work exists" = either the new user message or the AI target
    // still lacks bf_mem_processed. This is the source of truth for whether
    // Agent 3 has anything to do.
    const userUnprocessed = !freshChat[lastUserMsgIndex]?.extra?.bf_mem_processed;
    const targetUnprocessed = memoryTargetIndex >= 0 && !freshChat[memoryTargetIndex]?.extra?.bf_mem_processed;
    const hasUnprocessedWork = userUnprocessed || targetUnprocessed;

    // If a genuine NEW user message exists, fire regardless of cooldown.
    // The cooldown only protects against spurious chat-load events (no new user msg).
    const isNewUserMsg = lastUserMsgIndex > lastTriggeredUserMsgIndex;

    if (!isNewUserMsg && !hasUnprocessedWork) {
        if (Date.now() - chatChangedAt < 5000) {
            addDebugLog('info', 'Skipping pipeline (chat just loaded, cooldown, no new user msg)');
        } else {
            addDebugLog('info', `Skipping pipeline (already processed for user msg index ${lastUserMsgIndex})`);
        }
        return false;
    }

    // Cooldown only suppresses spurious chat-load events. If there's genuinely
    // unprocessed work but it's NOT a new user message (e.g. after a swipe reset
    // the index), still respect the load cooldown to avoid firing on chat open.
    if (!isNewUserMsg && hasUnprocessedWork && Date.now() - chatChangedAt < 5000) {
        addDebugLog('info', 'Skipping pipeline (chat just loaded, cooldown — deferring unprocessed work)');
        return false;
    }

    return true;
}

/**
 * Find the index of the last genuine AI message Agent 3 would target.
 * Mirrors the scan in runPipelineInline so shouldRunPipeline and the run agree.
 * Returns -1 if none.
 */
function findMemoryTargetIndex(chat) {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 2; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user || !msg.mes) continue;
        if (msg.is_system) continue;
        if (msg.extra?.type) continue;
        return i;
    }
    return -1;
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
    // FIX #10: short per-run id to group this run's log entries + the SUMMARY line.
    const runId = `R${startTime.toString(36).slice(-5)}`;
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

    // Find memory target (last AI message before the new user message).
    // Uses the same scan as shouldRunPipeline (findMemoryTargetIndex) so the
    // gate and the run never disagree about which message is the target.
    // Skips system messages and extension-injected synthetic messages
    // (Auto-Summarize, Tracker, etc.) — these aren't genuine character utterances
    // and extracting "facts" from them pollutes the DB with second-order data.
    const memoryTargetIndex = findMemoryTargetIndex(chat);

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

    // Load databases once up front — reused for both Agent 1's fact inventory and
    // Agent 3's existing-DB context, avoiding a duplicate fetch.
    const databases = await getAllDatabases();
    // Compact keys-only inventory (Category/key, no values) — kept for the #Needed_Facts
    // fallback path so deterministic retrieval can resolve exact keys by identity.
    const factInventory = summarizeKeys(databases);
    // STAGE 1 menu: compact KIND×SUBJECT map (counts, NO values) Agent 1 picks branches from.
    const factMenu = summarizeMenu(databases);
    addDebugLog('info', `Fact inventory for Agent 1: ${factInventory ? factInventory.split('\n').length + ' keys' : 'empty'}; menu: ${factMenu ? factMenu.split('\n').length + ' categories' : 'empty'}`);

    try {
        isInternalCall = true;
        const promises = [];

        // Agent 1: Draft + STAGE 1 menu picker (returns #Branches)
        promises.push(
            runDraftAgent(formattedChat, characterInfo, userPersona, agent1ProfileId, factInventory, factMenu)
                .catch(err => ({ draft: '', branches: [], neededFacts: [], raw: '', error: err.message })),
        );

        // Agent 3: Memory update — single call that sees BOTH the latest user message
        // (just-sent, safe to extract from) AND the N-1 AI message (already committed).
        // This captures user disclosures ("I'm Bernd, I work at Google") that the prior
        // AI-only target missed entirely.
        // Gate on the per-message bf_mem_processed flag (source of truth) rather than
        // the monotonic lastProcessedMessageIndex, which never rewound on swipe/regen
        // and could permanently wall off later turns once it raced ahead.
        const targetAlreadyProcessed = memoryTargetIndex >= 0
            && !!chat[memoryTargetIndex]?.extra?.bf_mem_processed;
        if (memoryTargetIndex >= 0 && !targetAlreadyProcessed) {
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

            // Reuse the databases loaded above for Agent 1's inventory.
            promises.push(
                runMemoryUpdater(targetMessage.mes, memoryTargetIndex, characterInfo, databases, agent3ProfileId, !!targetMessage.is_user, userPersona, agent3PriorMessages, lastUserMsgIndex)
                    .catch(err => ({ updates: [], summary: '', raw: '', error: err.message })),
            );
        } else {
            addDebugLog('info', `Agent 3: target already processed or none (target=${memoryTargetIndex}, processed=${targetAlreadyProcessed})`);
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
                // Last Inserted = only the facts that ACTUALLY changed stored state
                // (NEW or UPDATED), with the status applyUpdates computed. This is the
                // committed subset — distinct from Last Generated (full proposed set),
                // fixing the "both panels identical" bug (FIX #5). Fall back to deriving
                // the changed subset from .updates if .applied is absent (older shape).
                const committed = Array.isArray(memoryResult.applied)
                    ? memoryResult.applied
                    : (memoryResult.updates || []).filter(u => u.changed ?? u.wasNew).map(u => ({
                        ...u,
                        status: u.status || (u.wasNew ? 'NEW' : 'UPDATED'),
                    }));
                addDebugLog('info', `Agent 3: ${memoryResult.updates.length} proposed, ${committed.length} committed. ${memoryResult.summary}`);
                setLastInserted(committed);
                for (const update of memoryResult.updates) {
                    trackUpdate(update);
                }
                lastProcessedMessageIndex = memoryTargetIndex;

                // Mark the target AI message as processed so the per-message
                // icon (and "Run on full chat" skip-already-done) can see it.
                if (chat[memoryTargetIndex]) {
                    chat[memoryTargetIndex].extra = { ...(chat[memoryTargetIndex].extra || {}), bf_mem_processed: true };
                }
                // If we also processed the latest user message via prevUserMsg / priorMessages,
                // mark it too (Agent 3 saw it in the same call).
                if (lastUserMsgIndex >= 0 && lastUserMsgIndex !== memoryTargetIndex && chat[lastUserMsgIndex]) {
                    chat[lastUserMsgIndex].extra = { ...(chat[lastUserMsgIndex].extra || {}), bf_mem_processed: true };
                }
                // Persist to chat .jsonl
                SillyTavern.getContext().saveChatDebounced?.();

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
        draftResult = { draft: '', branches: [], neededFacts: [], scene: null, raw: '' };
    }
    // Older Agent 1 result shapes (or partial parses) may lack branches/neededFacts.
    if (!Array.isArray(draftResult.branches)) draftResult.branches = [];
    if (!Array.isArray(draftResult.neededFacts)) draftResult.neededFacts = [];

    addDebugLog('info', `Agent 1 done: "${draftResult.draft.substring(0, 80)}..."`);
    addDebugLog('info', `Branches picked: ${draftResult.branches.join('; ') || '(none)'}`);
    addDebugLog('info', `Needed facts (fallback): ${draftResult.neededFacts.join('; ')}`);

    // --- Scene card: persist Agent 1's #SCENE parse (no extra LLM call) ---
    // Only when enabled, the run wasn't cancelled, and the character didn't change
    // mid-run (same guard class as Agent 3 writes — scene is per-chat/character state).
    if (settings.sceneCardEnabled && !pipelineCancelled && draftResult.scene) {
        const currentCharAvatar = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.avatar || '';
        if (currentCharAvatar === capturedCharAvatar) {
            setScene(draftResult.scene, runId);
            const sc = getScene();
            if (sc) {
                addDebugLog('info', `Scene updated: loc="${sc.location}" present=[${(sc.present || []).join(', ')}] goals=${(sc.goals || []).length} beats=${(sc.beats || []).length}`);
            }
        } else {
            addDebugLog('info', 'Scene update skipped (character changed mid-pipeline)');
        }
    }

    // --- Fact Retrieval: STAGE 2 (detail finder) with deterministic fallback ---
    updateStatus('running', 'Selecting facts...');

    // DETERMINISTIC FALLBACK builder (FALLBACK requirement). Used when the finder is
    // disabled, errors, times out, or returns nothing. Reuses the existing speculative +
    // delta-keyword merge so behavior matches the pre-two-stage pipeline, and ALWAYS folds
    // in every active Unsorted fact so a failed detail pass can never blank that catch-all.
    // A failed detail pass must never blank memory.
    const buildDeterministicRetrieval = async () => {
        const speculativeKeywordSet = new Set(contextKeywords.map(k => k.toLowerCase()));
        const deltaKeywords = draftResult.neededFacts.filter(k => !speculativeKeywordSet.has(k.toLowerCase()));
        const det = speculativeRetrieval || { facts: [], formatted: '', stats: { primary: 0, secondary: 0, tertiary: 0 } };
        if (deltaKeywords.length > 0) {
            addDebugLog('info', `Delta retrieval for Agent 1 keywords: ${deltaKeywords.join(', ')}`);
            const deltaRetrieval = await retrieveFacts(deltaKeywords, []);
            const existingKeys = new Set(det.facts.map(r => `${r.category}:${r.fact.key}`));
            for (const fact of deltaRetrieval.facts) {
                const id = `${fact.category}:${fact.fact.key}`;
                if (!existingKeys.has(id)) { det.facts.push(fact); existingKeys.add(id); }
            }
        } else {
            addDebugLog('info', 'No delta keywords needed — speculative retrieval covered everything');
        }
        // ALWAYS include active Unsorted facts (visibility-filtered), even on the fallback path.
        const existingKeys = new Set(det.facts.map(r => `${r.category}:${r.fact.key}`));
        for (const { fact, category } of collectBranchFacts(databases, ['Unsorted'])) {
            const id = `${category}:${fact.key}`;
            if (!existingKeys.has(id) && isFactVisible(fact)) {
                det.facts.push({ fact, category, tier: 'primary' });
                existingKeys.add(id);
            }
        }
        det.stats = {
            primary: det.facts.filter(r => r.tier === 'primary').length,
            secondary: det.facts.filter(r => r.tier === 'secondary').length,
            tertiary: det.facts.filter(r => r.tier === 'tertiary').length,
        };
        det.formatted = det.facts.length > 0
            ? det.facts.map(({ fact, category }) => {
                const knownBy = (fact.knownBy || []).join(', ');
                const prefix = knownBy ? `[${knownBy}]` : '[everyone]';
                return `${prefix} ${category}/${fact.key} = ${fact.value}`;
            }).join('\n')
            : '(No stored facts available)';
        return det;
    };

    let retrieval = null;
    const wantFinder = settings.useFinderAgent !== false; // default true
    if (wantFinder) {
        // STAGE 2: gather the FULL active facts under Agent 1's picked branches PLUS, always,
        // every active Unsorted fact (collectBranchFacts folds Unsorted in unconditionally).
        // Visibility-filter defensively (the finder must never see a hidden fact).
        const candidatesAll = collectBranchFacts(databases, draftResult.branches);
        const candidates = candidatesAll.filter(({ fact }) => isFactVisible(fact));
        addDebugLog('info', `STAGE 2: ${candidates.length} candidate fact(s) from ${draftResult.branches.length} branch pick(s) + Unsorted`);
        try {
            const finder = await runFinderAgent({
                candidates,
                draft: draftResult.draft,
                recentChat: formattedChat,
                characterInfo,
                userPersona,
                profileId: getAgent4ProfileId(settings),
            });
            // Use finder results when it succeeded AND chose something. Empty/error => fall back.
            if (finder && !finder.error && Array.isArray(finder.facts) && finder.facts.length > 0) {
                const facts = finder.facts.map(({ fact, category }) => ({ fact, category, tier: 'primary' }));
                retrieval = {
                    facts,
                    formatted: finder.formatted || formatChosenFacts(finder.facts),
                    stats: { primary: facts.length, secondary: 0, tertiary: 0 },
                };
                addDebugLog('info', `STAGE 2 finder chose ${facts.length} fact(s) for injection`);
            } else {
                addDebugLog('info', `STAGE 2 finder ${finder?.error ? `errored (${finder.error})` : 'returned nothing'} — falling back to deterministic retrieval`);
            }
        } catch (finderErr) {
            addDebugLog('fail', `STAGE 2 finder threw (${finderErr.message || finderErr}) — falling back to deterministic retrieval`);
        }
    } else {
        addDebugLog('info', 'Finder agent disabled (useFinderAgent=false) — using deterministic retrieval');
    }

    // FALLBACK: finder disabled, errored, or empty → deterministic retrieval (over Agent 1's
    // keyword requests + speculative) which ALWAYS still includes active Unsorted facts.
    if (!retrieval) {
        retrieval = await buildDeterministicRetrieval();
    }

    addDebugLog('info', `Retrieved ${retrieval.stats.primary}P/${retrieval.stats.secondary}S/${retrieval.stats.tertiary}T facts`);

    // --- Build & Inject ---
    // We compute the baseline input (pre-injection) up front so token metrics can be
    // recorded even when the run is cancelled before injection — the agent LLM calls
    // already happened and incurred real cost, so they must still be attributed.
    const baselineArr = data.chat || data.messages;
    let baselineInput = 0;
    try { baselineInput = await countChatTokens(baselineArr); } catch { baselineInput = 0; }

    if (pipelineCancelled) {
        addDebugLog('info', 'Pipeline cancelled — skipping injection');
        // Still record the agent token cost (input == baseline since we didn't inject)
        // so the Tokens tab stays in sync and the per-cycle main-output gate is armed.
        recordRunTokens({ baselineInput, actualInput: baselineInput, draftResult, memoryResult });
        logRunSummary({ runId, startTime, baselineInput, actualInput: baselineInput, draftResult, memoryResult, cancelled: true });
        hideWorkingIndicator();
        updateStatus('idle');
        return;
    }
    // Always-on scene block: injected EVERY turn (above the facts) whenever enabled
    // and a scene exists — independent of whether any facts were retrieved.
    let sceneBlock = '';
    if (settings.sceneCardEnabled) {
        const scene = getScene();
        sceneBlock = buildSceneBlock(scene, settings.sceneCardMaxTokens || 150);
        if (sceneBlock) addDebugLog('info', `Scene block injected (${sceneBlock.length} chars): ${sceneBlock}`);
    }

    // Reflection "story so far": injected BELOW the scene card, ABOVE the facts, behind its
    // own enable + small token cap. Optional — when off (or no summary yet) nothing changes.
    if (settings.reflectionEnabled && settings.reflectionInject) {
        const refl = getReflection();
        if (refl?.summary) {
            const charBudget = Math.max(40, Math.floor((Number(settings.reflectionMaxTokens) || 200) * 4));
            let story = refl.summary;
            if (story.length > charBudget) story = story.slice(0, charBudget - 1).trimEnd() + '…';
            const storyBlock = `[Story so far] ${story}`;
            // Append below the scene block (both sit above the facts in buildWriterInjection).
            sceneBlock = sceneBlock ? `${sceneBlock}\n\n${storyBlock}` : storyBlock;
            addDebugLog('info', `Reflection summary injected (${storyBlock.length} chars)`);
        }
    }

    const injection = buildWriterInjection(draftResult.draft, retrieval.formatted, sceneBlock);
    lastInjection = injection; // Cache for swipes/regens (scene block included)

    // Optional: trim main-model chat history to last N messages — relies on facts to
    // replace older context. Default 0 = don't trim (main model sees full chat as usual).
    // Setting > 0 hides older messages so the model focuses on recent exchange + facts.
    const agent2Limit = Math.max(0, settings.agent2ContextMessages || 0);
    addDebugLog('info', `Injection ready (${injection.length} chars${agent2Limit ? `, trimming chat to last ${agent2Limit}` : ''}) in ${Date.now() - startTime}ms`);

    const success = injectMemoryContext(data, injection, { trimToLast: agent2Limit });

    // Token comparison: count main-model input AFTER trim+inject.
    const actualArr = data.chat || data.messages;
    let actualInput = baselineInput;
    try { actualInput = await countChatTokens(actualArr); } catch { actualInput = baselineInput; }

    // Record token metrics for the Tokens tab (agent counts come from result objects)
    recordRunTokens({ baselineInput, actualInput, draftResult, memoryResult });
    // FIX #10: consolidated per-run summary (after token recording — values in scope).
    logRunSummary({ runId, startTime, baselineInput, actualInput, draftResult, memoryResult, cancelled: false });

    if (success) {
        addDebugLog('pass', 'Memory context injected into prompt');
        pipelineJustInjected = true; // prevent double-injection on second event fire
    } else {
        addDebugLog('fail', 'Failed to inject memory context');
    }

    // --- Reflection / consolidation trigger (cost-aware, off the latency-critical path) ---
    // Count this as a successful run and, on hitting the interval, ARM a reflection pass to
    // run AFTER the reply lands (MESSAGE_RECEIVED). We never run it inline here — it would
    // add a second LLM call to the pre-generation blocking path. Gated by enable; the
    // not-cancelled/not-group/not-internal checks already gate this whole function.
    if (settings.reflectionEnabled) {
        successfulRunsSinceReflection++;
        const interval = Math.max(4, settings.reflectionInterval || 12);
        if (successfulRunsSinceReflection >= interval && !reflectionPending && !reflectionInFlight) {
            reflectionPending = { runId, charAvatar: capturedCharAvatar, profileId: getAgent3ProfileId(settings), characterInfo, userPersona };
            addDebugLog('info', `[${runId}] Reflection armed (will run after reply; ${successfulRunsSinceReflection}/${interval} runs)`);
        }
    }

    hideWorkingIndicator();
    updateStatus('running', 'Generating with facts...');
}

/**
 * Run an armed reflection pass. Called from MESSAGE_RECEIVED so it never blocks the
 * latency-critical pre-generation path. Fully guarded: skips if disabled, cancelled,
 * in a group chat, the character changed since arming, or another pass is in flight.
 * Wrapped in try/catch — a reflection failure must never break the pipeline.
 */
async function maybeRunReflection() {
    const pending = reflectionPending;
    if (!pending || reflectionInFlight) return;
    const settings = getSettings();
    if (!settings || !settings.enabled || !settings.reflectionEnabled) { reflectionPending = null; return; }
    if (pipelineCancelled) { reflectionPending = null; return; }
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) { reflectionPending = null; return; }
    // Character-changed guard (same class as Agent 3 writes): don't synthesize observations
    // onto the wrong character's attachments if the user switched mid-session.
    const currentCharAvatar = ctx.characters?.[ctx.characterId]?.avatar || '';
    if (currentCharAvatar !== pending.charAvatar) {
        addDebugLog('info', `[${pending.runId}] Reflection skipped (character changed since arming)`);
        reflectionPending = null;
        return;
    }

    reflectionPending = null;
    reflectionInFlight = true;
    successfulRunsSinceReflection = 0; // reset the cadence regardless of outcome
    isInternalCall = true; // ensure the reflection LLM call can't re-trigger the pipeline
    try {
        updateStatus('running', 'Reflecting (consolidating memory)...');
        await runReflection({
            runId: pending.runId,
            scene: getScene(),
            prevReflection: getReflection(),
            characterInfo: pending.characterInfo || '',
            userPersona: pending.userPersona || '',
            profileId: pending.profileId || null,
        });
        // Persist any observation facts the pass wrote to the active DB profile.
        try { await saveCurrentToActiveProfile(settings.activeDbProfile); } catch { /* best-effort */ }
    } catch (err) {
        addDebugLog('fail', `Reflection pass failed (non-fatal): ${err.message || err}`);
    } finally {
        reflectionInFlight = false;
        isInternalCall = false;
        updateStatus('idle');
    }
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
    eventSource.on(eventTypes.MESSAGE_RECEIVED, async () => {
        pipelineJustInjected = false;
        // Clear the cancellation flag now that this generation cycle finished.
        // Without this, a Stop on one turn left pipelineCancelled=true and poisoned
        // every later turn whose pipeline run was skipped (so it never reset at the
        // top of runPipelineInline).
        pipelineCancelled = false;
        updateStatus('idle');

        // Count the main model's reply tokens for the Tokens tab — BUT only attribute
        // it to a run that actually recorded input this cycle. Swipes/regens fire
        // MESSAGE_RECEIVED without a fresh pipeline run, so unconditionally adding
        // output desynced input vs output counts over a long session.
        try {
            if (runRecordedInput) {
                const ctx = SillyTavern.getContext();
                const lastMsg = ctx.chat?.[ctx.chat.length - 1];
                if (lastMsg && !lastMsg.is_user && lastMsg.mes) {
                    const n = await (ctx.getTokenCountAsync?.(lastMsg.mes) ?? 0);
                    setMainOutputTokens(n);
                }
            }
        } catch { /* ignore */ }
        // One run = one input record = one output attribution. Disarm until the next run.
        runRecordedInput = false;

        // Reflection / consolidation: now that the reply has landed, run an armed pass
        // off the latency-critical path. Fully self-guarded + try/catch'd internally.
        maybeRunReflection();
    });

    // Also reset on generation stop/failure (user clicks Stop, or error).
    // Set pipelineCancelled so in-flight Agent 3 writes are discarded — we
    // can't abort the CMRS calls themselves (no AbortSignal exposed by ST),
    // but we can refuse to commit their results.
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        pipelineCancelled = true;
        pipelineJustInjected = false;
        // Disarm output attribution: no main reply will land for this stopped cycle.
        runRecordedInput = false;
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

    // Reset on swipe/regenerate. The monotonic lastTriggeredUserMsgIndex /
    // lastProcessedMessageIndex never rewound on swipe, so once they raced ahead of
    // the chat's true state every later turn was silently skipped forever (FIX #1).
    // Rewind both indices to the current chat and clear the swiped AI message's
    // bf_mem_processed flag — its content just changed, so any prior extraction is
    // stale and the next genuine turn must be allowed to re-process it.
    eventSource.on(eventTypes.MESSAGE_SWIPED, (mesId) => {
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
        lastProcessedMessageIndex = -1;
        // Invalidate extraction on the swiped message (content replaced).
        const swipedIdx = Number.isInteger(mesId) ? mesId : (currentChat ? currentChat.length - 1 : -1);
        if (currentChat && currentChat[swipedIdx]?.extra?.bf_mem_processed) {
            currentChat[swipedIdx].extra.bf_mem_processed = false;
            SillyTavern.getContext().saveChatDebounced?.();
        }
        addDebugLog('info', `Message swiped (idx ${swipedIdx}) — reset trigger indices, cleared bf_mem_processed`);
    });

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        isInternalCall = false;
        lastProcessedMessageIndex = -1;
        lastInjection = null;
        pipelineJustInjected = false;
        groupSkipToastShown = false;
        chatChangedAt = Date.now();
        // Reflection cadence is per-chat: reset the counter and drop any armed pass so a
        // chat switch can't fire a consolidation against the new chat using old context.
        successfulRunsSinceReflection = 0;
        reflectionPending = null;
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
