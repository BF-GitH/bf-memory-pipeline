// BF Memory Pipeline - Fact Retrieval Module
// Automation Step 1: Query databases and assemble facts with tiered relevance
// No LLM calls - pure database lookup with smart fallback matching

import { getAllDatabases, searchFacts } from './database.js';
import { getSettings, addDebugLog } from './settings.js';

// Smart fallback mappings: when a concept appears, also check related categories
// Memory Updater (Agent 3) maintains these in the DB relationships,
// but these are hardcoded fallbacks for common patterns
const FALLBACK_MAPPINGS = {
    // Location triggers
    'apartment': ['Furniture', 'Rooms', 'Decor'],
    'restaurant': ['Food', 'Menu', 'Food_Preferences'],
    'kitchen': ['Food', 'Cooking', 'Food_Preferences'],
    'bedroom': ['Furniture', 'Sleep', 'Intimacy'],
    'school': ['Classes', 'Teachers', 'Students'],
    'office': ['Work', 'Colleagues', 'Projects'],
    'park': ['Nature', 'Weather', 'Activities'],

    // Activity triggers
    'eating': ['Food', 'Food_Preferences', 'Allergies', 'Restaurants'],
    'cooking': ['Food', 'Food_Preferences', 'Recipes', 'Kitchen'],
    'date': ['Relationship', 'Restaurants', 'Activities', 'Gifts'],
    'shopping': ['Money', 'Preferences', 'Clothing'],
    'working': ['Work', 'Skills', 'Projects'],
    'sleeping': ['Sleep', 'Dreams', 'Bedroom'],
    'fighting': ['Conflict', 'Relationship', 'Emotions'],

    // Food triggers
    'food': ['Allergies', 'Food_Preferences', 'Cooking'],
    'drink': ['Beverages', 'Allergies', 'Preferences'],
    'snack': ['Food', 'Food_Preferences'],

    // Relationship triggers
    'gift': ['Preferences', 'Relationship', 'Special_Dates'],
    'birthday': ['Special_Dates', 'Gifts', 'Preferences'],
    'anniversary': ['Special_Dates', 'Relationship', 'Memories'],
};

/**
 * Retrieve relevant facts based on Agent 1's needed info list
 * @param {string[]} neededInfo - Array of fact categories/keywords from Agent 1
 * @param {string[]} [contextKeywords=[]] - Additional keywords extracted from recent messages
 * @returns {Promise<RetrievalResult>}
 */
export async function retrieveFacts(neededInfo, contextKeywords = []) {
    const databases = await getAllDatabases();
    const dbCount = Object.keys(databases).length;
    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    addDebugLog('info', `Retrieval: ${dbCount} databases loaded (${totalFacts} total facts)`);

    if (dbCount === 0) {
        addDebugLog('info', 'No databases exist yet, skipping retrieval');
        return { facts: [], formatted: '', stats: { primary: 0, secondary: 0, tertiary: 0 } };
    }

    // Combine explicit requests with context keywords
    const allKeywords = [...new Set([...neededInfo, ...contextKeywords])];
    addDebugLog('info', `Retrieval keywords: ${allKeywords.join(', ')}`);

    // Search databases for direct matches
    const directResults = searchFacts(databases, allKeywords);

    // Smart fallback: check related categories
    const fallbackKeywords = new Set();
    for (const keyword of allKeywords) {
        const kw = keyword.toLowerCase();
        for (const [trigger, related] of Object.entries(FALLBACK_MAPPINGS)) {
            if (kw.includes(trigger)) {
                for (const cat of related) {
                    fallbackKeywords.add(cat);
                }
            }
        }
    }

    // Also follow relationship links from primary hits
    for (const result of directResults) {
        if (result.tier === 'primary' && result.fact.relationships) {
            for (const ref of (result.fact.relationships.primary || [])) {
                fallbackKeywords.add(ref);
            }
        }
    }

    // Search for fallback matches (these become secondary if not already found)
    const fallbackResults = searchFacts(databases, [...fallbackKeywords]);
    const alreadyFound = new Set(directResults.map(r => `${r.category}:${r.fact.key}`));

    for (const result of fallbackResults) {
        const id = `${result.category}:${result.fact.key}`;
        if (!alreadyFound.has(id)) {
            // Demote: direct fallback hits become secondary, relationship hits become tertiary
            result.tier = result.tier === 'primary' ? 'secondary' : 'tertiary';
            directResults.push(result);
            alreadyFound.add(id);
        }
    }

    // Apply probability filter for secondary/tertiary (read from settings)
    const settings = getSettings() || {};
    const secondaryChance = (settings.secondaryChance ?? 50) / 100;
    const tertiaryChance = (settings.tertiaryChance ?? 15) / 100;

    const filteredResults = directResults.filter(result => {
        if (result.tier === 'primary') return true;
        if (result.tier === 'secondary') return Math.random() < secondaryChance;
        if (result.tier === 'tertiary') return Math.random() < tertiaryChance;
        return false;
    });

    // Format for Agent 2
    const formatted = formatFactsForWriter(filteredResults);

    const stats = {
        primary: filteredResults.filter(r => r.tier === 'primary').length,
        secondary: filteredResults.filter(r => r.tier === 'secondary').length,
        tertiary: filteredResults.filter(r => r.tier === 'tertiary').length,
    };

    addDebugLog('info', `Retrieval result: ${filteredResults.length} facts (P:${stats.primary} S:${stats.secondary} T:${stats.tertiary})`);
    if (filteredResults.length > 0) {
        const factSummary = filteredResults.slice(0, 5).map(r => `[${r.tier[0].toUpperCase()}] ${r.category}:${r.fact.key}`).join(', ');
        addDebugLog('info', `Top facts: ${factSummary}${filteredResults.length > 5 ? ` (+${filteredResults.length - 5} more)` : ''}`);
    }

    return { facts: filteredResults, formatted, stats };
}

