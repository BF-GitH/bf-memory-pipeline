// BF Memory Pipeline - Main Orchestrator (v2 - Inline Blocking)
// Runs agents during prompt assembly. Never aborts, never re-triggers.
// ST's EventEmitter awaits async handlers, so generation waits for us.

import { runDraftAgent } from './agent-draft.js';
import { runFinderAgent, formatChosenFacts } from './agent-finder.js';
import { buildWriterInjection, injectMemoryContext, buildSceneBlock } from './agent-writer.js';
import { runMemoryUpdater } from './agent-memory.js';
import { runReflection } from './agent-reflect.js';
import { retrieveFacts, extractContextKeywords, isFactVisible, expandLinks } from './fact-retrieval.js';
import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact, summarizeKeys, summarizeMenu, collectBranchFacts, deriveSubject, deriveScope } from './database.js';
import { getAgent1ProfileId, getAgent3ProfileId, getAgent4ProfileId } from './profiler.js';
import { trackUpdate, tickMessageCounter, showReviewPopup } from './review-popup.js';
import { getSettings, addDebugLog, updateStatus, setLastGenerated, setLastInserted, appendLastInserted, saveCurrentToActiveProfile, setRunTokens, setMainOutputTokens, addAgent3Tokens, setScene, getScene, reloadEntitiesUI } from './settings.js';
import { detectAndRecord, showEntityPopup } from './agent-entities.js';

// Pipeline state
let lastProcessedMessageIndex = -1;
let isInternalCall = false; // true when our agents are making LLM calls
let chatChangedAt = 0;
let lastTriggeredUserMsgIndex = -1;
let lastInjection = null; // cached injection text for the FIRST generation (scene + facts + Agent-1 draft)
// Phase 3b / FIX #8a: a SECOND cached injection with the SAME scene + facts but WITHOUT
// Agent 1's draft scene-direction. Agent 1's draft is "what should happen next" planned
// for the ORIGINAL roll; reusing it verbatim on a divergent swipe/regen mis-steers a very
// different re-roll. So swipes/regens re-inject the stable facts + scene from here and DROP
// the stale draft (facts are safe to reuse; the draft is not). Kept fast: no agent re-run.
let lastInjectionNoDraft = null;
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
// Phase 3b: Agent 3 (memory extraction) now runs on MESSAGE_RECEIVED, off the blocking
// path. This guard prevents two MESSAGE_RECEIVED events (e.g. a fast follow-up turn) from
// launching overlapping extractions that race on the same DB save.
let memoryExtractionInFlight = false;
// Character registry: count successful memory-extraction runs and, every
// characterCheckInterval, run a deterministic scan for newly-seen NAMED entities off the
// critical path (after the post-reply extraction has committed its facts). Mirrors the
// reflection cadence but is far cheaper (no LLM call) and only opens a popup when there
// are unclassified candidates. Per-chat: reset on CHAT_CHANGED.
let runsSinceEntityCheck = 0;
let entityCheckInFlight = false;
// FIX #8b / FIX #12: single debounce timer for SETTLE extraction. BOTH paths feed it now:
//   - Generating a NEW swipe fires MESSAGE_RECEIVED (the AI reply landed), and
//   - Navigating LEFT/RIGHT onto an ALREADY-GENERATED swipe fires MESSAGE_SWIPED (no
//     MESSAGE_RECEIVED).
// Previously MESSAGE_RECEIVED extracted EAGERLY (one ~7k-token Agent-3 call per generated
// swipe), so spinning 4 swipes before settling cost up to 4× Agent 3. Now MESSAGE_RECEIVED
// also SCHEDULES the debounced extraction instead of running it inline: rapid regeneration /
// navigation keeps resetting the timer, so the expensive extraction runs ONCE on the SETTLED
// (kept) swipe rather than once per mid-swipe roll. A normal single-reply turn (no swiping)
// schedules once and, with nothing resetting it, extracts promptly after the short window —
// still exactly one extraction per turn. The reflection + entity-check passes are chained to
// run AFTER the (single) settled extraction completes. Cleared on chat change.
let swipeSettleTimer = null;
// Debounce window before a settled extraction fires. Short enough that a normal turn extracts
// promptly, long enough that back-to-back swipe regenerations / navigation coalesce into one.
const SETTLE_EXTRACTION_DELAY_MS = 1800;

/**
 * FIX #12: schedule the post-reply extraction on the shared settle-debounce instead of
 * running it eagerly. Resets any pending timer so only the FINAL settled message extracts
 * (a heavily-swiped turn extracts ~once, not once per swipe). After extraction completes we
 * chain the armed reflection pass and the entity-check, which previously ran right after the
 * eager MESSAGE_RECEIVED extraction — keeping their ordering relative to the kept content.
 * Fully try/catch'd: a scheduling/extraction failure must never break the turn.
 *
 * @param {string} reason - short tag for the debug log (e.g. 'message-received', 'swipe').
 * @param {boolean} [runPostPasses=false] - when true, chain maybeRunReflection +
 *   maybeRunEntityCheck after the extraction (the MESSAGE_RECEIVED path owns those passes).
 */
