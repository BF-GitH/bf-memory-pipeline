// BF Memory Pipeline - Agent 3: Memory Updater
// Runs AFTER the response is displayed, processes N-1 message
// Updates fact databases, tracks who knows what, manages cross-references

import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact } from './database.js';
import { addDebugLog } from './settings.js';
import { callAgentLLM } from './llm-call.js';

// Lazy import to avoid circular dependency (settings imports our DEFAULT_MEMORY_PROMPT)
function getSettingsSafe() {
    try { return SillyTavern.getContext().extensionSettings?.['bf-memory-pipeline']; } catch { return null; }
}

export const DEFAULT_MEMORY_PROMPT = `You extract LASTING facts from roleplay messages between {{user}} (the human player) and {{char}} (the AI character). Most messages have ZERO facts. Max 5.

# CRITICAL RULES

ATOMIC VALUES ONLY:
- Value is 1–5 words. NO sentences. NO connectives (and / with / who / that).
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
+ Category/key_snake_case = atomic value | @WhoKnows1,WhoKnows2 | #tag1,tag2 | rel:related_keys
.
#WHY <one sentence>

If nothing: just \`.\` immediately.

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
+ Identity/user_name      = <NAME>     | @{{user}},{{char}} | #identity
+ Identity/user_employer  = <ORG>      | @{{user}},{{char}} | #identity,job
+ Identity/user_role      = <ROLE>     | @{{user}},{{char}} | #role
+ Identity/user_location  = <CITY>     | @{{user}},{{char}} | #location
+ Status/user_likes_food  = <FOOD>     | @{{user}},{{char}} | #preference,food
+ Status/user_allergy     = <ALLERGEN> | @{{user}},{{char}} | #health,allergy
.
#WHY Rich self-disclosure → split each property into its own atomic fact.

---
Input: [CHAR:{{char}}] *Pushes hair back, revealing a scar.* "Got it as a kid. Bad fall."

#MEM
+ Identity/char_scar         = true           | @{{char}},{{user}} | #appearance
+ Identity/char_scar_origin  = childhood fall | @{{char}},{{user}} | #backstory
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

When uncertain whether something is a persistent fact, SKIP. A missing atomic fact is recoverable next turn; a wrong/verbose fact poisons future retrieval.`;

/**
 * Run Agent 3: Analyze message and update databases
 * @param {string} messageText - The message to analyze
 * @param {number} messageIndex - Message index (for source tracking)
 * @param {string} characterInfo - Character card info
 * @param {Object} existingDatabases - Current state of all databases
 * @returns {Promise<MemoryUpdateResult>}
 */
export async function runMemoryUpdater(messageText, messageIndex, characterInfo, existingDatabases, profileId = null, isUserMessage = false, userPersona = '', priorMessages = []) {
    const { systemPrompt, userPrompt } = buildMemoryPrompt(messageText, characterInfo, existingDatabases, isUserMessage, userPersona, priorMessages);
    addDebugLog('info', `Agent 3 prompt: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

    try {
        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId);
        addDebugLog('info', `Agent 3 LLM reply (${resultStr.length} chars):\n${resultStr}`);

        const parsed = parseMemoryUpdateResult(resultStr, messageIndex);

        // Apply updates to databases
        if (parsed.updates.length > 0) {
            addDebugLog('info', `Agent 3 applying ${parsed.updates.length} updates...`);
            await applyUpdates(parsed.updates, existingDatabases);
        }

        return parsed;
    } catch (error) {
        addDebugLog('fail', `Agent 3 error: ${error.message || error}`);
        console.error('[BFMemory] Agent 3 (Memory) error:', error);
        return { updates: [], summary: '', raw: '', error: error.message };
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
 * Format: + Category/key = value | @KnownBy | #tags
 */
function parseMemoryUpdateResult(response, messageIndex) {
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

        // Split rest on | to get value, @knownBy, #tags
        const segments = rest.split('|').map(s => s.trim());
        const value = segments[0] || '';
        let knownBy = [];
        let tags = [];
        let relationships = [];

        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i].trim();

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

        result.updates.push({
            action: 'add',
            category,
            key,
            value,
            tags,
            knownBy,
            relationships,
            source: `msg_${messageIndex}`,
        });
    }

    console.log(`[BFMemory] Agent 3: ${result.updates.length} updates, summary: "${result.summary.substring(0, 100)}"`);
    return result;
}

/**
 * Apply parsed updates to databases and save
 * @param {Array} updates - Parsed fact updates
 * @param {Object} existingDatabases - Current databases
 */
async function applyUpdates(updates, existingDatabases) {
    const modified = new Set();

    for (const update of updates) {
        const category = update.category;

        // Get or create database
        if (!existingDatabases[category]) {
            existingDatabases[category] = createEmptyDatabase(category);
            addDebugLog('info', `Created new database: "${category}"`);
        }

        const db = existingDatabases[category];
        const isNew = !db.facts.some(f => f.key === update.key);
        // Surface NEW/UPDATED status to pipeline.js so the Last Inserted tab can show it
        update.wasNew = isNew;

        upsertFact(db, {
            key: update.key,
            value: update.value || '',
            tags: update.tags || [],
            knownBy: update.knownBy || [],
            relationships: {
                primary: Array.isArray(update.relationships) ? update.relationships : [],
                secondary: [],
                tertiary: [],
            },
            source: update.source,
        });
        const relCount = update.relationships?.length || 0;
        addDebugLog('info', `${isNew ? 'Added' : 'Updated'} fact: [${category}] ${update.key} = "${(update.value || '').substring(0, 80)}"${relCount > 0 ? ` (rel: ${relCount})` : ''}`);

        modified.add(category);
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
