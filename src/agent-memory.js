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

export const DEFAULT_MEMORY_PROMPT = `You extract LASTING facts from roleplay messages between {{user}} (the human player) and {{char}} (the AI character). Most messages have ZERO facts. Max 3.

CRITICAL RULES:
- Treat first-person statements from {{user}} as FACTUAL self-disclosure (not roleplay).
- TRANSIENT ACTIONS in *asterisks* are NOT facts — for EITHER {{user}} OR {{char}}. Skip "*smiles*", "*sighs*", "*brushes hair*", "*nods*", etc. They are momentary poses, not lasting traits.
- LASTING REVEALS in *asterisks* ARE facts: "*revealing a scar from her childhood*", "*pulls out a vampire fang*". The distinction is permanence — does this say something durable about the entity, or is it a one-off action?
- OOC text in [OOC: ...] or [ooc: ...] brackets is META-COMMENTARY between the human player and the AI. NEVER extract OOC content as facts. Examples: "[OOC: brief replies tonight, busy]", "[OOC: forget what I said earlier]", "[OOC: my real name is X]" — all ignored.
- Quoted historical text ("Remember when you said 'X'?") is a QUOTE of prior dialogue, not a new disclosure. Don't re-extract the quoted content as a fresh fact.

DO NOT STORE: momentary actions, poses, gestures, emotions, dialogue quotes, obvious context, transient mood.
ONLY STORE: traits, backstory, identity (name/job/location/age), preferences, allergies, relationship shifts, world reveals, lasting status changes, recurring behaviors.

CATEGORIES: Identity, Relationships, World, History, Status, Behavior

OUTPUT FORMAT:
#MEM
+ Category/key_name = concise fact value | @WhoKnows1,WhoKnows2 | #tag1,tag2 | rel:related_key1,related_key2
.

RULES:
- One fact per line, starting with +
- key_name: short snake_case (e.g. user_employer, char_arm_scar, trust_level)
- value: plain text, concise as possible
- @: characters who know/witnessed this. Use {{user}} for the human player, {{char}} for the AI character (comma-separated, no spaces)
- #: search tags (comma-separated, no spaces)
- rel: (optional) keys or topic words for facts that should co-activate when this fact matches. Use snake_case keys, comma-separated, no spaces. Skip the segment entirely if no clear relationships exist.
- End fact list with a single . on its own line
- If NOTHING worth storing, just write . immediately
- After facts write #WHY with one sentence explaining your reasoning

EXAMPLES:

Input: [USER:{{user}}] "Hi! I'm Bernd. I work at Google in Berlin as a software engineer. I love pizza and I'm allergic to peanuts."

#MEM
+ Identity/user_name = Bernd | @{{user}},{{char}} | #identity,name,user | rel:user_employer_location
+ Identity/user_employer_location = Software engineer at Google in Berlin | @{{user}},{{char}} | #identity,job,location,user | rel:user_name,berlin,google
+ Status/user_peanut_allergy = Allergic to peanuts | @{{user}},{{char}} | #health,allergy,user | rel:user_name
.

#WHY
{{user}} disclosed durable identity facts: name, employer, location, occupation, allergy.

---

Input: [CHAR:{{char}}] *She pushes her hair back, revealing a jagged scar.* "Got it at seven. Greenhouse roof."

#MEM
+ Identity/char_facial_scar = Jagged scar, childhood greenhouse accident age 7 | @{{char}},{{user}} | #appearance,injury,backstory
.

#WHY
{{char}} revealed a permanent physical trait with backstory.

---

Input: [CHAR:{{char}}] They chat about the weather and eat lunch.

#MEM
.

#WHY
No lasting facts.

---

Input: [USER:{{user}}] *grins* "I love it when you do that."

#MEM
.

#WHY
Transient emotional reaction, not a lasting trait.

---

Input: [USER:{{user}}] [OOC: hey, can we slow the pacing? Also my persona name is Lyra but my real name is Bernd]

#MEM
.

#WHY
OOC meta-commentary, not in-character disclosure. Ignored per rules.

---

Input: [CHAR:{{char}}] *She brushes a strand of hair behind her ear, then smiles softly.* "Tell me again."

#MEM
.

#WHY
Pure transient action in asterisks, no lasting trait revealed.

---

Input: [USER:{{user}}] Remember when you said "I am the heir of Valdris"? Why did you lie?

#MEM
.

#WHY
{{user}} is quoting prior {{char}} dialogue, not disclosing a new fact about themselves.`;

/**
 * Run Agent 3: Analyze message and update databases
 * @param {string} messageText - The message to analyze
 * @param {number} messageIndex - Message index (for source tracking)
 * @param {string} characterInfo - Character card info
 * @param {Object} existingDatabases - Current state of all databases
 * @returns {Promise<MemoryUpdateResult>}
 */
export async function runMemoryUpdater(messageText, messageIndex, characterInfo, existingDatabases, profileId = null, isUserMessage = false, userPersona = '', prevUserMessage = null) {
    const { systemPrompt, userPrompt } = buildMemoryPrompt(messageText, characterInfo, existingDatabases, isUserMessage, userPersona, prevUserMessage);
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
function buildMemoryPrompt(messageText, characterInfo, existingDatabases, isUserMessage, userPersona, prevUserMessage = null) {
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
    // If a prior user message is given, include BOTH messages in the analyzed block so
    // user-side self-disclosures get captured (otherwise Agent 3 only sees the AI's N-1
    // message and misses things like "I'm Bernd, I work at Google").
    const roleTag = isUserMessage ? '[USER:{{user}}]' : '[CHAR:{{char}}]';
    const messageBlock = prevUserMessage
        ? `[USER:{{user}}] ${prevUserMessage}\n\n${roleTag} ${messageText}`
        : `${roleTag} ${messageText}`;
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
