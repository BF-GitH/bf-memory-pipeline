// BF Memory Pipeline - Agent 3: Memory Updater
// Runs AFTER the response is displayed, processes N-1 message
// Updates fact databases, tracks who knows what, manages cross-references

import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact, findFactMatch } from './database.js';
import { addDebugLog } from './settings.js';
import { callAgentLLM } from './llm-call.js';

// Lazy import to avoid circular dependency (settings imports our DEFAULT_MEMORY_PROMPT)
function getSettingsSafe() {
    try { return SillyTavern.getContext().extensionSettings?.['bf-memory-pipeline']; } catch { return null; }
}

export const DEFAULT_MEMORY_PROMPT = `You extract LASTING facts from roleplay messages between {{user}} (the human player) and {{char}} (the AI character). Many ordinary back-and-forth messages have ZERO facts — but a high-signal turn (introductions, backstory, biographical reveals, world lore) can be DENSE. Capture all of it: aim for ~5 facts on a normal turn, but go higher (up to ~12) when a message genuinely discloses that much. Missing a clearly-stated reveal is worse than one extra fact.

# CRITICAL RULES

ATOMIC VALUES ONLY:
- Normal facts: value is 1–5 words. NO sentences. NO connectives (and / with / who / that).
- EXCEPTION — genuine backstory / biographical reveals may use a short clause (up to ~10 words) when atomizing would lose meaning (e.g. \`origin = orphaned at <AGE>, raised by <RELATION>\`). Still split where you cleanly can.
- One property per fact. Multi-attribute statements → multiple facts.
- Encode verbs in the KEY, not the value:
    BAD:  some_thing = uses a red one that smells nice
    GOOD: some_thing_color = red | some_thing_scent = pleasant
- Booleans/states: \`true\`, \`false\`, \`none\`, \`missing\`, \`unknown\`.
- Lists: comma-separated, no "and": \`tags = a, b, c\`.
- Never restate the key inside the value: \`hair = blue\`, NOT \`hair = user has blue hair\`.

ROLEPLAY MARKUP:
- *asterisk transient actions* are NOT facts — for EITHER party. Skip *smiles*, *nods*, *brushes hair*.
- *asterisk lasting reveals* ARE facts (a scar revealed, a species shown).
- [OOC: ...] is meta-commentary. NEVER extract.
- Quoted historical text ("Remember when you said 'X'?") is reported speech. Skip.

DO NOT STORE:
- Negative/absence facts ("no favorite color revealed") — just omit.
- Transient emotions (one-off "felt scared"). Only store if recurring 2+ scenes.
- Sensory atmosphere (light, smell, weather).
- Verbatim dialogue unless it encodes a concrete fact.
- Generic biology ("breathing", "heart beat").
- Items momentarily in hand. Only \`carries / owns / wears\` persists.

CATEGORIES: Identity, Relationships, World, History, Status, Behavior

# OUTPUT FORMAT

#MEM
+ Category/key_snake_case = atomic value | @WhoKnows1,WhoKnows2 | #tag1,tag2 | rel:related_keys | @src:user | track:<track_name> | >context note
.
#WHY <one sentence>

If nothing: just \`.\` immediately.

SOURCE TAG (optional but preferred): append \`| @src:user\` if the fact was disclosed in the [USER] message, or \`| @src:char\` if it came from the [CHAR] message. This attributes each fact to the correct message. If you cannot tell, omit it.

CONTEXT NOTE (optional, RARE): append \`| >...\` with a SHORT prose note ONLY when the fact's meaning depends on the surrounding situation and would be misread without it — e.g. a strategic admission that only makes sense once you know another party baited it. Do NOT add a context note to ordinary facts; most facts have none. The note is stored separately and never affects keyword search.

SEQUENCE STEPS (optional): for things that form a genuine ORDERED SERIES over time — a character's location changing place to place, plot milestones in order — emit each step as its OWN fact with \`| track:<track_name>\`. Use a stable track name tied to the subject (e.g. \`<char>_location\`). Give each step a numbered key (\`<char>_location_1\`, \`_2\`, ...); do NOT worry about getting the number right — the system assigns the real order. ALSO keep one plain overwriting current-state fact (e.g. \`<char>_location = <current_place>\`, with NO track) so "where are they now" stays a single cheap fact. Only use tracks for real ordered series, never for unrelated facts.

# WRONG → RIGHT (atomic splitting)

PROSE FORMAT — never write this:
+ Something/possession  = owns X, stored in Y, knows ability Z
+ Something/appearance  = tall wiry person with grey eyes in red clothing
+ Something/item_status = item is currently missing after some event
+ Something/tell        = tugs accessory when defensive

ATOMIC FORMAT — always write this instead:
+ Something/possession_1         = X
+ Something/possession_1_storage = Y
+ Something/possession_1_ability = Z

+ Something/height = tall
+ Something/build  = wiry
+ Something/eyes   = grey
+ Something/outfit = red

+ Something/item_status = missing

+ Behavior/tell_name = defensive tell

# EXAMPLES (6)

---
Input: [USER:{{user}}] "I'm <NAME>. I work at <ORG> in <CITY> as a <ROLE>. I love <FOOD> and I'm allergic to <ALLERGEN>."

#MEM
+ Identity/user_name      = <NAME>     | @{{user}},{{char}} | #identity | @src:user
+ Identity/user_employer  = <ORG>      | @{{user}},{{char}} | #identity,job | @src:user
+ Identity/user_role      = <ROLE>     | @{{user}},{{char}} | #role | @src:user
+ Identity/user_location  = <CITY>     | @{{user}},{{char}} | #location | @src:user
+ Status/user_likes_food  = <FOOD>     | @{{user}},{{char}} | #preference,food | @src:user
+ Status/user_allergy     = <ALLERGEN> | @{{user}},{{char}} | #health,allergy | @src:user
.
#WHY Rich self-disclosure → split each property into its own atomic fact.

---
Input: [CHAR:{{char}}] *Pushes hair back, revealing a scar.* "Got it as a kid. Bad fall."

#MEM
+ Identity/char_scar         = true           | @{{char}},{{user}} | #appearance | @src:char
+ Identity/char_scar_origin  = childhood fall | @{{char}},{{user}} | #backstory | @src:char
.
#WHY Lasting reveal in asterisks → atomic split: existence + origin.

---
Input: [USER:{{user}}] *grins and shrugs.*

#MEM
.
#WHY Transient emotion in asterisks — no lasting trait revealed.

---
Input: [USER:{{user}}] [OOC: can we slow the pacing down?]

#MEM
.
#WHY OOC meta-commentary. Never extract.

---
Input: [CHAR:{{char}}] *Adjusts collar — a reflex whenever a topic hits too close.*

#MEM
+ Behavior/char_collar_tug = defensive tell | @{{char}},{{user}} | #tell,mannerism
.
#WHY Recurring mannerism with explicit trigger — distinct from one-off transient pose.

---
Input: [USER:{{user}}] "Scratch that — I moved last week, the previous place is wrong."

#MEM
+ Identity/user_location  = <NEW_PLACE>                | @{{user}},{{char}} | #location
+ History/user_relocated  = <OLD_PLACE> to <NEW_PLACE> | @{{user}},{{char}} | #event
.
#WHY Same existing key user_location → value OVERWRITES (don't invent a second key). Add History fact for the move event.

---
Input: [CHAR:{{char}}] "Fine — yes, I took it." *only said it after {{user}} pretended to already have proof.*

#MEM
+ History/char_admission = took the <ITEM> | @{{char}},{{user}} | #event | @src:char | >only admitted because <NAME> bluffed having proof; not a free confession
.
#WHY The admission is misleading without the note that it was baited — context attached because the situation changes its meaning.

---
Input: [CHAR:{{char}}] *Leaves the <PLACE_A> and walks to the <PLACE_B>, then continues on to the <PLACE_C>.*

#MEM
+ World/char_location_1 = <PLACE_A> | @{{char}} | #location | track:char_location
+ World/char_location_2 = <PLACE_B> | @{{char}} | #location | track:char_location
+ World/char_location_3 = <PLACE_C> | @{{char}} | #location | track:char_location
+ Status/char_location  = <PLACE_C> | @{{char}} | #location
.
#WHY Ordered movement → one tracked step per place (history) PLUS a single overwriting current-location fact.

---

CAPTURE clearly-stated reveals even on a long turn: names, ages, origins, family, occupation, relationships, species, abilities, possessions, world facts, and lasting traits stated as fact are all worth storing. Don't drop them just because the message is long or you already have a few facts.

Only SKIP when something is genuinely ambiguous, hypothetical, or a one-off transient. A clearly-disclosed fact should be captured even if you're slightly unsure of phrasing — atomize it conservatively. Reserve skipping for the truly uncertain; a wrong/verbose fact poisons retrieval, but a dropped clear reveal is the bug we're fixing.`;