/**
 * Format retrieved facts into a string for Agent 2 (Writer)
 * Format: [who_knows] fact_content
 * @param {Array} results - Filtered retrieval results
 * @returns {string}
 */
function formatFactsForWriter(results) {
    if (results.length === 0) return '(No stored facts available)';

    const lines = [];

    for (const { fact, category } of results) {
        const knownBy = (fact.knownBy || []).join(', ');
        const prefix = knownBy ? `[${knownBy}]` : '[everyone]';
        lines.push(`${prefix} ${category}: ${fact.value}`);
    }

    return lines.join('\n');
}

/**
 * Extract keywords from recent chat messages for context-aware retrieval
 * @param {Array} messages - Recent chat messages
 * @returns {string[]}
 */
// Common English words that get capitalized at start of sentences but aren't proper nouns
const STOP_WORDS = new Set([
    'the', 'she', 'her', 'his', 'him', 'they', 'them', 'their', 'its',
    'was', 'were', 'has', 'had', 'have', 'are', 'been', 'being',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
    'will', 'would', 'could', 'should', 'might', 'must', 'shall',
    'not', 'but', 'and', 'for', 'nor', 'yet', 'with', 'from',
    'you', 'your', 'yours', 'our', 'ours', 'mine',
    'here', 'there', 'where', 'when', 'then', 'than', 'how', 'why',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
    'just', 'very', 'too', 'also', 'still', 'even', 'only', 'now',
    'said', 'says', 'told', 'asked', 'looked', 'went', 'came', 'got',
    'like', 'just', 'know', 'think', 'make', 'made', 'take', 'took',
    'see', 'saw', 'come', 'want', 'give', 'gave', 'use', 'used',
    'did', 'does', 'done', 'get', 'gets', 'let', 'say', 'try',
    'one', 'two', 'first', 'last', 'new', 'old', 'good', 'bad',
    'long', 'little', 'big', 'small', 'much', 'well', 'back',
    'down', 'over', 'after', 'before', 'between', 'under', 'again',
    'into', 'through', 'about', 'around', 'against', 'along',
    'something', 'anything', 'nothing', 'everything', 'someone', 'anyone',
    'way', 'day', 'time', 'thing', 'man', 'woman', 'hand', 'head',
    'eye', 'eyes', 'face', 'voice', 'door', 'room', 'floor', 'side',
    'moment', 'mouth', 'words', 'word', 'thought', 'felt', 'found',
    'turned', 'pulled', 'pushed', 'stood', 'sat', 'held', 'left',
    'right', 'looked', 'nodded', 'closed', 'opened', 'moved', 'watched',
    'kept', 'heard', 'reached', 'stepped', 'stopped', 'started',
    'seemed', 'meant', 'tried', 'knew', 'felt', 'ran', 'set',
    'may', 'can', 'own', 'off', 'out', 'away', 'else', 'ever',
]);

export function extractContextKeywords(messages) {
    if (!messages || messages.length === 0) return [];

    // Keep original text for capitalization detection, lowercased for trigger matching
    const originalText = messages.map(m => m.mes || '').join(' ');
    const lowerText = originalText.toLowerCase();

    // Extract proper nouns: capitalized words that aren't common English
    const words = originalText.split(/\s+/);
    const keywords = new Set();

    for (const word of words) {
        const clean = word.replace(/[^a-zA-Z0-9]/g, '');
        if (clean.length < 3) continue;

        // Must be capitalized (proper noun candidate)
        if (clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
            const lower = clean.toLowerCase();
            // Filter out stop words (common sentence starters)
            if (!STOP_WORDS.has(lower)) {
                keywords.add(lower);
            }
        }
    }

    // Also check for fallback trigger words
    for (const trigger of Object.keys(FALLBACK_MAPPINGS)) {
        if (lowerText.includes(trigger)) {
            keywords.add(trigger);
        }
    }

    return [...keywords];
}

/**
 * @typedef {Object} RetrievalResult
 * @property {Array} facts - Retrieved fact objects with tier info
 * @property {string} formatted - Formatted string for Agent 2
 * @property {Object} stats - Count of facts per tier
 */
