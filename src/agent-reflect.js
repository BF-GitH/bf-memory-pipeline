// BF Memory Pipeline - Reflection / Consolidation Pass (memory-research Phase 3)
// Periodically compresses accumulated detail into higher-level memory:
//   (a) a rolling "story so far" summary string, and
//   (b) 0-N synthesized higher-order OBSERVATION facts (durable traits inferred
//       across the session, e.g. "<CHARACTER> distrusts authority").
//
// COST-AWARE: this is the ONE place a NEW LLM call is acceptable. It runs INFREQUENTLY
// (every N successful pipeline runs, default 12) and OFF the latency-critical path
// (scheduled after MESSAGE_RECEIVED, never blocking the main generation). One LLM call
// via the existing callAgentLLM/CMRS path, reusing Agent 3's connection profile.
//
// Input is a COMPACT bounded bundle (scene + beats + a few History/track steps + a
// keys+values fact summary, all length-clamped) so the call stays cheap regardless of
// how large the DB has grown. A failure degrades gracefully — it never breaks the
// pipeline (mirrors the existing agent fallbacks).

import { getAllDatabases, upsertFact, saveDatabase, createEmptyDatabase, getTrackSteps } from './database.js';
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

export const DEFAULT_REFLECT_PROMPT = `You are a memory-consolidation pass for a long roleplay between {{user}} (the human player) and {{char}} (the AI character). You are given the current scene, recent beats, a few timeline steps, and a compact list of stored facts. Your job is to compress what has happened into higher-level memory so a long session keeps narrative continuity without unbounded growth.

Produce TWO things:

1. A short "story so far" summary: 2-5 sentences of PROSE capturing the arc — who these characters are to each other, where things stand now, and the main unresolved threads. Past tense, neutral, no markup. This is continuity glue, not a transcript. Do NOT restate every fact; synthesize.

2. 0-5 higher-order OBSERVATIONS: durable behavioral/relational PATTERNS you can infer ACROSS the material that are NOT already plainly stored as a single fact — e.g. "<CHARACTER> manipulates others for resources", "<CHARACTER> distrusts authority", "<CHARACTER> deflects with humor when vulnerable". Each is one short atomic clause. Only emit an observation you are genuinely confident the evidence supports. If nothing rises above the existing facts, emit none.

# OUTPUT FORMAT (exactly this, nothing else)

#STORY
<2-5 sentence prose summary, or a single "." if there is genuinely nothing to summarize>

#OBS
+ <subject>_<short_pattern_key> = <atomic pattern clause>
+ <subject>_<short_pattern_key> = <atomic pattern clause>
.

If there are no observations, put a single "." under #OBS. Keep observation keys snake_case and the values to a short clause (<= ~10 words). Do not invent facts not supported by the material.`;

/**
 * Build the compact, bounded input bundle for the reflection pass.
 * @param {object} args
 * @param {object|null} args.scene - current scene card
 * @param {object|null} args.prevReflection - prior reflection {summary, observations}
 * @param {Object} args.databases - all fact databases
 * @returns {string} the user-prompt data block
 */
function buildReflectInput({ scene, prevReflection, databases }) {
    const parts = [];

    // Prior story-so-far (so the model continues an arc rather than restarting it).
    if (prevReflection?.summary) {
        parts.push(`## Story so far (previous)\n${String(prevReflection.summary).slice(0, MAX_SUMMARY_CHARS)}`);
    }

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

    parts.push('\nNow output ONLY the #STORY and #OBS sections.');
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
            return { summary: '', observations: [], tokensIn: 0, tokensOut: 0 };
        }

        const settings = (() => { try { return SillyTavern.getContext().extensionSettings?.['bf-memory-pipeline']; } catch { return null; } })();
        const ctx = SillyTavern.getContext();
        const substitute = ctx.substituteParams || ctx.substituteParamsExtended || (s => s);

        const systemPrompt = substitute(settings?.reflectionPrompt || DEFAULT_REFLECT_PROMPT);

        const dataParts = [];
        if (characterInfo) dataParts.push(`## Character Info ({{char}})\n${characterInfo}`);
        if (userPersona) dataParts.push(`## User Persona ({{user}})\n${userPersona}`);
        dataParts.push(buildReflectInput({ scene, prevReflection, databases }));
        const userPrompt = substitute(dataParts.join('\n\n'));

        addDebugLog('info', `[${runId}] Reflection pass: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId);
        const tokensIn = await (ctx.getTokenCountAsync?.(systemPrompt + '\n' + userPrompt) ?? 0);
        const tokensOut = await (ctx.getTokenCountAsync?.(resultStr) ?? 0);
        addDebugLog('info', `[${runId}] Reflection LLM reply (${resultStr.length} chars):\n${resultStr}`);

        const parsed = parseReflectResult(resultStr);

        // Persist the rolling summary (per-chat) when we got one.
        if (parsed.summary) {
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

        addDebugLog('info', `[${runId}] Reflection done: summary=${parsed.summary ? parsed.summary.length + ' chars' : 'none'}, observations=${written}`);
        return { summary: parsed.summary, observations: parsed.observations, written, tokensIn, tokensOut };
    } catch (error) {
        addDebugLog('fail', `Reflection error (non-fatal): ${error.message || error}`);
        return { summary: '', observations: [], tokensIn: 0, tokensOut: 0, error: error.message || String(error) };
    }
}