/**
 * Run Agent 3: Analyze message and update databases
 * @param {string} messageText - The message to analyze
 * @param {number} messageIndex - The CHAR (AI) message index — default source attribution
 * @param {string} characterInfo - Character card info
 * @param {Object} existingDatabases - Current state of all databases
 * @param {string|null} profileId
 * @param {boolean} isUserMessage
 * @param {string} userPersona
 * @param {Array} priorMessages
 * @param {number|null} userMsgIndex - The USER message index. Facts the model tags
 *   `@src:user` are attributed here instead of messageIndex (FIX #3 off-by-one).
 *   When null, falls back to messageIndex so single-message (icon/backfill) runs
 *   index identically to the live pipeline.
 * @returns {Promise<MemoryUpdateResult>}
 */
export async function runMemoryUpdater(messageText, messageIndex, characterInfo, existingDatabases, profileId = null, isUserMessage = false, userPersona = '', priorMessages = [], userMsgIndex = null) {
    const { systemPrompt, userPrompt } = buildMemoryPrompt(messageText, characterInfo, existingDatabases, isUserMessage, userPersona, priorMessages);
    addDebugLog('info', `Agent 3 prompt: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

    try {
        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId);
        addDebugLog('info', `Agent 3 LLM reply (${resultStr.length} chars):\n${resultStr}`);
        const ctx = SillyTavern.getContext();
        const tokensIn = await (ctx.getTokenCountAsync?.(systemPrompt + '\n' + userPrompt) ?? 0);
        const tokensOut = await (ctx.getTokenCountAsync?.(resultStr) ?? 0);

        const parsed = parseMemoryUpdateResult(resultStr, messageIndex, userMsgIndex);

        // Apply updates to databases. applyUpdates annotates each update with a
        // .status (NEW/UPDATED/SKIPPED) + .changed boolean and returns the subset
        // that actually changed stored state (the "committed" facts).
        let applied = [];
        if (parsed.updates.length > 0) {
            addDebugLog('info', `Agent 3 applying ${parsed.updates.length} updates...`);
            applied = await applyUpdates(parsed.updates, existingDatabases);
        }

        // Backward-compatible: still expose .updates (the full proposed set, now
        // annotated). .applied is the new committed/changed subset for pipeline.js.
        return { ...parsed, applied, tokensIn, tokensOut };
    } catch (error) {
        addDebugLog('fail', `Agent 3 error: ${error.message || error}`);
        console.error('[BFMemory] Agent 3 (Memory) error:', error);
        return { updates: [], summary: '', raw: '', error: error.message, tokensIn: 0, tokensOut: 0 };
    }
}

/**
 * Build the prompt for Agent 3
 */
function buildMemoryPrompt(messageText, characterInfo, existingDatabases, isUserMessage, userPersona, priorMessages = []) {
    const sysPrompt = getSettingsSafe()?.memoryPrompt || DEFAULT_MEMORY_PROMPT;

    // Resolve {{user}} / {{char}} macros via ST's canonical substituteParams
    const ctx = SillyTavern.getContext();
    const substitute = ctx.substituteParams || ctx.substituteParamsExtended || (s => s);
    const systemPrompt = substitute(sysPrompt);

    // User message: data to analyze
    const dataParts = [];
    if (characterInfo) {
        dataParts.push(`## Character Info ({{char}})\n${characterInfo}`);
    }
    if (userPersona) {
        dataParts.push(`## User Persona ({{user}})\n${userPersona}`);
    }

    const dbSummary = summarizeDatabases(existingDatabases);
    if (dbSummary) {
        dataParts.push(`## Existing Databases\n${dbSummary}`);
    }

    // Tag the source role so the model can't collapse user disclosures into RP narrative.
    // If prior context messages are given, include them in the analyzed block so
    // user-side self-disclosures and earlier reveals get captured (otherwise Agent 3
    // only sees the AI's N-1 message and misses things like "I'm Bernd, I work at Google").
    const roleTag = isUserMessage ? '[USER:{{user}}]' : '[CHAR:{{char}}]';
    let messageBlock = '';
    if (Array.isArray(priorMessages) && priorMessages.length > 0) {
        // Render prior context messages tagged by role
        const priorBlock = priorMessages
            .map(m => `${m.role === 'USER' ? '[USER:{{user}}]' : '[CHAR:{{char}}]'} ${m.text}`)
            .join('\n\n');
        messageBlock = `${priorBlock}\n\n${roleTag} ${messageText}`;
    } else {
        messageBlock = `${roleTag} ${messageText}`;
    }
    dataParts.push(`## Messages to Analyze\n${messageBlock}`);
    dataParts.push('\nExtract facts from EITHER message. Now output ONLY #MEM and #WHY sections.');

    // Resolve macros in the data block too
    return { systemPrompt, userPrompt: substitute(dataParts.join('\n\n')) };
}

