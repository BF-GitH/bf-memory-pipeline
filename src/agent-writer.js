// BF Memory Pipeline - Agent 2: Writer
// Uses the DEFAULT SillyTavern profile (main model)
// Receives: draft + retrieved facts + character cards + system prompt
// Output: injected into the prompt so the main model writes a fact-grounded response

// Lazy access to avoid circular dependency (settings imports our DEFAULT_WRITER_FORMAT)
function getSettingsSafe() {
    try { return SillyTavern.getContext().extensionSettings?.['bf-memory-pipeline']; } catch { return null; }
}

export const DEFAULT_WRITER_FORMAT = `[Memory Context - established truth for this scene]

#Established Facts (Category/key = value):
{facts}

#Scene Direction:
{draft}

[How to use the facts above:
- Treat every fact as ESTABLISHED TRUTH. Weave the relevant ones into the scene naturally — through action, dialogue, and detail — rather than listing them.
- PREFER these stored facts over inventing new details. When a fact covers something, use it instead of making something up.
- Never contradict a fact. If the scene needs a detail a fact already defines, match the fact exactly.
- A character only knows facts whose [bracketed] names include that character. Do not let a character act on facts they don't know.]`;

/**
 * Build the compact always-on scene block (MemGPT-style core working memory).
 * One line: [Scene] Location: <loc> | Present: <a, b> | Goal: <g> | Recently: <b1>; <b2>
 * Hard-capped (~maxTokens) with defensive char-budget truncation so a runaway scene
 * can never blow up the prompt. Returns '' when no usable scene exists.
 * @param {object|null} scene - { location, present[], goals[], beats[] }
 * @param {number} [maxTokens=150] - approximate hard cap (1 token ≈ 4 chars heuristic)
 * @returns {string}
 */
export function buildSceneBlock(scene, maxTokens = 150) {
    if (!scene || typeof scene !== 'object') return '';
    const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()) : [];
    const loc = typeof scene.location === 'string' ? scene.location.trim() : '';
    const present = arr(scene.present);
    const goals = arr(scene.goals);
    const beats = arr(scene.beats);
    if (!loc && present.length === 0 && goals.length === 0 && beats.length === 0) return '';

    const parts = [];
    if (loc) parts.push(`Location: ${loc}`);
    if (present.length) parts.push(`Present: ${present.join(', ')}`);
    if (goals.length) parts.push(`Goal: ${goals.join('; ')}`);
    if (beats.length) parts.push(`Recently: ${beats.join('; ')}`);

    let block = `[Scene] ${parts.join(' | ')}`;

    // Hard cap: approximate tokens at 4 chars/token. Truncate the body defensively,
    // never letting the scene block exceed the budget (clip mid-string + ellipsis).
    const charBudget = Math.max(40, Math.floor((Number(maxTokens) || 150) * 4));
    if (block.length > charBudget) {
        block = block.slice(0, charBudget - 1).trimEnd() + '…';
    }
    return block;
}

/**
 * Build the fact injection block that gets inserted into the prompt
 * This doesn't call an LLM - it prepares context for the main generation
 * @param {string} draft - Draft from Agent 1
 * @param {string} factsFormatted - Formatted facts from retrieval
 * @param {string} [sceneBlock] - Optional compact scene block to prepend ABOVE facts
 * @returns {string} Injection text to add to the prompt
 */
export function buildWriterInjection(draft, factsFormatted, sceneBlock = '') {
    const settings = getSettingsSafe();

    const template = settings?.writerFormat || DEFAULT_WRITER_FORMAT;
    const factsText = (factsFormatted && factsFormatted !== '(No stored facts available)') ? factsFormatted : '(none available)';
    const draftText = draft || '(no direction)';

    // Single-pass regex substitution: avoids order-dependent re-substitution
    // (e.g. factsText containing literal "{draft}" can't get re-replaced)
    const vars = { facts: factsText, draft: draftText };
    let rendered = template.replace(/\{(facts|draft)\}/g, (_, key) => vars[key]);

    // Safety guard: if {facts} / {draft} placeholders missing from template, append.
    const missing = [];
    if (!template.includes('{facts}')) missing.push(`#Established Facts:\n${factsText}`);
    if (!template.includes('{draft}')) missing.push(`#Scene Direction:\n${draftText}`);
    if (missing.length > 0) {
        rendered = `${rendered}\n\n${missing.join('\n\n')}`;
    }

    // Scene card goes ABOVE the fact list: it's the present-moment core context the
    // writer should anchor on before reading individual facts. One combined message.
    if (sceneBlock && sceneBlock.trim()) {
        rendered = `${sceneBlock.trim()}\n\n${rendered}`;
    }

    return rendered;
}

/**
 * Inject the memory context into the chat completion prompt
 * Called via CHAT_COMPLETION_PROMPT_READY event
 * @param {object} data - Prompt data from ST event
 * @param {string} injection - The memory injection text
 * @param {object} [options]
 * @param {number} [options.trimToLast=0] - If > 0, trim the chat history to the last N
 *   user/assistant messages BEFORE injecting (preserves any system prefix). Lets the
 *   main model see only a focused window — relies on stored facts to fill the gap.
 * @returns {boolean} True if injection succeeded
 */
export function injectMemoryContext(data, injection, options = {}) {
    if (!injection) return false;
    const trimToLast = Math.max(0, options.trimToLast || 0);

    // Try chat completion format (array of messages)
    if (data && data.chat && Array.isArray(data.chat)) {
        if (trimToLast > 0) trimChatHistory(data.chat, trimToLast);
        return injectIntoMessages(data.chat, injection);
    }

    // Try messages array format
    if (data && data.messages && Array.isArray(data.messages)) {
        if (trimToLast > 0) trimChatHistory(data.messages, trimToLast);
        return injectIntoMessages(data.messages, injection);
    }

    // Text completion format: prompt is a single string, no per-message trimming possible
    if (data && typeof data.prompt === 'string') {
        data.prompt = injection + '\n\n' + data.prompt;
        return true;
    }

    return false;
}

/**
 * Trim a messages array IN-PLACE to keep at most `keepLast` user/assistant messages.
 * System messages at the start (character card, system prompt) are preserved.
 * Used to hide old chat history from the main model when the user opts into facts-
 * replace-history mode.
 */
function trimChatHistory(messages, keepLast) {
    // Find where the system-prefix ends and actual chat begins
    let chatStart = 0;
    while (chatStart < messages.length && messages[chatStart]?.role === 'system') {
        chatStart++;
    }
    const chatLen = messages.length - chatStart;
    if (chatLen > keepLast) {
        const removeCount = chatLen - keepLast;
        messages.splice(chatStart, removeCount);
    }
}

/**
 * Insert memory context as a system message near the end of the messages array
 * Places it before the last user message so the model sees facts before responding
 * @param {Array} messages
 * @param {string} injection
 * @returns {boolean}
 */
function injectIntoMessages(messages, injection) {
    if (!Array.isArray(messages) || messages.length === 0) return false;

    // Find the last user message
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            lastUserIdx = i;
            break;
        }
    }

    if (lastUserIdx === -1) {
        // No user message found, insert at end
        messages.push({ role: 'system', content: injection });
    } else {
        // Insert before the last user message
        messages.splice(lastUserIdx, 0, { role: 'system', content: injection });
    }

    console.log('[BFMemory] Memory context injected into prompt');
    return true;
}
