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

export const DEFAULT_MEMORY_PROMPT = `You are a selective fact extraction agent for a roleplay. Extract ONLY facts that will still matter 10+ messages from now.

STRICT RULES - DO NOT STORE:
- Momentary positions/gestures ("sat down", "stood up", "turned around")
- Transient scene choreography ("pulled stool closer", "blanket on cot")
- Exact dialogue quotes (unless they reveal a LASTING truth)
- Momentary emotions/reactions ("surprised", "smiled")
- Things already obvious from context

ONLY STORE facts that are:
- Character traits, abilities, backstory, or identity
- Relationship changes (trust gained, conflict started, promises made)
- World/lore reveals (locations, rules, history)
- Lasting status changes (new injury, new possession, living situation change)
- Key decisions or turning points

BUDGET: Most messages have 0 facts worth storing. Rarely 1-2. Maximum 3 per message. When in doubt, store NOTHING.

FIXED CATEGORIES (use ONLY these):
- Identity: name, species, appearance, age, abilities, personality
- Relationships: how characters feel about each other, promises, conflicts
- World: locations, lore, rules, important objects, organizations
- History: backstory reveals, key past events, turning points
- Status: lasting state changes (injuries, possessions, living situation)

FACT FORMAT:
{
  "action": "add" | "update" | "delete",
  "category": "Identity" | "Relationships" | "World" | "History" | "Status",
  "key": "fact_identifier",
  "value": "concise fact description",
  "tags": ["tag1", "tag2"],
  "knownBy": ["Character1", "Character2"],
  "relationships": {
    "primary": ["DirectlyRelatedCategory"],
    "secondary": ["SomewhatRelatedCategory"],
    "tertiary": ["DistantlyRelatedCategory"]
  }
}

OUTPUT FORMAT:
#Facts:
[One JSON object per line, or (none)]

#Summary:
[1-2 sentences, or "No new facts to record."]`;

/**
 * Run Agent 3: Analyze message and update databases
 * @param {string} messageText - The message to analyze
 * @param {number} messageIndex - Message index (for source tracking)
 * @param {string} characterInfo - Character card info
 * @param {Object} existingDatabases - Current state of all databases
 * @returns {Promise<MemoryUpdateResult>}
 */
export async function runMemoryUpdater(messageText, messageIndex, characterInfo, existingDatabases) {
    const { systemPrompt, userPrompt } = buildMemoryPrompt(messageText, characterInfo, existingDatabases);
    addDebugLog('info', `Agent 3 prompt: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

    try {
        const resultStr = await callAgentLLM(systemPrompt, userPrompt);
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
function buildMemoryPrompt(messageText, characterInfo, existingDatabases) {
    const sysPrompt = getSettingsSafe()?.memoryPrompt || DEFAULT_MEMORY_PROMPT;

    // System message: pure instruction
    const systemPrompt = sysPrompt;

    // User message: data to analyze
    const dataParts = [];
    if (characterInfo) {
        dataParts.push(`## Character Info\n${characterInfo}`);
    }

    const dbSummary = summarizeDatabases(existingDatabases);
    if (dbSummary) {
        dataParts.push(`## Existing Databases\n${dbSummary}`);
    }

    dataParts.push(`## Message to Analyze\n${messageText}`);
    dataParts.push('\nNow output ONLY #Facts: and #Summary: sections.');

    return { systemPrompt, userPrompt: dataParts.join('\n\n') };
}

/**
 * Summarize databases for the prompt (keep it compact)
 */
function summarizeDatabases(databases) {
    if (!databases || Object.keys(databases).length === 0) return '(No databases yet)';

    const lines = [];
    for (const [category, db] of Object.entries(databases)) {
        const factKeys = db.facts.map(f => f.key).join(', ');
        lines.push(`[${category}] (${db.facts.length} facts): ${factKeys}`);
    }
    return lines.join('\n');
}

/**
 * Parse Agent 3's response
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

    // Extract summary
    const summaryMatch = response.match(/#Summary:?\s*([\s\S]*?)$/i);
    if (summaryMatch) {
        result.summary = summaryMatch[1].trim();
    }

    // Extract facts section
    const factsMatch = response.match(/#Facts:?\s*([\s\S]*?)(?=#Summary|$)/i);
    if (!factsMatch || factsMatch[1].trim() === '(none)') {
        return result;
    }

    // Parse each JSON object (handles nested braces via brace counting)
    const factsRaw = factsMatch[1].trim();
    const jsonObjects = extractJsonObjects(factsRaw);

    for (const jsonStr of jsonObjects) {
        try {
            const fact = JSON.parse(jsonStr);
            if (fact.category && fact.key) {
                fact.source = `msg_${messageIndex}`;
                result.updates.push(fact);
            }
        } catch {
            console.warn('[BFMemory] Failed to parse fact JSON:', jsonStr.substring(0, 100));
            addDebugLog('fail', `JSON parse error: ${jsonStr.substring(0, 80)}`);
        }
    }

    console.log(`[BFMemory] Agent 3: ${result.updates.length} updates, summary: "${result.summary.substring(0, 100)}"`);
    return result;
}

/**
 * Extract JSON objects from text, handling nested braces correctly.
 * @param {string} text
 * @returns {string[]} Array of JSON object strings
 */
function extractJsonObjects(text) {
    const objects = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] === '{') {
            let depth = 0;
            let start = i;
            while (i < text.length) {
                if (text[i] === '{') depth++;
                else if (text[i] === '}') {
                    depth--;
                    if (depth === 0) {
                        objects.push(text.substring(start, i + 1));
                        break;
                    }
                }
                i++;
            }
        }
        i++;
    }
    return objects;
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

        if (update.action === 'delete') {
            db.facts = db.facts.filter(f => f.key !== update.key);
            db.updatedAt = Date.now();
            addDebugLog('info', `Deleted fact: [${category}] ${update.key}`);
        } else {
            const isNew = !db.facts.some(f => f.key === update.key);
            upsertFact(db, {
                key: update.key,
                value: update.value || '',
                tags: update.tags || [],
                knownBy: update.knownBy || [],
                relationships: update.relationships || { primary: [], secondary: [], tertiary: [] },
                source: update.source,
            });
            addDebugLog('info', `${isNew ? 'Added' : 'Updated'} fact: [${category}] ${update.key} = "${(update.value || '').substring(0, 80)}"`);
        }

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
 * @typedef {Object} MemoryUpdateResult
 * @property {Array} updates - Parsed fact updates
 * @property {string} summary - Human-readable summary
 * @property {string} raw - Raw LLM response
 * @property {string|null} error
 */
