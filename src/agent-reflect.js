// BF Memory Pipeline - Reflection Pass = SILENT DEDUPE-JANITOR (refinement #12)
// Repurposed from the old "story so far" consolidator. Its summary is NO LONGER injected
// into the writer (refinement #1), so this pass now exists primarily to keep the fact DB
// clean off the critical path. Each run it:
//   (a) DEDUPES the DB — re-runs reconcile-on-write over every active fact (dedupeDatabase)
//       to merge/supersede near-duplicate facts that accumulated over a long session, and
//   (b) optionally writes 0-N high-value OBSERVATION facts (durable traits inferred across
//       the session, e.g. "<CHARACTER> distrusts authority").
// FIX #12: the rolling "story so far" #STORY summary has been REMOVED. It was no longer
// injected anywhere (refinement #1 dropped the writer injection), so generating it — and
// re-sending the prior summary back into the prompt each pass — was pure wasted output +
// input tokens. We no longer ask for #STORY and no longer feed the prior summary back in.
// The live UI panel (#bf_mem_reflection_view) still renders the synthesized OBSERVATIONS
// (stored via setReflection with an empty summary), so no UI binding is broken.
//
// COST-AWARE: this is the ONE place a NEW LLM call is acceptable. It runs INFREQUENTLY
// (every N successful pipeline runs, default 12) and OFF the latency-critical path
// (scheduled after MESSAGE_RECEIVED, never blocking the main generation). The dedupe step
// itself needs NO LLM call. One LLM call via the existing callAgentLLM/CMRS path, reusing
// Agent 3's connection profile, drives the optional observations.
//
// Input is a COMPACT bounded bundle (scene + beats + a few History/track steps + a
// keys+values fact summary, all length-clamped) so the call stays cheap regardless of
// how large the DB has grown. A failure degrades gracefully — it never breaks the
// pipeline (mirrors the existing agent fallbacks).

import { getAllDatabases, upsertFact, saveDatabase, createEmptyDatabase, getTrackSteps, dedupeDatabase } from './database.js';
import { addDebugLog, setReflection } from './settings.js';
import { callAgentLLM } from './llm-call.js';

// Bound the fact summary fed into the reflection prompt so a huge DB can't blow up cost.
const MAX_FACT_SUMMARY_CHARS = 4000;
// Bound how many track/diary steps we include per track (newest-last).
const MAX_TRACK_STEPS = 6;
// Hard cap on the stored "story so far" summary (chars). Keeps both storage and the
// optional injection bounded even if the model ignores the length instruction.
const MAX_SUMMARY_CHARS = 1200;
// Cap synthesized observations per pass (defensive — the prompt asks for 0-5).
const MAX_OBSERVATIONS = 8;

export const DEFAULT_REFLECT_PROMPT = `You are a periodic memory-maintenance pass for a long roleplay between {{user}} (the human player) and {{char}} (the AI character). You are given the current scene, recent beats, a few timeline steps, and a compact list of stored facts. Duplicate facts are merged automatically before you run; your job is to surface only DURABLE higher-order memory that the per-fact extractor would miss.

Produce 0-5 higher-order OBSERVATIONS: durable behavioral/relational PATTERNS you can infer ACROSS the material that are NOT already plainly stored as a single fact — e.g. "<SUBJECT> manipulates others for resources", "<SUBJECT> distrusts authority", "<SUBJECT> deflects with humor when vulnerable". Each is one short atomic clause. Only emit an observation you are genuinely confident the evidence supports, and that adds something the existing facts do not already say. If nothing rises above the existing facts, emit none.

# OUTPUT FORMAT (exactly this, nothing else)

#OBS
+ <subject>_<short_pattern_key> = <atomic pattern clause>
+ <subject>_<short_pattern_key> = <atomic pattern clause>
.

If there are no observations, put a single "." under #OBS. Keep observation keys snake_case and the values to a short clause (<= ~10 words). Do not invent facts not supported by the material.`;

/**
 * Build the compact, bounded input bundle for the reflection pass.
 * @param {object} args
 * @param {object|null} args.scene - current scene card
 * @param {object|null} [args.prevReflection] - DEPRECATED (FIX #12): retained in the signature
 *   for back-compat but NO LONGER fed into the prompt. The rolling story summary was dropped
 *   (it was never injected anywhere), so re-sending it each pass was wasted input tokens.
 * @param {Object} args.databases - all fact databases
 * @returns {string} the user-prompt data block
 */
