// BF Memory Pipeline - Agent 3: Memory Updater
// Runs AFTER the response is displayed, processes N-1 message
// Updates fact databases, tracks who knows what, manages cross-references

import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact, findFactMatch, normalizeScope, NPC_SUBJECT } from './database.js';
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

CATEGORIES: Identity, Relationships, World, History, Status, Behavior. If a fact fits NONE of these six, put it in Unsorted (the catch-all) rather than forcing a wrong category.

# OUTPUT FORMAT

#MEM
+ Category/key_snake_case = atomic value | @WhoKnows1,WhoKnows2 | #tag1,tag2 | rel:related_keys | @src:user | track:<track_name> | !3 | kind:trait | subj:who_or_what | scope:character | with:<NAME>,<OBJECT> | at:<PLACE> | aka:nickname,role | conf:high | >context note
.
#WHY <one sentence>

If nothing: just \`.\` immediately.

SOURCE TAG (optional but preferred): append \`| @src:user\` if the fact was disclosed in the [USER] message, or \`| @src:char\` if it came from the [CHAR] message. This attributes each fact to the correct message. If you cannot tell, omit it.

CONTEXT NOTE (optional, RARE): append \`| >...\` with a SHORT prose note ONLY when the fact's meaning depends on the surrounding situation and would be misread without it — e.g. a strategic admission that only makes sense once you know another party baited it. Do NOT add a context note to ordinary facts; most facts have none. The note is stored separately and never affects keyword search.

ALIASES (optional, only when useful): append \`| aka:...\` with a few comma-separated SHORT alternative names a LATER message might use for this fact's subject — a nickname, a role, or a descriptor (e.g. for a specific person: a pet name or "the man by the window"). This helps retrieval find the fact when the chat paraphrases instead of using the literal value. Aliases are search-only and never shown verbatim. Omit unless an alternative name is genuinely likely.

IMPORTANCE + KIND (MANDATORY — put both on EVERY fact): append \`| !N\` where N is 1-5 (how foundational: 5 = core identity like a name/species/age, 4 = important, 3 = ordinary, 2 = minor, 1 = trivial/passing) AND \`| kind:trait|state|event\` (trait = durable identity/personality; state = current/transient mood, goal, or location; event = something that happened). These protect foundational facts from eviction and rank what's retrieved. Quick rule: a name/species/origin is \`!5 kind:trait\`; a current mood/location is \`!1-2 kind:state\`; a thing that happened is \`kind:event\`. Example: \`+ Identity/user_name = <NAME> | !5 | kind:trait\`. Do NOT omit them.

SUBJECT (recommended): append \`| subj:<who_or_what>\` naming the character/place the fact is ABOUT (e.g. \`subj:<NAME>\`). If you omit it, the system derives the subject from the key prefix, so prefer keys that START with the subject (\`<NAME>_hair = ...\`).

SCOPE (recommended): append \`| scope:character|place|event\`. \`character\` = sticks to a person (traits/state/behavior); \`place\` = a location/world thing recalled when the PLACE matters even if its owner is absent; \`event\` = something that happened (anchored to a place + people + time). If omitted the system infers it from category (World→place, History→event, else character). For a PLACE fact also set \`| subj:<PLACE>\` so the location files under the place, not its owner — write \`+ World/<NAME>_<PLACE>_decor = ... | subj:<PLACE> | scope:place\`.

INVOLVED (optional): append \`| with:<A>,<B>\` listing the participants/entities IN the fact (distinct from @WhoKnows = who KNOWS it). If omitted the system auto-fills it. Use it especially to NAME an unnamed person (see NPC below).

NPC DRAWER (important): for a fact about an UNNAMED or one-off/incidental person (a passing stranger, "the man by the window", an unnamed waiter), file it under the shared subject by writing \`| subj:npc\` AND name the person in \`| with:<the descriptor>\` (e.g. \`| subj:npc | with:the man by the window\`). Keep the category/kind as normal. This stops walk-ons from cluttering the store; a later step promotes them once they get a real name.

LOCATION (optional, events): for an \`scope:event\` fact, append \`| at:<PLACE>\` naming WHERE it happened (a place subject/key). Pair with \`with:\` (who) so the event links place⇄people. Example: \`+ History/char_admission = ... | scope:event | at:<PLACE> | with:<NAME>\`.

CONFIDENCE (optional): append \`| conf:high|med|low\` (or a 0-1 number) when the fact is uncertain or inferred rather than plainly stated. Omit for plainly-stated facts (treated as high).

SUPERSEDES (optional): when a write REPLACES the prior value of an existing CHANGEABLE-STATE fact (a status, a current location, a goal now resolved — not a durable trait like a name), append \`| ~\` to mark the old value as ended history while the key becomes the new current truth. Only for \`kind:state\` facts whose value genuinely changed; omit for trait corrections and unchanged re-mentions (the system also infers this for changed kind:state facts, so \`~\` is optional).

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
Input: [USER:{{user}}] "I'm <NAME>. I work at <ORG> in <CITY> as a <ROLE>. I love <FOOD>, I'm allergic to <ALLERGEN>, and honestly I'm exhausted today."

#MEM
+ Identity/user_name      = <NAME>     | @{{user}},{{char}} | #identity | @src:user | !5 | kind:trait
+ Identity/user_employer  = <ORG>      | @{{user}},{{char}} | #identity,job | @src:user | !4 | kind:trait
+ Identity/user_role      = <ROLE>     | @{{user}},{{char}} | #role | @src:user | !4 | kind:trait
+ Identity/user_location  = <CITY>     | @{{user}},{{char}} | #location | @src:user | !4 | kind:trait
+ Status/user_likes_food  = <FOOD>     | @{{user}},{{char}} | #preference,food | @src:user | !3 | kind:trait
+ Status/user_allergy     = <ALLERGEN> | @{{user}},{{char}} | #health,allergy | @src:user | !4 | kind:trait
+ Status/user_mood        = exhausted  | @{{user}},{{char}} | #mood | @src:user | !1 | kind:state
.
#WHY Foundational identity (name) is a high-importance durable trait (!5); current mood is a low-importance transient state (!1, kind:state) that should fade first under cap.

---
Input: [CHAR:{{char}}] *Pushes hair back, revealing a scar.* "Got it as a kid. Bad fall."

#MEM
+ Identity/char_scar         = true           | @{{char}},{{user}} | #appearance | @src:char | !3 | kind:trait | aka:the scar,old scar
+ Identity/char_scar_origin  = childhood fall | @{{char}},{{user}} | #backstory | @src:char | !3 | kind:trait
.
#WHY Lasting reveal in asterisks → atomic split: existence + origin. \`aka:\` on the scar so a later "that mark on your arm" still retrieves it.

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
+ Behavior/char_collar_tug = defensive tell | @{{char}},{{user}} | #tell,mannerism | !2 | kind:trait
.
#WHY Recurring mannerism with explicit trigger — distinct from one-off transient pose.

---
Input: [USER:{{user}}] "Scratch that — I moved last week, the previous place is wrong."

#MEM
+ Identity/user_location  = <NEW_PLACE>                | @{{user}},{{char}} | #location | !3 | kind:state | ~
+ History/user_relocated  = <OLD_PLACE> to <NEW_PLACE> | @{{user}},{{char}} | #event | !2 | kind:event
.
#WHY Same existing key user_location → it's a CHANGEABLE state, so `~` supersedes the old value (kept as history) and this becomes current. Add a History event for the move.

---
Input: [CHAR:{{char}}] "Fine — yes, I took it." *only said it after {{user}} pretended to already have proof.*

#MEM
+ History/char_admission = took the <ITEM> | @{{char}},{{user}} | #event | @src:char | !3 | kind:event | >only admitted because <NAME> bluffed having proof; not a free confession
.
#WHY The admission is misleading without the note that it was baited — context attached because the situation changes its meaning.

---
Input: [CHAR:{{char}}] *Leaves the <PLACE_A> and walks to the <PLACE_B>, then continues on to the <PLACE_C>.*

#MEM
+ World/char_location_1 = <PLACE_A> | @{{char}} | #location | !2 | kind:event | track:char_location
+ World/char_location_2 = <PLACE_B> | @{{char}} | #location | !2 | kind:event | track:char_location
+ World/char_location_3 = <PLACE_C> | @{{char}} | #location | !2 | kind:event | track:char_location
+ Status/char_location  = <PLACE_C> | @{{char}} | #location | !3 | kind:state
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
    // only sees the AI's N-1 message and misses things like "I'm <NAME>, I work at <ORG>").
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
            // Supersession: don't show Agent 3 the inactive history snapshots — it should
            // reason against the CURRENT state only (and not try to re-extract stale values).
            if (fact.active === false) continue;
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

    // VALID_CATEGORIES — the six topical buckets plus `unsorted`, the mandatory
    // "Lost & Found" catch-all (feature #1). A fact whose category matches none of the
    // six is routed to Unsorted instead of being silently mis-filed as Status.
    const VALID_CATEGORIES = ['identity', 'relationships', 'world', 'history', 'status', 'behavior', 'unsorted'];
    const UNSORTED_CATEGORY = 'Unsorted';

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
            // Feature #1: an unrecognized category goes to the Unsorted catch-all (NOT
            // silently mis-filed as Status). It's a real, valid home; later phases read it.
            category = UNSORTED_CATEGORY;
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
        let importance = null; // Salience feature: optional 1-5 (`!N` marker)
        let kind = '';         // Salience feature: optional trait|state|event (`kind:` marker)
        let supersedes = false; // Supersession feature: optional `~` marker (replaces prior value)
        let aliases = [];      // Layer A (alias retrieval): optional alt names/nicknames (`aka:` marker)
        let subject = '';      // Subject axis (feature): optional who/what the fact is about (`subj:` marker)
        let confidence = null; // Provenance (feature): optional 0-1 number or low|med|high (`conf:` marker)
        let scope = '';        // Scope (feature): optional character|place|event (`scope:` marker)
        let involved = [];     // Involved (feature): optional participants/entities IN the fact (`with:` marker)
        let location = '';     // Location-link (feature): optional WHERE an event happened (`at:` marker)

        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i].trim();

            // ~ / ~supersedes — OPTIONAL explicit supersession signal (temporal-validity
            // feature). Means "this write REPLACES the prior value of the same key; mark the
            // old value as superseded history." `~` was chosen because it does NOT collide
            // with the existing |/@/#/rel:/@src:/>/track:/!N/kind: grammar. Optional: if
            // omitted, supersession is still inferred for changed `kind:state` facts.
            if (/^~\s*(supersedes?)?$/i.test(seg)) {
                supersedes = true;
                continue;
            }

            // !N — OPTIONAL importance 1-5 (salience feature). `!` was chosen because it
            // does NOT collide with the existing |/@/#/rel:/@src:/>/track: grammar.
            const impMatch = seg.match(/^!\s*([1-5])\b/);
            if (impMatch) {
                importance = parseInt(impMatch[1], 10);
                continue;
            }

            // kind:<trait|state|event> — OPTIONAL fact kind (salience feature). Anything
            // else is ignored and falls back to the default kind at storage time.
            const kindMatch = seg.match(/^kind\s*:\s*(trait|state|event)\b/i);
            if (kindMatch) {
                kind = kindMatch[1].toLowerCase();
                continue;
            }

            // aka:<a, b, c> — OPTIONAL aliases (Layer A retrieval). Short alternative
            // names/nicknames/descriptors a future message might use for the fact's subject.
            // `aka:` was chosen because it does NOT collide with the existing
            // |/@/#/rel:/@src:/>/track:/!N/kind:/~ grammar (no marker starts with `a`).
            // MATCH-ONLY: folded into search text, never shown to the writer.
            const akaMatch = seg.match(/^aka\s*:\s*(.+)$/i);
            if (akaMatch) {
                aliases = akaMatch[1].split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }

            // subj:<who_or_what> — OPTIONAL subject axis (feature: subject axis). Names the
            // character/place the fact is ABOUT. `subj:` was chosen because it does NOT
            // collide with the existing |/@/#/rel:/@src:/>/track:/!N/kind:/aka:/~ grammar.
            // When omitted, the subject is DERIVED from the key prefix at storage time.
            const subjMatch = seg.match(/^subj\s*:\s*(.+)$/i);
            if (subjMatch) {
                subject = subjMatch[1].trim();
                continue;
            }

            // scope:<character|place|event> — OPTIONAL recall axis (scope feature). `scope:`
            // does NOT collide with the existing |/@/#/rel:/@src:/>/track:/!N/kind:/subj:/aka:/
            // conf:/~ grammar. When omitted the scope is INFERRED from category/track downstream.
            const scopeMatch = seg.match(/^scope\s*:\s*(character|place|event)\b/i);
            if (scopeMatch) {
                scope = scopeMatch[1].toLowerCase();
                continue;
            }

            // with:<a, b, c> — OPTIONAL participants/entities IN the fact (involved feature).
            // DISTINCT from @KnownBy (who KNOWS it) and subj: (the primary owner). `with:`
            // does NOT collide with the existing grammar (no marker starts with `w`). When
            // omitted, `involved` is AUTO-FILLED downstream from knownBy + value entities.
            const withMatch = seg.match(/^with\s*:\s*(.+)$/i);
            if (withMatch) {
                involved = withMatch[1].split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }

            // at:<place> — OPTIONAL where-link for an EVENT (location-link feature): the place
            // key/subject WHERE the fact happened. `at:` does NOT collide (the only other
            // `a`-prefixed marker is `aka:`, matched above by its own regex). Pairs with `with:`.
            const atMatch = seg.match(/^at\s*:\s*(.+)$/i);
            if (atMatch) {
                location = atMatch[1].trim();
                continue;
            }

            // conf:<high|med|low|0-1> — OPTIONAL provenance confidence (feature: provenance).
            // `conf:` does NOT collide with the existing grammar. Accepts a word or a 0-1 number.
            const confMatch = seg.match(/^conf\s*:\s*(high|med(?:ium)?|low|0?\.\d+|0|1(?:\.0+)?)\b/i);
            if (confMatch) {
                const c = confMatch[1].toLowerCase();
                confidence = /^[0-9.]+$/.test(c) ? parseFloat(c) : (c === 'medium' ? 'med' : c);
                continue;
            }

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

        // MANDATORY importance + kind (feature #3): the model is now told to put both on
        // every fact, but we don't trust it to never omit them. When a field is missing we
        // INFER a sensible value from observable signals instead of silently accepting the
        // bland default, and FLAG inferred-vs-stated so the UI can surface it. The clamp in
        // database.js stays as a final safety net.
        const kindStated = !!kind;
        const importanceStated = Number.isInteger(importance);
        const inferred = [];
        if (!kindStated) {
            kind = inferKindFromCategory(category, track);
            inferred.push('kind');
        }
        if (!importanceStated) {
            importance = inferImportance(category, kind, key);
            inferred.push('importance');
        }

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
        // Salience feature (now effectively MANDATORY): importance/kind are ALWAYS set —
        // either stated by the model or inferred above. `inferredFields` flags which were
        // filled in by us (vs stated) so the UI/debug can show it.
        if (Number.isInteger(importance)) update.importance = importance;
        if (kind) update.kind = kind;
        if (inferred.length) update.inferredFields = inferred;
        // Scope (feature): attach an explicit scope when given, else INFER it deterministically
        // from category/track. Always present downstream so place-filing/recall can use it.
        const resolvedScope = normalizeScope(scope) || inferScopeFromCategory(category, track);
        update.scope = resolvedScope;

        // Subject axis (feature): attach an explicit subject when given, else derive it
        // deterministically from the key prefix so the field is always present downstream.
        let resolvedSubject = subject || deriveSubjectFromKey(key);

        // PLACE-FILING FIX (scope feature): for a place fact, the SUBJECT must be the PLACE,
        // not the owning character. When the writer didn't give an explicit `subj:`, take the
        // SECOND key token (`<NAME>_<PLACE>...` -> `<PLACE>`) so the location is recallable
        // independently. (database.deriveSubject applies the same rule defensively on read.)
        if (resolvedScope === 'place' && !subject) {
            const tokens = String(key || '').split('_').filter(Boolean);
            if (tokens.length >= 2) resolvedSubject = tokens[1];
        }

        // NPC drawer (feature): a fact about an UNNAMED/incidental person routes to the shared
        // `npc` subject (KIND/category unchanged) so walk-ons don't mint a fresh subject each.
        // The provisional name/descriptor is RETAINED on the fact (`about`, and folded into
        // `involved`) so a later promotion step can migrate the right facts out. Never applies
        // to place/event scope or to {{user}}/{{char}}.
        let about = '';
        if (resolvedScope === 'character' && looksLikeUnnamedPerson(resolvedSubject)) {
            about = resolvedSubject;          // keep the descriptor for later promotion
            if (!involved.includes(about)) involved = [about, ...involved];
            resolvedSubject = NPC_SUBJECT;
        }
        update.subject = resolvedSubject;

        // Involved (feature): emit the writer's `with:` list when given, else AUTO-FILL from
        // knownBy + capitalized entity tokens in the value. Optional/cheap — only attached when
        // non-empty so back-compat facts stay lean.
        const resolvedInvolved = involved.length ? involved : autoFillInvolved(knownBy, value);
        if (resolvedInvolved.length) update.involved = resolvedInvolved;
        // NPC drawer: retain the provisional descriptor so promotion can find the right facts.
        if (about) update.about = about;
        // Location-link (feature): attach the event's where-link when the writer gave `at:`.
        if (location) update.location = location;
        // Provenance (feature): confidence when stated; validAt defaults to the source
        // message index (when the fact became true). Both kept optional/back-compat.
        if (confidence !== null && confidence !== '') update.confidence = confidence;
        if (Number.isInteger(sourceIndex)) update.validAt = sourceIndex;
        // Supersession feature: only attach the explicit signal when present (lean / back-compat).
        if (supersedes) update.supersedes = true;
        // Layer A: only attach aliases when the writer provided some (keep object lean / back-compat).
        if (aliases.length) update.aliases = aliases;
        result.updates.push(update);
    }

    console.log(`[BFMemory] Agent 3: ${result.updates.length} updates, summary: "${result.summary.substring(0, 100)}"`);
    return result;
}

/**
 * Infer a fact `kind` from its category when the writer omitted it (feature #3). Status is
 * the only inherently changeable bucket -> `state`; History is past occurrences -> `event`;
 * a track step (an ordered series item) is an `event`; everything else (Identity, Behavior,
 * Relationships, World, Unsorted) defaults to a durable `trait`. Conservative — biased
 * toward the slow-decaying `trait` so an inferred fact is never aggressively evicted.
 * @param {string} category
 * @param {string} track - non-empty when the fact is a sequence step
 * @returns {('trait'|'state'|'event')}
 */
function inferKindFromCategory(category, track) {
    if (track) return 'event';
    switch (String(category || '').toLowerCase()) {
        case 'status': return 'state';
        case 'history': return 'event';
        default: return 'trait';
    }
}

/**
 * Infer an `importance` (1-5) when the writer omitted it (feature #3). Small heuristic:
 * Identity facts are foundational (4); transient states are low (2); events are minor (2);
 * everything else is ordinary (3). Deliberately conservative so an inferred value never
 * outranks a model-stated !5 nor sinks below the old default by much.
 * @param {string} category
 * @param {string} kind
 * @param {string} key
 * @returns {number} 1..5
 */
function inferImportance(category, kind, key) {
    const cat = String(category || '').toLowerCase();
    if (cat === 'identity') return 4;          // names/species/age skew foundational
    if (kind === 'state') return 2;            // current mood/location fades fast
    if (kind === 'event') return 2;            // a single occurrence is usually minor
    return 3;                                  // ordinary default
}

/**
 * Infer a fact `scope` (character|place|event) from category + track when the writer omitted
 * the `scope:` marker (scope feature). Deterministic, mirrors database.deriveScope:
 *   - track/sequence step -> event
 *   - History             -> event
 *   - World               -> place
 *   - Status              -> character (current state of someone)
 *   - everything else (Identity/Behavior/Relationships/Unsorted) -> character
 * @param {string} category
 * @param {string} track - non-empty when the fact is a sequence step
 * @returns {('character'|'place'|'event')}
 */
function inferScopeFromCategory(category, track) {
    if (track) return 'event';
    switch (String(category || '').toLowerCase()) {
        case 'history': return 'event';
        case 'world': return 'place';
        case 'status': return 'character';
        default: return 'character';
    }
}

/**
 * Auto-fill the `involved` participant list (involved feature) when Agent 3 omitted the
 * `with:` marker. Cheap and conservative — derives from names already present in `knownBy`
 * plus capitalized entity tokens in the value (proper-noun-ish words: leading uppercase,
 * not the {{user}}/{{char}} macro residue, not a 1-char token). Deduped case-insensitively,
 * order preserved. Returns [] when nothing is derivable (caller leaves the field off).
 * @param {string[]} knownBy
 * @param {string} value
 * @returns {string[]}
 */
function autoFillInvolved(knownBy, value) {
    const seen = new Set();
    const out = [];
    const add = (raw) => {
        const s = String(raw ?? '').trim();
        if (!s) return;
        const k = s.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(s);
    };
    for (const n of (Array.isArray(knownBy) ? knownBy : [])) add(n);
    // Capitalized entity tokens in the value: a word starting uppercase, length >= 2. Strips
    // surrounding punctuation. Skips ALL-CAPS-only short tokens are still allowed (acronyms).
    const v = String(value || '');
    const tokenRe = /\b([A-Z][A-Za-z'\-]+)\b/g;
    let m;
    while ((m = tokenRe.exec(v)) !== null) {
        const tok = m[1];
        if (tok.length < 2) continue;
        add(tok);
    }
    return out;
}

/**
 * Detect whether a fact is about an UNNAMED / incidental person (NPC drawer feature). True
 * when the subject reads like a generic descriptor rather than a proper name — e.g. a role
 * or "the man by the window" — so the fact should route to the shared `npc` subject while
 * retaining its provisional descriptor for a later promotion step. Conservative: only fires
 * when the subject starts with a lowercase article/descriptor word or is empty AND the writer
 * gave no explicit proper subject. Never fires for {{user}}/{{char}} or a capitalized name.
 * @param {string} subject - the explicit-or-derived subject (may be '')
 * @returns {boolean}
 */
function looksLikeUnnamedPerson(subject) {
    const s = String(subject || '').trim();
    if (!s) return false;
    const lower = s.toLowerCase();
    if (lower === 'user' || lower === 'char' || lower === NPC_SUBJECT) return false;
    // Descriptor-style subjects: start with an article/quantifier ("the man by the window",
    // "a waiter"), OR a multi-word phrase whose first word is lowercase (a description, not a
    // proper name). A single capitalized token or a Capitalized multi-word proper name is
    // treated as a real name and NOT drawered (conservative — avoids hiding named characters).
    if (/^(the|a|an|some|that|this|one|another)\b/i.test(s)) return true;
    if (/\s/.test(s) && /^[a-z]/.test(s)) return true;
    return false;
}

/**
 * Deterministic subject derivation from a key prefix (token before the first underscore),
 * mirroring database.deriveSubject's key-fallback path so the parser can stamp a subject
 * without importing storage internals. `<name>_apartment_bed` -> `<name>`.
 * @param {string} key
 * @returns {string}
 */
function deriveSubjectFromKey(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return '';
    const us = k.indexOf('_');
    return us > 0 ? k.slice(0, us) : k;
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
        // Salience feature: forward importance/kind so upsertFact can merge (keep higher
        // importance) and persist them for eviction + retrieval scoring. These are now
        // always present (stated or inferred in the parser).
        if (Number.isInteger(update.importance)) factToWrite.importance = update.importance;
        if (update.kind) factToWrite.kind = update.kind;
        // Subject axis (feature): forward the (explicit-or-derived) subject so it's stored
        // as a real index axis. Confidence/validAt are provenance stamps (back-compat optional).
        if (update.subject) factToWrite.subject = update.subject;
        // Scope (feature): forward the (explicit-or-inferred) recall axis so deriveSubject/
        // retrieval can file place facts under the place and traverse place⇄event⇄people.
        if (update.scope) factToWrite.scope = update.scope;
        // Involved (feature): forward participants (writer-given or auto-filled) when present.
        if (Array.isArray(update.involved) && update.involved.length) factToWrite.involved = update.involved;
        // NPC drawer (feature): forward the provisional descriptor for a later promotion step.
        if (update.about) factToWrite.about = update.about;
        // Location-link (feature): forward the event's where-link when present.
        if (update.location) factToWrite.location = update.location;
        if (update.confidence !== undefined && update.confidence !== null && update.confidence !== '') {
            factToWrite.confidence = update.confidence;
        }
        if (Number.isInteger(update.validAt)) factToWrite.validAt = update.validAt;
        // Supersession feature: forward the explicit signal so upsertFact marks the prior
        // value of a changeable-state fact as superseded history (transient flag, not persisted).
        if (update.supersedes) factToWrite.supersedes = true;
        // Layer A: forward aliases so upsertFact can UNION them (dedupe) across re-mentions.
        if (Array.isArray(update.aliases) && update.aliases.length) factToWrite.aliases = update.aliases;
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