/**
 * Summarize databases for the prompt (compact, mirrors output format)
 */
function summarizeDatabases(databases) {
    if (!databases || Object.keys(databases).length === 0) return '(No databases yet)';

    const lines = [];
    for (const [category, db] of Object.entries(databases)) {
        for (const fact of db.facts) {
            const known = fact.knownBy?.length ? ` | @${fact.knownBy.join(',')}` : '';
            const tags = fact.tags?.length ? ` | #${fact.tags.join(',')}` : '';
            lines.push(`${category}/${fact.key} = ${fact.value}${known}${tags}`);
        }
    }
    return lines.join('\n');
}

/**
 * Parse Agent 3's compact #MEM format response
 * Format: + Category/key = value | @KnownBy | #tags | rel:keys | @src:user|char
 * @param {string} response
 * @param {number} messageIndex - CHAR message index (default attribution)
 * @param {number|null} userMsgIndex - USER message index; facts tagged @src:user map here
 */
function parseMemoryUpdateResult(response, messageIndex, userMsgIndex = null) {
    const result = {
        updates: [],
        summary: '',
        raw: response,
        error: null,
    };

    if (!response || !response.trim()) {
        result.error = 'Empty response from memory updater';
        return result;
    }

    // Strip markdown code fences if model wraps output
    let text = response.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*/g, '').trim());
    text = text.replace(/```/g, '');

    // LEGACY FALLBACK: if response uses old #Facts: JSON format, parse that instead
    if (text.includes('#Facts:') && text.includes('"category"')) {
        return parseLegacyJsonFormat(text, messageIndex);
    }

    // Extract #WHY / #SUMMARY section
    const whyMatch = text.match(/#(?:WHY|SUMMARY)\s*([\s\S]*?)$/i);
    if (whyMatch) {
        result.summary = whyMatch[1].trim();
    }

    // Extract #MEM section
    const memMatch = text.match(/#MEM\s*([\s\S]*?)(?=\n\s*#WHY|\n\s*#SUMMARY|$)/i);
    if (!memMatch) return result;

    const memBlock = memMatch[1].trim();

    // If just "." or "(none)" or empty — nothing to store
    if (!memBlock || memBlock === '.' || /^\(none\)$/i.test(memBlock)) {
        return result;
    }

    const VALID_CATEGORIES = ['identity', 'relationships', 'world', 'history', 'status', 'behavior'];

    for (const rawLine of memBlock.split('\n')) {
        // Strip leading bullets, numbering, whitespace
        let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
        if (!line || line === '.') continue;

        // Must start with +
        if (!line.startsWith('+')) continue;
        line = line.slice(1).trim();

        // Parse: Category/key = value | @KnownBy | #tags
        // Split on = first (rejoin if value contains =)
        const eqIdx = line.indexOf('=');
        if (eqIdx < 0) continue;

        const pathPart = line.slice(0, eqIdx).trim();
        const rest = line.slice(eqIdx + 1).trim();

        // Parse category/key from path
        const slashIdx = pathPart.indexOf('/');
        let category, key;
        if (slashIdx >= 0) {
            category = pathPart.slice(0, slashIdx).trim();
            key = pathPart.slice(slashIdx + 1).trim();
        } else {
            // No slash — treat whole thing as key, default to Status
            category = 'Status';
            key = pathPart;
        }

        // Normalize category (capitalize first letter)
        category = category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
        if (!VALID_CATEGORIES.includes(category.toLowerCase())) {
            category = 'Status'; // fallback
        }

        // Clean key to snake_case
        key = key.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
        if (!key) continue;

        // Split rest on | to get value, @knownBy, #tags, rel:, @src:, track:, >context
        const segments = rest.split('|').map(s => s.trim());
        const value = segments[0] || '';
        let knownBy = [];
        let tags = [];
        let relationships = [];
        let srcRole = null; // 'user' | 'char' | null (unknown → default attribution)
        let context = '';   // Feature #3: optional prose note (delimiter: a `>` segment)
        let track = '';     // Feature #4: optional sequence track name (`track:<name>`)
        let ord = null;     // Feature #4: optional explicit step number (auto-assigned if absent)

        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i].trim();

            // >context — OPTIONAL prose note (Feature #3). `>` was chosen because it
            // does NOT collide with the existing |/@/#/rel:/@src: grammar. Only attach
            // when the surrounding situation genuinely matters (see prompt).
            if (seg.startsWith('>')) {
                context = seg.slice(1).trim();
                continue;
            }

            // track:<name>[#ord] — OPTIONAL sequence step (Feature #4). The ord is
            // normally OMITTED (auto-assigned in database.js); an explicit `#N` is
            // honored if present.
            const trackMatch = seg.match(/^track\s*:\s*(.+)$/i);
            if (trackMatch) {
                let t = trackMatch[1].trim();
                const ordMatch = t.match(/#\s*(\d+)\s*$/);
                if (ordMatch) {
                    ord = parseInt(ordMatch[1], 10);
                    t = t.slice(0, ordMatch.index).trim();
                }
                track = t.replace(/\s+/g, '_').toLowerCase();
                continue;
            }

            // @src:user / @src:char — per-fact source attribution (FIX #3).
            // Checked BEFORE the generic @KnownBy branch since both start with '@'.
            const srcMatch = seg.match(/^@src\s*:\s*(user|char)/i);
            if (srcMatch) {
                srcRole = srcMatch[1].toLowerCase();
                continue;
            }

            // @KnownBy
            if (seg.startsWith('@')) {
                knownBy = seg.slice(1).split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }

            // #tags
            if (seg.startsWith('#')) {
                tags = seg.slice(1).split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }

            // rel:keywords (optional relationship hints)
            if (seg.startsWith('rel:')) {
                relationships = seg.slice(4).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                continue;
            }

            // Fallback: try known patterns
            const knowsMatch = seg.match(/^(?:knows|knownby|known\s*by)\s*:\s*(.+)/i);
            if (knowsMatch) {
                knownBy = knowsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }
            const tagsMatch = seg.match(/^(?:tags?)\s*:\s*(.+)/i);
            if (tagsMatch) {
                tags = tagsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
            }
        }

        // Attribute the fact to the correct message. A user-disclosed fact tagged
        // @src:user maps to the USER message index (when available); everything else
        // (char-sourced or untagged) keeps the existing messageIndex behavior so this
        // stays backward-compatible and matches the per-message-icon path.
        const sourceIndex = (srcRole === 'user' && Number.isInteger(userMsgIndex))
            ? userMsgIndex
            : messageIndex;

        const update = {
            action: 'add',
            category,
            key,
            value,
            tags,
            knownBy,
            relationships,
            source: `msg_${sourceIndex}`,
        };
        // Feature #3: only attach context when present (keep object lean / back-compat).
        if (context) update.context = context;
        // Feature #4: only attach sequence info when a track was given.
        if (track) {
            update.track = track;
            if (Number.isInteger(ord) && ord > 0) update.ord = ord;
        }
        result.updates.push(update);
    }

    console.log(`[BFMemory] Agent 3: ${result.updates.length} updates, summary: "${result.summary.substring(0, 100)}"`);
    return result;
}