function scheduleSettleExtraction(reason, runPostPasses = false) {
    try {
        if (swipeSettleTimer) {
            clearTimeout(swipeSettleTimer);
            addDebugLog('info', `Agent 3 extraction coalesced (${reason}) — resetting settle timer, deferring until settled`);
        } else {
            addDebugLog('info', `Agent 3 extraction deferred (${reason}) — will run after ${SETTLE_EXTRACTION_DELAY_MS}ms settle window`);
        }
        swipeSettleTimer = setTimeout(async () => {
            swipeSettleTimer = null;
            try {
                await runMemoryExtraction();
                if (runPostPasses) {
                    // Reflection / consolidation + character-registry detection, off the
                    // critical path. Self-guarded + try/catch'd internally.
                    maybeRunReflection();
                    maybeRunEntityCheck();
                }
            } catch (err) {
                addDebugLog('fail', `Settle extraction failed (non-fatal): ${err.message || err}`);
            }
        }, SETTLE_EXTRACTION_DELAY_MS);
    } catch (err) {
        addDebugLog('fail', `Scheduling settle extraction failed (non-fatal): ${err.message || err}`);
    }
}

/**
 * CHARACTER-TAG FILTER for the Stage-2 finder candidate gather (3-layer model). The branch
 * picks Agent 1 makes are character-AGNOSTIC (`Category` / `Category/aspect`), so
 * collectBranchFacts hands back EVERY character's facts living in those aspects. That is the
 * cost this model exists to avoid: when Agent 1 named the focus character(s) in #Focus, we
 * narrow the candidates to facts that actually concern those people PLUS general/world facts,
 * and drop facts tagged to OTHER, unrelated characters in the same aspect.
 *
 * Keep a candidate when ANY holds:
 *   - no focus characters were named (general moment) — keep everything (no narrowing);
 *   - the fact is in the Unsorted catch-all (always kept, per the model);
 *   - the fact is NOT character-scoped (place/event/world facts are general context: a place
 *     or event must stay recallable independent of any character — see link-following);
 *   - the fact carries NO character tag (empty `involved` AND no character `subject`) — a
 *     general/shared fact with no specific owner;
 *   - the fact's `involved` participants OR its `subject` include a focus character.
 * Otherwise (a character-scoped fact owned by / about ONLY non-focus characters) drop it.
 *
 * Names are compared case-insensitively; `involved` holds clean names (the `@` sigil is
 * stripped at write time) and #Focus names have any leading `@` stripped at parse time.
 * @param {Array<{fact: Object, category: string}>} candidates
 * @param {string[]} focus - focus character names from Agent 1's #Focus (may be empty)
 * @returns {Array<{fact: Object, category: string}>}
 */
function filterCandidatesByFocus(candidates, focus) {
    const focusSet = new Set((focus || []).map(f => String(f || '').trim().toLowerCase()).filter(Boolean));
    if (focusSet.size === 0) return candidates; // general moment — no character narrowing
    return candidates.filter(({ fact, category }) => {
        if (String(category || '').toLowerCase() === 'unsorted') return true; // catch-all always kept
        // Place/event/world facts are general context, not owned by a single character.
        if (deriveScope(fact) !== 'character') return true;
        const involved = Array.isArray(fact.involved)
            ? fact.involved.map(p => String(p || '').trim().toLowerCase()).filter(Boolean)
            : [];
        const subject = deriveSubject(fact); // already lowercased
        // No character tag at all -> general/shared fact, keep it.
        if (involved.length === 0 && !subject) return true;
        // Keep when any participant or the subject is one of the focus characters.
        if (subject && focusSet.has(subject)) return true;
        for (const p of involved) if (focusSet.has(p)) return true;
        return false; // character-scoped fact about ONLY non-focus characters -> drop
    });
}

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
 * Per-message char limit is configurable (draftMsgCharLimit, default 2000) — the old
 * hard 500-char clip truncated Agent 1's view of recent messages, hiding the back half
 * of longer turns. 2000 matches the character-card limit bumped elsewhere. Clamped in
 * validateSettings so a bad value can't blank or explode the prompt.
 */
