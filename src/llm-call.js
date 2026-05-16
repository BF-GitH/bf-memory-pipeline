// BF Memory Pipeline - Direct LLM Call
// Bypasses SillyTavern's generateQuietPrompt (which includes chat context/system prompt)
// Calls the ST proxy endpoint directly with only our messages.

import { addDebugLog } from './settings.js';

/**
 * Detect the current chat completion source and model from ST settings.
 * @returns {{ source: string, model: string } | null}
 */
function detectCurrentConfig() {
    try {
        const context = SillyTavern.getContext();
        // ST stores these in various places depending on version
        const mainApi = context.mainApi || '';
        const oai = context.extensionSettings?.connectionManager?.selectedProfile
            ? null // will use proxy defaults
            : null;

        // Try to get from the OAI settings (covers OpenRouter, Claude, OpenAI, Custom)
        const oaiSettings = context.onlineStatus !== undefined ? context : {};

        // Chat completion source mapping
        let source = '';
        let model = '';

        if (typeof window !== 'undefined') {
            // Read from ST's global state (jQuery-accessible selectors)
            const chatCompletionSource = document.getElementById('chat_completion_source');
            if (chatCompletionSource) {
                source = chatCompletionSource.value || '';
            }
            const modelSelect = document.getElementById('model_openai_select')
                || document.getElementById('openrouter_model');
            if (modelSelect) {
                model = modelSelect.value || '';
            }
        }

        // Fallback: try context properties
        if (!source) source = context.chat_completion_source || context.mainApi || '';
        if (!model) model = context.onlineStatus?.model || '';

        return (source || model) ? { source, model } : null;
    } catch (e) {
        console.warn('[BFMemory] detectCurrentConfig failed:', e);
        return null;
    }
}

/**
 * Call LLM directly via ST's backend proxy, without chat context.
 * @param {string} systemPrompt - System instruction for the agent
 * @param {string} userPrompt - The user/data prompt
 * @returns {Promise<string>} The LLM response text
 */
export async function callAgentLLM(systemPrompt, userPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    // Try direct ST proxy first
    try {
        const result = await callSTProxy(messages);
        return result;
    } catch (proxyErr) {
        addDebugLog('info', `ST proxy failed (${proxyErr.message}), falling back to generateQuietPrompt`);
    }

    // Fallback: generateQuietPrompt (includes chat context, but better than nothing)
    const context = SillyTavern.getContext();
    const fallbackPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const result = await context.generateQuietPrompt({ quietPrompt: fallbackPrompt, skipWIAN: true });
    return typeof result === 'string' ? result : String(result || '');
}

/**
 * Call ST's backend proxy endpoint directly with custom messages.
 * No chat history, no character card, no system prompt injection.
 * @param {Array} messages
 * @returns {Promise<string>}
 */
async function callSTProxy(messages) {
    const context = SillyTavern.getContext();
    const headers = context.getRequestHeaders?.();
    if (!headers) {
        throw new Error('Cannot get ST request headers');
    }

    const config = detectCurrentConfig();

    const body = {
        messages,
        stream: false,
    };

    // Include source/model if detected
    if (config?.source) body.chat_completion_source = config.source;
    if (config?.model) body.model = config.model;

    addDebugLog('info', `Direct LLM call: source=${config?.source || '?'} model=${(config?.model || '?').substring(0, 40)}`);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`ST proxy ${response.status}: ${errorBody.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content == null) {
        throw new Error(`Unexpected proxy response: ${JSON.stringify(data).substring(0, 200)}`);
    }

    return content;
}
