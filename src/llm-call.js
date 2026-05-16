// BF Memory Pipeline - Direct LLM Call
// Bypasses SillyTavern's generateQuietPrompt (which includes chat context/system prompt)
// Uses ConnectionManagerRequestService when a profile is specified (no DOM/UI switching).
// Falls back to direct fetch or generateQuietPrompt.

import { addDebugLog } from './settings.js';

/**
 * Detect the current chat completion source and model from ST settings.
 * Used only as fallback when CMRS is unavailable and no profile is specified.
 * @returns {{ source: string, model: string } | null}
 */
function detectCurrentConfig() {
    try {
        const context = SillyTavern.getContext();

        let source = '';
        let model = '';

        if (typeof window !== 'undefined') {
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
 * Get ST's ConnectionManagerRequestService if available.
 * @returns {object|null}
 */
function getCMRS() {
    try {
        return SillyTavern.getContext().ConnectionManagerRequestService || null;
    } catch {
        return null;
    }
}

/**
 * Call LLM via ConnectionManagerRequestService (safe, no profile switching).
 * @param {string} profileId - The connection profile ID to use
 * @param {Array} messages - Chat messages array
 * @returns {Promise<string>} The LLM response text
 */
async function callViaCMRS(profileId, messages) {
    const CMRS = getCMRS();
    if (!CMRS) {
        throw new Error('ConnectionManagerRequestService not available');
    }

    const profile = CMRS.getProfile(profileId);
    if (!profile) {
        throw new Error(`Connection profile "${profileId}" not found`);
    }

    addDebugLog('info', `CMRS call via profile "${profile.name || profileId}"`);

    const result = await CMRS.sendRequest(profileId, messages, 0, {
        stream: false,
        extractData: true,
        includePreset: true,
    });

    const content = result?.content;
    if (content == null) {
        throw new Error(`CMRS returned no content: ${JSON.stringify(result).substring(0, 200)}`);
    }

    return typeof content === 'string' ? content : String(content);
}

/**
 * Call LLM directly via ST's backend proxy, without chat context.
 * @param {string} systemPrompt - System instruction for the agent
 * @param {string} userPrompt - The user/data prompt
 * @param {string|null} [profileId=null] - Optional connection profile ID.
 *   When provided, uses ConnectionManagerRequestService (no UI/DOM switching needed).
 *   This is safe to call during mid-generation because it doesn't touch the active profile.
 * @returns {Promise<string>} The LLM response text
 */
export async function callAgentLLM(systemPrompt, userPrompt, profileId = null) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];

    // Priority 1: Use CMRS with the specified profile (safe, no profile switching)
    if (profileId) {
        try {
            const result = await callViaCMRS(profileId, messages);
            return result;
        } catch (cmrsErr) {
            addDebugLog('info', `CMRS failed (${cmrsErr.message}), falling back to direct proxy`);
        }
    }

    // Priority 2: Direct ST proxy fetch (reads current DOM config)
    try {
        const result = await callSTProxy(messages);
        return result;
    } catch (proxyErr) {
        addDebugLog('info', `ST proxy failed (${proxyErr.message}), falling back to generateQuietPrompt`);
    }

    // Priority 3: generateQuietPrompt (includes chat context, but better than nothing)
    const context = SillyTavern.getContext();
    const fallbackPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const result = await context.generateQuietPrompt({ quietPrompt: fallbackPrompt, skipWIAN: true });
    return typeof result === 'string' ? result : String(result || '');
}

/**
 * Call ST's backend proxy endpoint directly with custom messages.
 * No chat history, no character card, no system prompt injection.
 * NOTE: This reads source/model from the DOM, so it uses whatever profile is currently active.
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