function formatMessagesForDraft(messages) {
    const limit = Math.max(200, getSettings()?.draftMsgCharLimit || 2000);
    return messages.map((msg, idx) => {
        const role = msg.is_user ? 'USER' : 'AI';
        return `Message ${idx + 1}: ${role}: ${msg.mes.substring(0, limit)}`;
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
 * Mirrors the scan in shouldRunPipeline so the gate and the run agree.
 * Returns -1 if none.
 *
 * @param {Array} chat
 * @param {boolean} [includeLast=false] - When false (PRE-generation, the historical
 *   behaviour) the scan starts at chat.length-2 because the last message is the
 *   just-sent USER message, not an AI reply. When true (POST-reply, the new Agent 3
 *   home on MESSAGE_RECEIVED) the scan starts at chat.length-1 so the just-received
 *   AI reply itself is the target — extracting the reply that just landed is exactly
 *   what we want now that Agent 3 runs after generation.
 */
function findMemoryTargetIndex(chat, includeLast = false) {
    if (!Array.isArray(chat)) return -1;
    for (let i = (includeLast ? chat.length - 1 : chat.length - 2); i >= 0; i--) {
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
    // Capture-at-write: pin the active profile at pipeline start. Agent 3 (memory
    // extraction) now runs POST-reply on MESSAGE_RECEIVED, but the reflection arming
    // below still captures-at-write the profile this pipeline was reading from.
    const capturedDbProfile = settings?.activeDbProfile;
    // Also capture the character's avatar — used by the scene/next-hint writes and
    // the reflection arming so a mid-run character switch can't contaminate the wrong
    // character's attachments (database.js keys storage on the LIVE characterId/avatar).
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

    // NOTE: memory-extraction target selection (findMemoryTargetIndex) now lives in
    // runMemoryExtraction() on the post-reply path — the blocking path no longer needs
    // it because Agent 3 doesn't run here anymore.

    const formattedChat = formatMessagesForDraft(recentMessages);

    // --- Run Agent 1 + Speculative Retrieval in PARALLEL (NOT Agent 3) ---
    // Phase 3b: Agent 3 (memory extraction about the PREVIOUS exchange) was MOVED OFF
    // this latency-critical pre-generation path. It now runs POST-reply on
    // MESSAGE_RECEIVED (runMemoryExtraction), so the user no longer waits for
    // fact-extraction-about-the-last-turn before THIS reply generates. Only the agents
    // that feed THIS reply stay here: Agent 1 (draft/menu) + speculative retrieval, and
    // the Stage-2 finder runs after Agent 1 below.
    // SAFETY: We use CMRS (ConnectionManagerRequestService) to call the agent profile
    // directly by ID, WITHOUT switching the active UI profile. This is safe during
    // mid-generation because it doesn't touch the DOM or active connection state.
    updateStatus('running', 'Drafting...');
    addDebugLog('info', 'Running Agent 1 (draft) + speculative retrieval in parallel (Agent 3 deferred to post-reply)...');

    const agent1ProfileId = getAgent1ProfileId(settings);
    if (agent1ProfileId) {
        addDebugLog('info', `Profiles: Agent 1 = "${agent1ProfileId || 'default'}"`);
    } else {
        addDebugLog('info', 'No Agent 1 profile configured, agent will use current connection');
    }

    let draftResult = null;
    let speculativeRetrieval = null;

    // Start speculative fact retrieval using context keywords (no LLM needed)
    const contextKeywords = extractContextKeywords(recentMessages);
    addDebugLog('info', `Speculative retrieval keywords: ${contextKeywords.join(', ')}`);

    // Load databases once up front — reused for Agent 1's fact inventory/menu, the
    // Stage-2 finder candidates, and the deterministic-retrieval fallback. (Agent 3's
    // existing-DB context now loads separately on the post-reply extraction path.)
    const databases = await getAllDatabases();
    // FIX #12 (dead-payload removal): the keys-only fact inventory (`Category/key`, no values)
    // is consumed ONLY by the deterministic-retrieval fallback (buildDeterministicRetrieval),
    // which runs only when the Stage-2 finder is OFF. When the finder is ON (default), Agent 1
    // never uses that inventory, so building + sending it just burns input tokens every turn.
    // So we build it ONLY when the finder is disabled and otherwise pass '' (buildDraftPrompt
    // then omits the "Existing Fact Keys" block entirely). The Stage-1 MENU stays unconditional.
    const wantFinder = settings.useFinderAgent !== false; // default true
    const factInventory = wantFinder ? '' : summarizeKeys(databases);
    // STAGE 1 menu: compact Category×aspect map (counts, NO values) Agent 1 picks branches from.
    const factMenu = summarizeMenu(databases);
    addDebugLog('info', `Fact inventory for Agent 1: ${wantFinder ? 'skipped (finder on)' : (factInventory ? factInventory.split('\n').length + ' keys' : 'empty')}; menu: ${factMenu ? factMenu.split('\n').length + ' categories' : 'empty'}`);

    try {
        isInternalCall = true;
        const promises = [];

        // Agent 1: Draft + STAGE 1 menu picker (returns #Branches)
        promises.push(
            runDraftAgent(formattedChat, characterInfo, userPersona, agent1ProfileId, factInventory, factMenu)
                .catch(err => ({ draft: '', branches: [], neededFacts: [], raw: '', error: err.message })),
        );

        // Speculative retrieval: start fact lookup with context keywords NOW (no LLM wait)
        promises.push(
            retrieveFacts(contextKeywords, [])
                .catch(err => { addDebugLog('info', `Speculative retrieval failed: ${err.message}`); return null; }),
        );

        [draftResult, speculativeRetrieval] = await Promise.all(promises);
    } catch (error) {
        addDebugLog('fail', `Pipeline exception: ${error.message}`);
        hideWorkingIndicator();
        updateStatus('error', 'Pipeline failed');
        return;
    } finally {
        isInternalCall = false;
    }

    // --- Agent 3 (memory extraction) is no longer processed here ---
    // It was moved to runMemoryExtraction() on the MESSAGE_RECEIVED path (Phase 3b),
    // so all of its commit logic (Last Generated/Inserted, bf_mem_processed marking,
    // capture-at-write profile save, review popup, character-changed guard) now lives
    // there. The blocking path only feeds THIS reply.

    // --- Process Agent 1 results + merge with speculative retrieval ---
    // GRACEFUL DEGRADATION: if Agent 1 errored (e.g. provider returned empty completion
    // even after retry), don't abort the whole pipeline — the writer can still inject
    // the retrieved facts with no draft. Memory > nothing.
    if (!draftResult || draftResult.error) {
        addDebugLog('fail', `Agent 1 error: ${draftResult?.error || 'no result'} — continuing with facts only (no draft)`);
        draftResult = { draft: '', branches: [], focus: [], neededFacts: [], scene: null, raw: '' };
    }
    // Older Agent 1 result shapes (or partial parses) may lack branches/focus/neededFacts/nextHint.
    if (!Array.isArray(draftResult.branches)) draftResult.branches = [];
    if (!Array.isArray(draftResult.focus)) draftResult.focus = [];
    if (!Array.isArray(draftResult.neededFacts)) draftResult.neededFacts = [];
    if (!Array.isArray(draftResult.nextHint)) draftResult.nextHint = [];

    addDebugLog('info', `Agent 1 done: "${draftResult.draft.substring(0, 80)}..."`);
    addDebugLog('info', `Branches picked: ${draftResult.branches.join('; ') || '(none)'}`);
    addDebugLog('info', `Focus character(s): ${draftResult.focus.join(', ') || '(none — general moment)'}`);
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

    // --- Next-scene fact hint (refinement #11): backstage breadcrumb only ---
    // Agent 1 optionally emits #NextHint (topics likely relevant NEXT scene). We stash it
    // on the triggering USER message's extra (bf_mem_next_hint) — NOT in any visible reply
    // text, NOT injected into the writer. It's a future-use breadcrumb. Same guards as the
    // scene write: only when not cancelled and the character didn't change mid-run.
    if (!pipelineCancelled && draftResult.nextHint.length > 0 && lastUserMsgIndex >= 0 && chat[lastUserMsgIndex]) {
        const currentCharAvatar = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.avatar || '';
        if (currentCharAvatar === capturedCharAvatar) {
            const hint = draftResult.nextHint.slice(0, 5);
            chat[lastUserMsgIndex].extra = { ...(chat[lastUserMsgIndex].extra || {}), bf_mem_next_hint: hint };
            SillyTavern.getContext().saveChatDebounced?.();
            addDebugLog('info', `Next-scene hint stored on msg ${lastUserMsgIndex} (backstage): ${hint.join('; ')}`);
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
    // wantFinder was computed up front (gates whether the fact inventory was built for Agent 1).
    if (wantFinder) {
        // STAGE 2: gather the FULL active facts under Agent 1's picked branches PLUS, always,
        // every active Unsorted fact (collectBranchFacts folds Unsorted in unconditionally).
        const branchFacts = collectBranchFacts(databases, draftResult.branches);
        // CHARACTER-TAG FILTER (3-layer model): branches are character-agnostic, so the gather
        // above returns EVERY character's facts in those aspects. When Agent 1 named the focus
        // character(s), narrow to facts about THEM plus general/world facts and DROP unrelated
        // characters' facts — the whole point of the model (bounded by character relevance,
        // saving tokens). Applied BEFORE link-following so place⇄event⇄people expansion can
        // still surface the linked people of an in-scope event. No focus = no narrowing.
        const candidatesAll = filterCandidatesByFocus(branchFacts, draftResult.focus);
        // LINK-FOLLOWING (Phase 4b): when Agent 1 picks a PLACE/person branch, surface the
        // linked events (and an event's place+people) to the finder too, so the same
        // scope-graph traversal that helps deterministic retrieval also benefits the finder.
        // One bounded hop, deduped by id; newly pulled facts enter as secondary candidates.
        const branchSeen = new Set(candidatesAll.map(({ fact, category }) => `${category}:${fact.key}`));
        expandLinks(databases, candidatesAll, branchSeen);
        const candidates = candidatesAll.filter(({ fact }) => isFactVisible(fact));
        addDebugLog('info', `STAGE 2: ${candidates.length} candidate fact(s) from ${draftResult.branches.length} branch pick(s) + Unsorted${draftResult.focus.length ? ` (focus: ${draftResult.focus.join(', ')})` : ''} (incl. link expansion)`);
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
        // Agent 3 no longer runs here, so memoryResult is null on the blocking path —
        // its tokens are recorded separately via addAgent3Tokens on MESSAGE_RECEIVED.
        recordRunTokens({ baselineInput, actualInput: baselineInput, draftResult, memoryResult: null });
        logRunSummary({ runId, startTime, baselineInput, actualInput: baselineInput, draftResult, memoryResult: null, cancelled: true });
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

    // NOTE: the reflection "story so far" summary is intentionally NO LONGER injected into
    // the writer (refinement #1). The writer now receives only the scene sheet + chosen
    // facts + Agent 1's draft (+ the last messages it already sees). Reflection still runs
    // (refinement #4) as a silent dedupe-janitor / observation writer, but never injects.
    // reflectionInject is retained as an inert setting for back-compat (default now false).

    const injection = buildWriterInjection(draftResult.draft, retrieval.formatted, sceneBlock);
    lastInjection = injection; // Used for THIS first generation only.
    // FIX #8a: cache a draft-less variant for swipes/regens. Same scene + facts (those are
    // turn-stable and safe to reuse), but pass an empty draft so the stale "what happens
    // next" direction can't mis-steer a divergent re-roll. buildWriterInjection renders an
    // empty draft as "(no direction)" inside the #Scene Direction slot — a neutral
    // placeholder that doesn't push the re-roll toward the original swipe's planned beat.
    lastInjectionNoDraft = buildWriterInjection('', retrieval.formatted, sceneBlock);

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

    // Record token metrics for the Tokens tab. Agent 3 no longer runs on this path
    // (memoryResult: null) — its tokens are folded in later via addAgent3Tokens on
    // the MESSAGE_RECEIVED path, which updates lastRunTokens.agent3* without bumping
    // the run count or re-counting input.
    recordRunTokens({ baselineInput, actualInput, draftResult, memoryResult: null });
    // FIX #10: consolidated per-run summary (after token recording — values in scope).
    logRunSummary({ runId, startTime, baselineInput, actualInput, draftResult, memoryResult: null, cancelled: false });

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
 * Agent 3 (memory extraction), Phase 3b — runs POST-reply on MESSAGE_RECEIVED, OFF the
 * latency-critical pre-generation path. The just-completed exchange (the user message +
 * the AI reply that just landed) is now FULLY present in chat, so we extract from the real
 * accepted text — including the ACCEPTED swipe (the active swipe IS the message's current
 * .mes, so chat[target].mes is exactly what the user settled on; FIX #8b).
 *
 * Every guard from the old blocking-path commit is preserved here, with capture-at-write
 * pinned at extraction start (the correct moment now that timing shifted post-reply):
 *  - enabled / group / dry / internal skips
 *  - pipelineCancelled (a Stop discards the extraction)
 *  - bf_mem_processed gating (no double-extract of an already-processed exchange)
 *  - capturedDbProfile / capturedCharAvatar capture-at-write (right slot / right character)
 *  - saveChatDebounced + saveCurrentToActiveProfile + review popup
 * Wrapped in try/catch: an extraction failure must NEVER break generation or the next turn.
 */
async function runMemoryExtraction() {
    if (memoryExtractionInFlight) return; // a prior extraction is still committing
    const settings = getSettings();
    if (!settings || !settings.enabled) return;
    if (isInternalCall) return; // never extract off our own agent calls
    if (pipelineCancelled) {
        addDebugLog('info', 'Agent 3 (post-reply): skipped — generation was stopped/cancelled');
        return;
    }
    const ctx0 = SillyTavern.getContext();
    if (ctx0.groupId || ctx0.selected_group) return; // group chats unsupported (same as gate)

    const chat = ctx0.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    // Target the JUST-RECEIVED AI message (includeLast=true: the reply now exists at the
    // tail of chat). This also closes the swipe-settle gap — when the user swipes then
    // stops, chat[target].mes already holds the ACCEPTED swipe's content.
    const memoryTargetIndex = findMemoryTargetIndex(chat, true);
    if (memoryTargetIndex < 0) {
        addDebugLog('info', 'Agent 3 (post-reply): no genuine AI message to extract — skipping');
        return;
    }
    // bf_mem_processed gating (source of truth): don't re-extract an exchange already done.
    // On a swipe the MESSAGE_SWIPED handler clears this flag, so the accepted swipe re-runs.
    if (chat[memoryTargetIndex]?.extra?.bf_mem_processed) {
        addDebugLog('info', `Agent 3 (post-reply): target msg ${memoryTargetIndex} already processed — skipping (no double-extract)`);
        return;
    }

    // Find the latest USER message (for @src:user attribution / prior-context window).
    let lastUserMsgIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].is_user) { lastUserMsgIndex = i; break; }
    }

    // CAPTURE-AT-WRITE at extraction start (correct moment now timing is post-reply):
    // pin the active DB profile + character avatar so a mid-extraction chat/character
    // switch can't land facts in the wrong slot or contaminate another character.
    const capturedDbProfile = settings.activeDbProfile;
    const capturedCharAvatar = ctx0.characters?.[ctx0.characterId]?.avatar || '';
    const startTime = Date.now();
    const runId = `M${startTime.toString(36).slice(-5)}`;

    memoryExtractionInFlight = true;
    isInternalCall = true; // our extraction LLM call must not re-trigger the pipeline
    let memoryResult = null;
    try {
        const characterInfo = getCharacterInfo();
        const userPersona = getUserPersona();
        const targetMessage = chat[memoryTargetIndex];
        const role = targetMessage.is_user ? 'USER' : 'AI';

        // Load databases (Agent 3's existing-DB context).
        const databases = await getAllDatabases();

        // Gather up to agent3ContextMessages prior messages for richer context. Default = 2
        // means the latest user + AI exchange (current behavior preserved). The target is
        // passed separately, so exclude it from the prior window.
        const agent3Count = Math.max(1, settings.agent3ContextMessages || 2);
        const agent3StartIdx = Math.max(0, chat.length - agent3Count - 1);
        const agent3PriorMessages = [];
        for (let i = agent3StartIdx; i < chat.length; i++) {
            if (i === memoryTargetIndex) continue;
            if (chat[i] && chat[i].mes) {
                agent3PriorMessages.push({ role: chat[i].is_user ? 'USER' : 'CHAR', text: chat[i].mes });
            }
        }
        addDebugLog('info', `[${runId}] Agent 3 (post-reply) target [${role}] msg ${memoryTargetIndex}${agent3PriorMessages.length ? ` + ${agent3PriorMessages.length} prior msg(s)` : ''}: ${targetMessage.mes?.substring(0, 100)}`);

        const agent3ProfileId = getAgent3ProfileId(settings);
        memoryResult = await runMemoryUpdater(
            targetMessage.mes, memoryTargetIndex, characterInfo, databases, agent3ProfileId,
            !!targetMessage.is_user, userPersona, agent3PriorMessages, lastUserMsgIndex,
        ).catch(err => ({ updates: [], summary: '', raw: '', error: err.message, tokensIn: 0, tokensOut: 0 }));

        // Fold Agent 3's tokens into the session totals WITHOUT bumping the run count
        // (the run was already counted on the blocking path) and update lastRunTokens.
        addAgent3Tokens({ agent3Input: memoryResult?.tokensIn || 0, agent3Output: memoryResult?.tokensOut || 0 });

        if (!memoryResult || memoryResult.error) {
            if (memoryResult?.error) addDebugLog('fail', `[${runId}] Agent 3 error: ${memoryResult.error}`);
            return;
        }

        // Always record what Agent 3 proposed (for the Last Generated tab).
        setLastGenerated(memoryResult.updates || []);

        // pipelineCancelled may have flipped (user clicked Stop) while we awaited the LLM.
        if (pipelineCancelled) {
            addDebugLog('info', `[${runId}] Cancelled mid-extraction — discarding ${memoryResult.updates.length} updates`);
            setLastInserted((memoryResult.updates || []).map(u => ({ ...u, status: 'SKIPPED' })));
            return;
        }

        // Character-changed guard: don't write to another character's attachments.
        const liveCtx = SillyTavern.getContext();
        const currentCharAvatar = liveCtx.characters?.[liveCtx.characterId]?.avatar || '';
        if (currentCharAvatar !== capturedCharAvatar) {
            addDebugLog('fail', `[${runId}] Character changed mid-extraction (${capturedCharAvatar} -> ${currentCharAvatar}) — discarding ${memoryResult.updates.length} updates`);
            if (typeof toastr !== 'undefined') {
                toastr.warning('BF Memory: extraction discarded — you switched characters');
            }
            setLastInserted((memoryResult.updates || []).map(u => ({ ...u, status: 'SKIPPED' })));
            return;
        }

        // Last Inserted = only facts that actually changed stored state (NEW/UPDATED).
        const committed = Array.isArray(memoryResult.applied)
            ? memoryResult.applied
            : (memoryResult.updates || []).filter(u => u.changed ?? u.wasNew).map(u => ({
                ...u,
                status: u.status || (u.wasNew ? 'NEW' : 'UPDATED'),
            }));
        addDebugLog('info', `[${runId}] Agent 3: ${memoryResult.updates.length} proposed, ${committed.length} committed. ${memoryResult.summary}`);
        setLastInserted(committed);
        for (const update of memoryResult.updates) trackUpdate(update);
        lastProcessedMessageIndex = memoryTargetIndex;

        // Mark the AI target + the user message (Agent 3 saw both) as processed so the
        // per-message icon / "skip already processed" / our own re-extract gate honor it.
        if (chat[memoryTargetIndex]) {
            chat[memoryTargetIndex].extra = { ...(chat[memoryTargetIndex].extra || {}), bf_mem_processed: true };
        }
        if (lastUserMsgIndex >= 0 && lastUserMsgIndex !== memoryTargetIndex && chat[lastUserMsgIndex]) {
            chat[lastUserMsgIndex].extra = { ...(chat[lastUserMsgIndex].extra || {}), bf_mem_processed: true };
        }
        SillyTavern.getContext().saveChatDebounced?.();

        // Review popup (deferred), capturing the chat id so it can't pop in the wrong chat.
        if (tickMessageCounter(settings.reviewInterval || 10)) {
            addDebugLog('info', `[${runId}] Review interval reached, will show popup shortly`);
            const targetChatIdForPopup = SillyTavern.getContext().chatId;
            setTimeout(async () => {
                if (SillyTavern.getContext().chatId !== targetChatIdForPopup) {
                    addDebugLog('info', 'Skipping review popup: chat changed since extraction finished');
                    return;
                }
                await showReviewPopup(
                    () => addDebugLog('info', 'User accepted all memory updates'),
                    async (editedItems) => {
                        addDebugLog('info', `User edited ${editedItems.length} items`);
                        appendLastInserted(editedItems.map(i => ({ ...i, status: 'UPDATED' })));
                        const dbs = await getAllDatabases();
                        for (const item of editedItems) {
                            if (!dbs[item.category]) dbs[item.category] = createEmptyDatabase(item.category);
                            upsertFact(dbs[item.category], item);
                            await saveDatabase(dbs[item.category]);
                        }
                    },
                );
            }, 2000);
        }

        // Persist to the captured DB profile slot (capture-at-write).
        if (memoryResult.updates.length > 0) {
            await saveCurrentToActiveProfile(capturedDbProfile);
        }
    } catch (err) {
        // Graceful degradation: a memory-extraction failure must never break the next turn.
        addDebugLog('fail', `[${runId}] Agent 3 (post-reply) failed (non-fatal): ${err.message || err}`);
    } finally {
        memoryExtractionInFlight = false;
        isInternalCall = false;
    }
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
        // FIX #12: no longer pass prevReflection — the rolling #STORY summary was dropped, so
        // re-feeding the prior summary into the reflection prompt was wasted input tokens.
        await runReflection({
            runId: pending.runId,
            scene: getScene(),
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

/**
 * Character registry detection — runs on MESSAGE_RECEIVED, OFF the critical path, gated to
 * fire at most once every `characterCheckInterval` successful extraction runs. Performs a
 * DETERMINISTIC scan of the fact store (no LLM call) for newly-seen NAMED entities not yet
 * classified; when there are candidates, opens ONE batched popup (deferred, never blocking)
 * for the user to mark each Recurring / NPC / Later. Marking Recurring migrates that name's
 * facts out of the shared NPC drawer. Fully self-guarded + try/catch'd — a failure here can
 * never break generation or the next turn.
 */
async function maybeRunEntityCheck() {
    if (entityCheckInFlight) return;
    const settings = getSettings();
    if (!settings || !settings.enabled || settings.characterRegistryEnabled === false) return;
    if (pipelineCancelled) return;
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) return; // group chats unsupported (same as the gate)

    runsSinceEntityCheck++;
    const interval = Math.max(2, settings.characterCheckInterval || 10);
    if (runsSinceEntityCheck < interval) return;
    runsSinceEntityCheck = 0; // reset cadence regardless of outcome

    entityCheckInFlight = true;
    try {
        const { getAllDatabases } = await import('./database.js');
        const databases = await getAllDatabases();
        const candidates = detectAndRecord(databases);
        // Refresh the settings-panel list so newly-detected names show even before the popup.
        try { reloadEntitiesUI(); } catch { /* ignore */ }
        if (!candidates || candidates.length === 0) {
            addDebugLog('info', 'Character check: no new named candidates');
            return;
        }
        addDebugLog('info', `Character check: ${candidates.length} new named candidate(s) — opening popup`);
        // Defer the popup so it never lands mid-generation: capture the chat id and only
        // show if we're still in the same chat after a short settle window (mirrors the
        // review-popup deferral pattern).
        const targetChatId = ctx.chatId;
        setTimeout(async () => {
            try {
                if (SillyTavern.getContext().chatId !== targetChatId) {
                    addDebugLog('info', 'Character popup skipped: chat changed since detection');
                    return;
                }
                await showEntityPopup(candidates);
                try { reloadEntitiesUI(); } catch { /* ignore */ }
            } catch (err) {
                addDebugLog('fail', `Character popup failed (non-fatal): ${err.message || err}`);
            }
        }, 2200);
    } catch (err) {
        addDebugLog('fail', `Character check failed (non-fatal): ${err.message || err}`);
    } finally {
        entityCheckInFlight = false;
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

        // Swipe/regen: re-inject cached facts (no agents, instant).
        // FIX #8a: use the DRAFT-LESS cached injection (lastInjectionNoDraft) — the same
        // scene + facts as the first roll, but WITHOUT Agent 1's stale draft scene-direction,
        // which was planned for the original roll and would mis-steer a divergent re-roll.
        // Skip if pipeline just injected in this same generation cycle (double-fire guard).
        const swipeInjection = lastInjectionNoDraft || lastInjection;
        if (swipeInjection && !isInternalCall && !data?.dryRun && !pipelineJustInjected) {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;

            const success = injectMemoryContext(data, swipeInjection);
            if (success) {
                addDebugLog('info', `Swipe/regen: re-injected cached facts without stale draft (${swipeInjection.length} chars)`);
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

        // Swipe/regen: re-inject cached facts (FIX #8a: draft-less variant).
        const swipeInjection = lastInjectionNoDraft || lastInjection;
        if (swipeInjection && data && typeof data.prompt === 'string') {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;

            data.prompt = swipeInjection + '\n\n' + data.prompt;
            addDebugLog('info', `Swipe/regen (text): re-injected cached facts without stale draft (${swipeInjection.length} chars)`);
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

        // Phase 3b + FIX #12: Agent 3 (memory extraction about the just-completed exchange)
        // runs off the latency-critical pre-generation path. The AI reply has landed (and any
        // accepted swipe IS the message's current text). PER-SWIPE GATING: rather than
        // extract EAGERLY here — which on a heavily-swiped turn fired the ~7k-token Agent-3
        // call once per generated swipe — we SCHEDULE the extraction on the shared settle
        // debounce. Each new swipe (MESSAGE_RECEIVED) or navigation (MESSAGE_SWIPED) resets
        // the timer, so the expensive extraction runs ONCE on the settled/kept swipe. A normal
        // single-reply turn schedules once and, with nothing resetting it, still extracts
        // exactly once promptly. The reflection + entity-check passes are chained to run AFTER
        // the (single) settled extraction (runPostPasses=true), preserving their prior ordering
        // relative to the kept content. All guards (bf_mem_processed, pipelineCancelled, etc.)
        // remain inside runMemoryExtraction and are evaluated at fire time (settle), so a Stop
        // or a swipe that lands new content is still honored.
        scheduleSettleExtraction('message-received', true);
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

        // FIX #8b / FIX #12: (re)schedule the shared settle-extraction. Both a NEW-swipe
        // generation (via MESSAGE_RECEIVED) and a navigation onto an existing swipe (here)
        // feed the SAME debounce, so the expensive Agent-3 extraction runs ONCE on the final
        // settled swipe — never once per swipe. We do NOT run the reflection/entity-check
        // passes from the swipe path (runPostPasses=false): those are owned by the
        // MESSAGE_RECEIVED path so navigation alone can't re-arm a consolidation. Fully guarded
        // inside runMemoryExtraction (bf_mem_processed / cancelled / try/catch).
        scheduleSettleExtraction('swipe', false);
    });

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        isInternalCall = false;
        lastProcessedMessageIndex = -1;
        lastInjection = null;
        lastInjectionNoDraft = null;
        pipelineJustInjected = false;
        // Drop any pending swipe-settle extraction so it can't fire against the new chat.
        if (swipeSettleTimer) { clearTimeout(swipeSettleTimer); swipeSettleTimer = null; }
        groupSkipToastShown = false;
        chatChangedAt = Date.now();
        // Reflection cadence is per-chat: reset the counter and drop any armed pass so a
        // chat switch can't fire a consolidation against the new chat using old context.
        successfulRunsSinceReflection = 0;
        reflectionPending = null;
        // Character-registry cadence is per-chat too: reset so a chat switch can't fire a
        // detection against the new chat using the old chat's accumulated run count.
        runsSinceEntityCheck = 0;
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
