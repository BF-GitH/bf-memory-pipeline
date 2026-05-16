// BF Memory Pipeline - Agent 3: Memory Updater
// Runs AFTER the response is displayed, processes N-1 message
// Updates fact databases, tracks who knows what, manages cross-references

import { getAllDatabases, saveDatabase, createEmptyDatabase, upsertFact } from './database.js';
import { addDebugLog } from './settings.js';

// Lazy import to avoid circular dependency (settings imports our DEFAULT_MEMORY_PROMPT)
function getSettingsSafe() {
    try { return SillyTavern.getContext().extensionSettings?.['bf-memory-pipeline']; } catch { return null; }
}

export const DEFAULT_MEMORY_PROMPT = `You are a fact extraction and database maintenance agent for a roleplay. Your job is to:
1. Read the new message and extract any NEW facts or UPDATED facts
2. Determine which characters now know each fact
3. Categorize facts into appropriate databases
4. Identify relationships between facts

DATABASE CATEGORIES - use existing ones when possible, create new ones only when needed.
Each database has max 50 facts. Keep facts concise.

FACT FORMAT:
For each fact, output a JSON object:
{
  "action": "add" | "update" | "delete",
  "category": "CategoryName",
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

RELATIONSHIP RULES:
- Primary: Direct logical connection (e.g. a specific item -> its category)
- Secondary: Contextual connection (e.g. a location -> things typically found there)
- Tertiary: Distant/thematic connection (e.g. a topic is mentioned -> a past event involving that topic)

OUTPUT FORMAT:
#Facts:
[One JSON object per line, one per fact to add/update/delete]

#Summary:
[1-2 sentences describing what changed]

If nothing needs updating, output:
#Facts:
(none)

#Summary:
No new facts to record.`;

/**
 * Run Agent 3: Analyze message and update databases
 * @param {string} messageText - The message to analyze
 * @param {number} messageIndex - Message index (for source tracking)
 * @param {string} characterInfo - Character card info
 * @param {Object} existingDatabases - Current state of all databases
 * @returns {Promise<MemoryUpdateResult>}
 */
export async function runMemoryUpdater(messageText, messageIndex, characterInfo, existingDatabases) {
    const context = SillyTavern.getContext();

    const prompt = buildMemoryPrompt(messageText, characterInfo, existingDatabases);
    addDebugLog('info', `Agent 3 prompt length: ${prompt.length} chars`);

    try {
        const result = await context.generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: true,
        });

        const resultStr = typeof result === 'string' ? result : String(result || '');
        addDebugLog('info', `Agent 3 LLM reply (${resultStr.length} chars): "${resultStr.substring(0, 400)}${resultStr.length > 400 ? '...' : ''}"`);

        const parsed = parseMemoryUpdateResult(resultStr, messageIndex);

        // Apply updates to databases
        if (parsed.updates.length > 0) {
            addDebugLog('info', `Agent 3 applying ${parsed.updates.length} updates...`);
            await applyUpdates(parsed.updates, existingDatabases);
        }

        return parsed;
    } catch (error) {
        const detail = error?.response ? ` [HTTP ${error.response.status}]` : '';
        addDebugLog('fail', `Agent 3 error${detail}: ${error.message || error}`);
        console.error('[BFMemory] Agent 3 (Memory) error:', error);
        return { updates: [], summary: '', raw: '', error: error.message };
    }
}

/**
 * Build the prompt for Agent 3
 */
function buildMemoryPrompt(messageText, characterInfo, existingDatabases) {
    let prompt = '[OOC: SYSTEM INSTRUCTION - Do NOT continue the roleplay. You are a fact extraction engine. Follow the instructions below and output ONLY the requested JSON format.]\n\n';
    prompt += (getSettingsSafe()?.memoryPrompt || DEFAULT_MEMORY_PROMPT) + '\n\n';

    if (characterInfo) {
        prompt += `#Character Info:\n${characterInfo}\n\n`;
    }

    // Include current database state (summarized)
    const dbSummary = summarizeDatabases(existingDatabases);
    if (dbSummary) {
        prompt += `#Existing Databases:\n${dbSummary}\n\n`;
    }

    prompt += `#New Message to Analyze:\n${messageText}\n\n`;
    prompt += '[OOC: Remember - output ONLY #Facts: and #Summary: sections. Do NOT write roleplay text. Output JSON objects for facts.]';

    return prompt;
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

    // Parse each JSON line
    const factsRaw = factsMatch[1].trim();
    const jsonMatches = factsRaw.match(/\{[^}]+\}/g) || [];

    for (const jsonStr of jsonMatches) {
        try {
            const fact = JSON.parse(jsonStr);
            if (fact.category && fact.key) {
                fact.source = `msg_${messageIndex}`;
                result.updates.push(fact);
            }
        } catch {
            // Try to be lenient with malformed JSON
            console.warn('[BFMemory] Failed to parse fact JSON:', jsonStr.substring(0, 100));
        }
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