function buildReflectInput({ scene, databases }) {
    const parts = [];

    // FIX #12: the prior "story so far" summary is intentionally NOT prepended anymore — the
    // pass now only synthesizes OBSERVATIONS, which reconcile against existing facts on write.

    // Current scene + recent beats.
    if (scene && typeof scene === 'object') {
        const sLines = [];
        if (scene.location) sLines.push(`Location: ${scene.location}`);
        if (Array.isArray(scene.present) && scene.present.length) sLines.push(`Present: ${scene.present.join(', ')}`);
        if (Array.isArray(scene.goals) && scene.goals.length) sLines.push(`Goals: ${scene.goals.join('; ')}`);
        if (Array.isArray(scene.beats) && scene.beats.length) sLines.push(`Recent beats: ${scene.beats.join('; ')}`);
        if (sLines.length) parts.push(`## Current scene\n${sLines.join('\n')}`);
    }

    // A few timeline (History/track) steps for narrative shape — newest-last, per track.
    const trackNames = new Set();
    for (const db of Object.values(databases || {})) {
        for (const f of (db.facts || [])) {
            if (f && typeof f.track === 'string' && f.track.trim()) trackNames.add(f.track.trim());
        }
    }
    const trackLines = [];
    for (const track of trackNames) {
        const steps = getTrackSteps(databases, track).slice(-MAX_TRACK_STEPS);
        if (steps.length) {
            trackLines.push(`${track}: ${steps.map(s => s.fact.value).join(' -> ')}`);
        }
    }
    if (trackLines.length) parts.push(`## Timelines\n${trackLines.join('\n')}`);

    // Compact current-fact summary (key = value), active facts only, length-bounded.
    const factLines = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (fact.active === false) continue; // skip superseded history snapshots
            factLines.push(`${category}/${fact.key} = ${fact.value}`);
        }
    }
    let factSummary = factLines.join('\n');
    if (factSummary.length > MAX_FACT_SUMMARY_CHARS) {
        factSummary = factSummary.slice(0, MAX_FACT_SUMMARY_CHARS) + '\n…(truncated)';
    }
    if (factSummary) parts.push(`## Stored facts (current)\n${factSummary}`);

    parts.push('\nNow output ONLY the #OBS section.');
    return parts.join('\n\n');
}

/**
 * Parse the reflection LLM output into { summary, observations[] }.
 * Mirrors the tolerant `#`-block grammar used by Agent 1 / Agent 3.
 * @param {string} response
 * @returns {{summary: string, observations: Array<{key:string,value:string}>}}
 */
