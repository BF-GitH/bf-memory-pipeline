// BF Memory Pipeline - Agent 1: Draft Planner
// Receives recent chat + character cards + system prompt
// Outputs: draft reply idea + list of needed fact categories

import { addDebugLog } from './settings.js';
import { callAgentLLM } from './llm-call.js';

// Lazy import to avoid circular dependency (settings imports our DEFAULT_DRAFT_PROMPT)
function getSettingsSafe() {
    try { return SillyTavern.getContext().extensionSettings?.['bf-memory-pipeline']; } catch { return null; }
}

export const DEFAULT_DRAFT_PROMPT = `You are a roleplay draft planner. Your job is to:
1. Read the recent chat messages and character information
2. Plan what the character should do/say next
3. List what facts would be needed to write a good, consistent reply

OUTPUT FORMAT (follow exactly):
#Draft:
[Write 1-3 sentences describing what the character would do/say. Include the emotional tone and any actions.]

#Needed_Facts:
[Semicolon-separated list of facts to look up. Be specific.]
[PREFER exact keys from the Existing Facts inventory below, written as Category/key (e.g. <CATEGORY>/<KEY>). You may also add free-text keywords (e.g. <NAME> appearance) for anything the inventory doesn't cover.]

RULES:
- Keep the draft SHORT - just the idea, not the full response
- List ALL facts that would help write a consistent reply
- When a needed fact already EXISTS in the inventory, request it by its exact Category/key — do not invent a new keyword for it
- Include character facts, location details, relationship info, object properties
- Think about what the characters KNOW vs don't know
- Consider the emotional state and setting`;

/**
 * Run Agent 1: Generate a draft and needed facts list
 * @param {string} recentChat - Formatted recent chat messages
 * @param {string} characterInfo - Character card/description
 * @param {string} userPersona - User's persona description
 * @param {string|null} profileId
 * @param {string} factInventory - Compact `Category/key` inventory of existing facts
 *   (keys only, no values). Lets Agent 1 request EXACT keys that exist instead of
 *   free-associating keyword strings. Optional — empty when no facts stored yet.
 * @returns {Promise<DraftResult>}
 */
export async function runDraftAgent(recentChat, characterInfo, userPersona, profileId = null, factInventory = '') {
    const { systemPrompt, userPrompt } = buildDraftPrompt(recentChat, characterInfo, userPersona, factInventory);
    addDebugLog('info', `Agent 1 prompt: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

    try {
        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId);
        addDebugLog('info', `Agent 1 LLM reply (${resultStr.length} chars):\n${resultStr}`);
        const ctx = SillyTavern.getContext();
        const tokensIn = await (ctx.getTokenCountAsync?.(systemPrompt + '\n' + userPrompt) ?? 0);
        const tokensOut = await (ctx.getTokenCountAsync?.(resultStr) ?? 0);
        return { ...parseDraftResult(resultStr), tokensIn, tokensOut };
    } catch (error) {
        addDebugLog('fail', `Agent 1 error: ${error.message || error}`);
        console.error('[BFMemory] Agent 1 (Draft) error:', error);
        return { draft: '', neededFacts: [], raw: '', error: error.message, tokensIn: 0, tokensOut: 0 };
    }
}

/**
 * Build the prompt for Agent 1
 */
function buildDraftPrompt(recentChat, characterInfo, userPersona, factInventory = '') {
    const sysPrompt = getSettingsSafe()?.draftPrompt || DEFAULT_DRAFT_PROMPT;

    // System message: pure instruction, no RP content
    const systemPrompt = sysPrompt;

    // User message: all the data the agent needs to analyze
    const dataParts = [];
    if (characterInfo) {
        dataParts.push(`## Character Info\n${characterInfo}`);
    }
    if (userPersona) {
        dataParts.push(`## User Persona\n${userPersona}`);
    }
    // Existing-fact inventory (Category/key only). Gives Agent 1 a menu of exact keys
    // to request so retrieval can resolve them by identity rather than fuzzy guessing.
    if (factInventory && factInventory.trim()) {
        dataParts.push(`## Existing Facts (request these by exact Category/key)\n${factInventory.trim()}`);
    }
    dataParts.push(`## Recent Chat\n${recentChat}`);
    dataParts.push('\nNow output ONLY #Draft: and #Needed_Facts: sections.');

    return { systemPrompt, userPrompt: dataParts.join('\n\n') };
}

/**
 * Parse Agent 1's response into structured data
 * @param {string} response
 * @returns {DraftResult}
 */
function parseDraftResult(response) {
    const result = {
        draft: '',
        neededFacts: [],
        raw: response,
        error: null,
    };

    if (!response || !response.trim()) {
        result.error = 'Empty response from draft agent';
        return result;
    }

    // Extract draft section
    const draftMatch = response.match(/#Draft:?\s*([\s\S]*?)(?=#Needed_Facts|#Needed Facts|$)/i);
    if (draftMatch) {
        result.draft = draftMatch[1].trim();
    }

    // Extract needed facts section
    const factsMatch = response.match(/#Needed[_ ]Facts:?\s*([\s\S]*?)$/i);
    if (factsMatch) {
        const factsRaw = factsMatch[1].trim();
        // Split by semicolons, newlines, or commas
        result.neededFacts = factsRaw
            .split(/[;\n,]+/)
            .map(f => f.trim())
            .filter(f => f.length > 0);
    }

    // If parsing failed, try to extract any useful keywords
    if (result.neededFacts.length === 0 && result.draft) {
        // Extract capitalized words as fallback keywords
        const words = result.draft.match(/[A-Z][a-z]+/g) || [];
        result.neededFacts = [...new Set(words)];
    }

    console.log(`[BFMemory] Agent 1 Draft: "${result.draft.substring(0, 100)}"`);
    console.log(`[BFMemory] Agent 1 Needed Facts: ${result.neededFacts.join('; ')}`);

    return result;
}

/**
 * @typedef {Object} DraftResult
 * @property {string} draft - The draft reply idea
 * @property {string[]} neededFacts - List of fact categories/keywords to look up
 * @property {string} raw - Raw LLM response
 * @property {string|null} error - Error message if failed
 */
