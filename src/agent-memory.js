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

export const DEFAULT_MEMORY_PROMPT = `You extract LASTING facts from roleplay messages. Most messages have ZERO facts. Max 3.

DO NOT STORE: momentary actions, poses, gestures, emotions, dialogue quotes, obvious context.
ONLY STORE: traits, backstory, relationship shifts, world reveals, lasting status changes, recurring behaviors.

CATEGORIES: Identity, Relationships, World, History, Status, Behavior

OUTPUT FORMAT:
#MEM
+ Category/key_name = concise fact value | @WhoKnows1,WhoKnows2 | #tag1,tag2
.

RULES:
- One fact per line, starting with +
- key_name: short snake_case (e.g. apple_allergy, arm_scar, trust_level)
- value: plain text, concise as possible
- @: characters who know/witnessed this (comma-separated, no spaces)
- #: search tags (comma-separated, no spaces)
- End fact list with a single . on its own line
- If NOTHING worth storing, just write . immediately
- After facts write #WHY with one sentence explaining your reasoning

EXAMPLES:

Input: Character A pushes hair back revealing a jagged scar. "Got it at seven. Greenhouse roof." Character B stares.

#MEM
+ Identity/char_a_facial_scar = Jagged scar temple to jaw, childhood greenhouse accident age 7 | @CharA,CharB | #appearance,injury,backstory
.

#WHY
Permanent physical trait with backstory revealed.

---

Input: They chat about the weather and eat lunch.

#MEM
.

#WHY
No lasting facts.

---

Input: Character B admits she already knew about Character A's past. Trust between them deepens.

#MEM
+ Relationships/b_knew_a_past = B already knew about A's past before he told her | @CharA,CharB | #trust,secrets
+ Relationships/a_b_trust = Deepened after mutual honesty about his past | @CharA,CharB | #trust,bond
.

#WHY
Relationship shift - mutual trust established.`;

/**
 * Run Agent 3: Analyze message and update databases
 * @param {string} messageText - The message to analyze
 * @param {number} messageIndex - Message index (for source tracking)
 * @param {string} characterInfo - Character card info
 * @param {Object} existingDatabases - Current state of all databases
 * @returns {Promise<MemoryUpdateResult>}
 */
export async function runMemoryUpdater(messageText, messageIndex, characterInfo, existingDatabases, profileId = null) {
    const { systemPrompt, userPrompt } = buildMemoryPrompt(messageText, characterInfo, existingDatabases);
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

    // Extract #WHY section
    const whyMatch = text.match(/#WHY\s*([\s\S]*?)$/i);
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
            relationships: { primary: [], secondary: [], tertiary: [] },
            source: update.source,
        });
        addDebugLog('info', `${isNew ? 'Added' : 'Updated'} fact: [${category}] ${update.key} = "${(update.value || '').substring(0, 80)}"`);

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
