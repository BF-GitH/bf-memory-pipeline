// BF Memory Pipeline - Agent 2: Writer
// Uses the DEFAULT SillyTavern profile (main model)
// Receives: draft + retrieved facts + character cards + system prompt
// Output: injected into the prompt so the main model writes a fact-grounded response

// Lazy access to avoid circular dependency (settings imports our DEFAULT_WRITER_FORMAT)
function getSettingsSafe() {
    try { return SillyTavern.getContext().extensionSettings?.['bf-memory-pipeline']; } catch { return null; }
}

export const DEFAULT_WRITER_FORMAT = `[Memory Context - Use these established facts for consistency]

#Established Facts:
{facts}

#Scene Direction:
{draft}

[Follow the established facts above. Do not contradict them. Characters only know facts tagged with their name.]`;

/**
 * Build the fact injection block that gets inserted into the prompt
 * This doesn't call an LLM - it prepares context for the main generation
 * @param {string} draft - Draft from Agent 1
 * @param {string} factsFormatted - Formatted facts from retrieval
 * @returns {string} Injection text to add to the prompt
 */
export function buildWriterInjection(draft, factsFormatted) {
    const settings = getSettingsSafe();

    const template = settings?.writerFormat || DEFAULT_WRITER_FORMAT;
    const factsText = (factsFormatted && factsFormatted !== '(No stored facts available)') ? factsFormatted : '(none available)';
    const draftText = draft || '(no direction)';

    // Single-pass regex substitution: avoids order-dependent re-substitution
    // (e.g. factsText containing literal "{draft}" can't get re-replaced)
    const vars = { facts: factsText, draft: draftText };
    let rendered = template.replace(/\{(facts|draft)\}/g, (_, key) => vars[key]);

    // Safety guard: if EITHER placeholder is missing, append the missing parts
    // rather than silently dropping content
    const missing = [];
    if (!template.includes('{facts}')) missing.push(`#Established Facts:\n${factsText}`);
    if (!template.includes('{draft}')) missing.push(`#Scene Direction:\n${draftText}`);
    if (missing.length > 0) {
        rendered = `${rendered}\n\n${missing.join('\n\n')}`;
    }

    return rendered;
}

/**
 * Inject the memory context into the chat completion prompt
 * Called via CHAT_COMPLETION_PROMPT_READY event
 * @param {object} data - Prompt data from ST event
 * @param {string} injection - The memory injection text
 * @returns {boolean} True if injection succeeded
 */
export function injectMemoryContext(data, injection) {
    if (!injection) return false;

    // Try chat completion format (array of messages)
    if (data && data.chat && Array.isArray(data.chat)) {
        return injectIntoMessages(data.chat, injection);
    }

    // Try messages array format
    if (data && data.messages && Array.isArray(data.messages)) {
        return injectIntoMessages(data.messages, injection);
    }

    // Try text completion format
    if (data && typeof data.prompt === 'string') {
        data.prompt = injection + '\n\n' + data.prompt;
        return true;
    }

    return false;
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