/**
 * Apply parsed updates to databases and save.
 *
 * For each update, determine whether it actually changed stored state (FIX #5):
 *   - NEW     : no existing fact matched this key — a brand-new fact was added.
 *   - UPDATED : an existing fact matched and its value or tags changed.
 *   - SKIPPED : an existing fact matched and value + tags are identical (no-op).
 * Each update is annotated with `.status` and `.changed`, and `.wasNew` is kept
 * for backward compatibility. Returns the subset that actually changed state
 * (status NEW or UPDATED) so the caller can feed "Last Inserted" the truly
 * committed facts rather than the full proposed set.
 *
 * @param {Array} updates - Parsed fact updates (mutated in place: annotated)
 * @param {Object} existingDatabases - Current databases
 * @returns {Promise<Array>} the changed (committed) subset of updates
 */
async function applyUpdates(updates, existingDatabases) {
    const modified = new Set();
    const applied = [];

    for (const update of updates) {
        const category = update.category;

        // Get or create database
        if (!existingDatabases[category]) {
            existingDatabases[category] = createEmptyDatabase(category);
            addDebugLog('info', `Created new database: "${category}"`);
        }

        const db = existingDatabases[category];

        // Classify BEFORE writing, using the same match rule upsertFact uses.
        // Sequence facts (Feature #4) are exempt from normalized collapse, so they
        // match ONLY by exact key — a fresh step is correctly classified NEW instead
        // of UPDATED against a sibling step that shares the normalized key.
        const matched = update.track
            ? (db.facts.find(f => f.key === update.key) || null)
            : findFactMatch(db, update.key);
        const newValue = update.value || '';
        const newTags = update.tags || [];
        let status;
        if (!matched) {
            status = 'NEW';
        } else if (sameValue(matched.value, newValue) && sameTags(matched.tags, newTags)) {
            status = 'SKIPPED'; // no-op: value + tags identical to stored fact
        } else {
            status = 'UPDATED';
        }

        // Surface status to pipeline.js so the Last Inserted tab can show it.
        update.status = status;
        update.changed = status !== 'SKIPPED';
        update.wasNew = status === 'NEW'; // kept for backward compatibility

        const factToWrite = {
            key: update.key,
            value: newValue,
            tags: newTags,
            knownBy: update.knownBy || [],
            relationships: {
                primary: Array.isArray(update.relationships) ? update.relationships : [],
                secondary: [],
                tertiary: [],
            },
            source: update.source,
        };
        // Feature #3 / #4: forward optional context + sequence info so upsertFact can
        // store the note and treat track facts as exempt-from-collapse ordered steps.
        if (update.context) factToWrite.context = update.context;
        if (update.track) {
            factToWrite.track = update.track;
            if (Number.isInteger(update.ord) && update.ord > 0) factToWrite.ord = update.ord;
        }
        upsertFact(db, factToWrite);
        const relCount = update.relationships?.length || 0;
        addDebugLog('info', `${status} fact: [${category}] ${update.key} = "${newValue.substring(0, 80)}"${relCount > 0 ? ` (rel: ${relCount})` : ''}`);

        if (update.changed) applied.push(update);
        // Only re-save a category whose stored state actually changed — a run of
        // pure SKIPPED no-ops needn't trigger an attachment re-upload.
        if (update.changed) modified.add(category);
    }

    // Save all modified databases
    for (const category of modified) {
        try {
            await saveDatabase(existingDatabases[category]);
            const factCount = existingDatabases[category].facts.length;
            addDebugLog('pass', `Saved database "${category}" (${factCount} facts)`);
        } catch (error) {
            addDebugLog('fail', `Failed to save database "${category}": ${error.message}`);
        }
    }

    return applied;
}

