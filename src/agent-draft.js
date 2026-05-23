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

#Scene:
Location: [where the scene is happening right now, a few words]
Present: [comma-separated characters/entities currently in the scene]
Goals: [comma-separated active goals or open threads, short]
Beat: [ONE short line describing the single most recent thing that just happened]

RULES:
- Keep the draft SHORT - just the idea, not the full response
- List ALL facts that would help write a consistent reply
- When a needed fact already EXISTS in the inventory, request it by its exact Category/key — do not invent a new keyword for it
- Include character facts, location details, relationship info, object properties
- Think about what the characters KNOW vs don't know
- Consider the emotional state and setting
- The #Scene block describes the PRESENT MOMENT (current location, who is here, active goals, the latest beat). Keep each line terse. Omit a line only if truly unknown.`;

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
        return { draft: '', neededFacts: [], scene: null, raw: '', error: error.message, tokensIn: 0, tokensOut: 0 };
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
    dataParts.push('\nNow output ONLY the #Draft:, #Needed_Facts:, and #Scene: sections.');

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
        scene: null, // optional #SCENE parse: { location, present[], goals[], newBeats[] }
        raw: response,
        error: null,
    };

    if (!response || !response.trim()) {
        result.error = 'Empty response from draft agent';
        return result;
    }

    // Extract draft section
    const draftMatch = response.match(/#Draft:?\s*([\s\S]*?)(?=#Needed_Facts|#Needed Facts|#Scene|$)/i);
    if (draftMatch) {
        result.draft = draftMatch[1].trim();
    }

    // Extract needed facts section (bounded before #Scene so it doesn't swallow it)
    const factsMatch = response.match(/#Needed[_ ]Facts:?\s*([\s\S]*?)(?=#Scene|$)/i);
    if (factsMatch) {
        const factsRaw = factsMatch[1].trim();
        // Split by semicolons, newlines, or commas
        result.neededFacts = factsRaw
            .split(/[;\n,]+/)
            .map(f => f.trim())
            .filter(f => f.length > 0);
    }

    // Extract optional #Scene block (always-on scene card). Missing block → scene stays
    // null (back-compatible: pipeline simply doesn't update the scene this turn).
    result.scene = parseSceneBlock(response);

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
 * Parse the optional #Scene block from Agent 1's output into a scene patch.
 * Tolerant: any field may be absent. Returns null if no usable scene fields found.
 * @param {string} response
 * @returns {{location:string, present:string[], goals:string[], newBeats:string[]}|null}
 */
function parseSceneBlock(response) {
    // Grab everything from #Scene to the next #Section or end-of-text.
    const block = response.match(/#Scene:?\s*([\s\S]*?)(?=\n#[A-Za-z]|$)/i);
    if (!block) return null;
    const body = block[1];

    const line = (label) => {
        const m = body.match(new RegExp(`^\\s*${label}\\s*:?\\s*(.+)$`, 'im'));
        return m ? m[1].trim() : '';
    };
    const list = (s) => s
        .split(/[;,]+/)
        .map(x => x.trim())
        // Drop bracketed placeholders the model may have echoed verbatim.
        .filter(x => x.length > 0 && !/^\[.*\]$/.test(x) && !/^(none|n\/a|unknown|tbd)$/i.test(x));

    const location = line('Location');
    const present = list(line('Present'));
    const goals = list(line('Goals'));
    // Accept "Beat" (single) or "Beats" (plural list) — newest beat(s) for the rolling window.
    const beatLine = line('Beat') || line('Beats') || line('Recently');
    const newBeats = beatLine ? list(beatLine).filter(Boolean) : [];

    const cleanLoc = (/^\[.*\]$/.test(location) || /^(none|n\/a|unknown|tbd)$/i.test(location)) ? '' : location;

    if (!cleanLoc && present.length === 0 && goals.length === 0 && newBeats.length === 0) return null;
    return { location: cleanLoc, present, goals, newBeats };
}

/**
 * @typedef {Object} DraftResult
 * @property {string} draft - The draft reply idea
 * @property {string[]} neededFacts - List of fact categories/keywords to look up
 * @property {{location:string, present:string[], goals:string[], newBeats:string[]}|null} scene - Optional parsed #Scene block (null if absent)
 * @property {string} raw - Raw LLM response
 * @property {string|null} error - Error message if failed
 */