export function parseReflectResult(response) {
    const out = { summary: '', observations: [] };
    if (!response || !response.trim()) return out;

    let text = response.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*/g, '').trim()).replace(/```/g, '');

    // #STORY ... (bounded before #OBS).
    const storyMatch = text.match(/#STORY\s*([\s\S]*?)(?=\n\s*#OBS|$)/i);
    if (storyMatch) {
        let s = storyMatch[1].trim();
        if (s === '.' || /^\(none\)$/i.test(s)) s = '';
        if (s.length > MAX_SUMMARY_CHARS) s = s.slice(0, MAX_SUMMARY_CHARS).trimEnd() + '…';
        out.summary = s;
    }

    // #OBS lines: `+ key = value`.
    const obsMatch = text.match(/#OBS\s*([\s\S]*?)$/i);
    if (obsMatch) {
        const block = obsMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                const eqIdx = line.indexOf('=');
                if (eqIdx < 0) continue;
                let key = line.slice(0, eqIdx).trim();
                // Strip an optional Category/ prefix if the model added one.
                const slashIdx = key.indexOf('/');
                if (slashIdx >= 0) key = key.slice(slashIdx + 1).trim();
                key = key.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
                const value = line.slice(eqIdx + 1).trim();
                if (!key || !value) continue;
                out.observations.push({ key, value });
                if (out.observations.length >= MAX_OBSERVATIONS) break;
            }
        }
    }
    return out;
}

/**
 * Run the reflection / consolidation pass. ONE LLM call. Writes the rolling summary to
 * chat_metadata via setReflection() and synthesized observations as normal facts via
 * upsertFact (category Behavior, kind:trait, importance 4, tagged observation/reflection)
 * so they ride the existing retrieval/eviction/supersession machinery and reconcile on
 * write (no duplicate spam).
 *
 * @param {object} args
 * @param {string} args.runId - the originating pipeline run id (for traceability)
 * @param {object|null} args.scene - current scene card
 * @param {object|null} args.prevReflection - prior reflection
 * @param {string} args.characterInfo - character card info (for {{char}} grounding)
 * @param {string} args.userPersona
 * @param {string|null} args.profileId - connection profile (reuse Agent 3's)
 * @returns {Promise<{summary:string, observations:Array, tokensIn:number, tokensOut:number, error?:string}>}
 */
export async function runReflection({ runId = '', scene = null, prevReflection = null, characterInfo = '', userPersona = '', profileId = null } = {}) {
    try {
        const databases = await getAllDatabases();

        // Skip when there's genuinely nothing to consolidate (no facts, no scene).
        const totalFacts = Object.values(databases).reduce((n, db) => n + (db.facts?.length || 0), 0);
        if (totalFacts === 0 && !scene) {
            addDebugLog('info', `[${runId}] Reflection skipped (nothing to consolidate)`);
            return { summary: '', observations: [], merged: 0, tokensIn: 0, tokensOut: 0 };
        }

        // (a) SILENT DEDUPE-JANITOR (refinement #12): merge near-duplicate facts that piled
        // up over the session by re-running reconcile-on-write over each DB. NO LLM call.
        // Best-effort + isolated per category so one bad DB can't abort the whole pass.
        let totalMerged = 0;
        for (const [category, db] of Object.entries(databases)) {
            try {
                const { db: cleaned, merged } = dedupeDatabase(db);
                if (merged > 0) {
                    databases[category] = cleaned;
                    await saveDatabase(cleaned);
                    totalMerged += merged;
                    addDebugLog('info', `[${runId}] Dedupe-janitor: merged ${merged} duplicate fact(s) in ${category}`);
                }
            } catch (err) {
                addDebugLog('fail', `[${runId}] Dedupe-janitor failed for ${category} (non-fatal): ${err.message || err}`);
            }
        }
        if (totalMerged > 0) addDebugLog('pass', `[${runId}] Dedupe-janitor merged ${totalMerged} duplicate fact(s) total`);

        const settings = (() => { try { return SillyTavern.getContext().extensionSettings?.['bf-memory-pipeline']; } catch { return null; } })();
        const ctx = SillyTavern.getContext();
        const substitute = ctx.substituteParams || ctx.substituteParamsExtended || (s => s);

        const systemPrompt = substitute(settings?.reflectionPrompt || DEFAULT_REFLECT_PROMPT);

        const dataParts = [];
        if (characterInfo) dataParts.push(`## Character Info ({{char}})\n${characterInfo}`);
        if (userPersona) dataParts.push(`## User Persona ({{user}})\n${userPersona}`);
        dataParts.push(buildReflectInput({ scene, databases }));
        const userPrompt = substitute(dataParts.join('\n\n'));

        addDebugLog('info', `[${runId}] Reflection pass: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId);
        const tokensIn = await (ctx.getTokenCountAsync?.(systemPrompt + '\n' + userPrompt) ?? 0);
        const tokensOut = await (ctx.getTokenCountAsync?.(resultStr) ?? 0);
        addDebugLog('info', `[${runId}] Reflection LLM reply (${resultStr.length} chars):\n${resultStr}`);

        const parsed = parseReflectResult(resultStr);

        // Persist reflection state (per-chat) for the live UI panel. FIX #12: the rolling
        // #STORY summary is no longer requested, so parsed.summary is normally empty — we now
        // store whenever there is EITHER a (legacy/custom-prompt) summary OR observations, so
        // the panel keeps rendering the synthesized observation chips. normalizeReflection
        // accepts an observations-only reflection (returns null only when BOTH are empty).
        if (parsed.summary || parsed.observations.length > 0) {
            setReflection({ summary: parsed.summary, observations: parsed.observations.map(o => o.value) }, runId);
        }

        // Write observations as normal facts. reconcile-on-write in upsertFact prevents
        // duplicate spam against existing facts/observations with the same key.
        let written = 0;
        if (parsed.observations.length > 0) {
            const category = 'Behavior';
            if (!databases[category]) databases[category] = createEmptyDatabase(category);
            const db = databases[category];
            const charName = ctx.characters?.[ctx.characterId]?.name || '';
            for (const obs of parsed.observations) {
                upsertFact(db, {
                    key: obs.key,
                    value: obs.value,
                    tags: ['observation', 'reflection'],
                    knownBy: charName ? [charName] : [],
                    relationships: { primary: [], secondary: [], tertiary: [] },
                    source: `reflection_${runId}`,
                    importance: 4,
                    kind: 'trait',
                });
                written++;
            }
            try {
                await saveDatabase(db);
                addDebugLog('pass', `[${runId}] Reflection wrote ${written} observation(s) to Behavior`);
            } catch (err) {
                addDebugLog('fail', `[${runId}] Reflection failed to save observations: ${err.message || err}`);
            }
        }

        addDebugLog('info', `[${runId}] Reflection done: merged=${totalMerged}, summary=${parsed.summary ? parsed.summary.length + ' chars' : 'none'}, observations=${written}`);
        return { summary: parsed.summary, observations: parsed.observations, written, merged: totalMerged, tokensIn, tokensOut };
    } catch (error) {
        addDebugLog('fail', `Reflection error (non-fatal): ${error.message || error}`);
        return { summary: '', observations: [], tokensIn: 0, tokensOut: 0, error: error.message || String(error) };
    }
}