/** Loose value equality for no-op detection (trim + case-insensitive). */
function sameValue(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/** Order-insensitive tag-set equality for no-op detection. */
function sameTags(a, b) {
    const norm = arr => (Array.isArray(arr) ? arr : [])
        .map(t => String(t).trim().toLowerCase())
        .filter(Boolean)
        .sort();
    const x = norm(a), y = norm(b);
    if (x.length !== y.length) return false;
    return x.every((v, i) => v === y[i]);
}

/**
 * Legacy fallback: parse old #Facts: JSON format (for cached prompts that haven't been reset)
 */
function parseLegacyJsonFormat(response, messageIndex) {
    const result = { updates: [], summary: '', raw: response, error: null };

    const summaryMatch = response.match(/#Summary:?\s*([\s\S]*?)$/i);
    if (summaryMatch) result.summary = summaryMatch[1].trim();

    const factsMatch = response.match(/#Facts:?\s*([\s\S]*?)(?=#Summary|$)/i);
    if (!factsMatch || factsMatch[1].trim() === '(none)') return result;

    // Extract JSON objects via brace counting
    const text = factsMatch[1].trim();
    let i = 0;
    while (i < text.length) {
        if (text[i] === '{') {
            let depth = 0, start = i;
            while (i < text.length) {
                if (text[i] === '{') depth++;
                else if (text[i] === '}') { depth--; if (depth === 0) break; }
                i++;
            }
            try {
                const fact = JSON.parse(text.substring(start, i + 1));
                if (fact.category && fact.key) {
                    result.updates.push({
                        action: 'add',
                        category: fact.category,
                        key: fact.key,
                        value: fact.value || '',
                        tags: fact.tags || [],
                        knownBy: fact.knownBy || [],
                        source: `msg_${messageIndex}`,
                    });
                }
            } catch { /* skip malformed */ }
        }
        i++;
    }

    addDebugLog('info', `Parsed legacy JSON format (${result.updates.length} facts). Reset your Memory Updater prompt for the new compact format.`);
    return result;
}

/**
 * @typedef {Object} MemoryUpdateResult
 * @property {Array} updates - Parsed fact updates
 * @property {string} summary - Human-readable summary
 * @property {string} raw - Raw LLM response
 * @property {string|null} error
 */
