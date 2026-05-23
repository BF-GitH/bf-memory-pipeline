// BF Memory Pipeline - Fact Retrieval Module
// Automation Step 1: Query databases and assemble facts with tiered relevance
// No LLM calls - pure database lookup with smart fallback matching

import { getAllDatabases, searchFacts, getTrackSteps, isSequenceFact } from './database.js';
import { addDebugLog, getSettings } from './settings.js';

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

    // EXACT-KEY RESOLUTION (Feature #1): Agent 1 now requests facts by their exact
    // `Category/key` from the inventory it was given. Resolve those by identity so a
    // requested key reliably appears as primary, independent of the fuzzy path below.
    // The fuzzy keyword search still runs on the SAME list afterwards — exact and
    // fuzzy coexist; identity hits just guarantee the requested key is included.
    const directResults = resolveExactKeys(databases, neededInfo);
    const exactIds = new Set(directResults.map(r => `${r.category}:${r.fact.key}`));

    // Search databases for direct (fuzzy) matches, skipping anything already resolved exactly.
    for (const r of searchFacts(databases, allKeywords)) {
        const id = `${r.category}:${r.fact.key}`;
        if (!exactIds.has(id)) {
            directResults.push(r);
            exactIds.add(id);
        }
    }

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

    // DEPTH-DICE SEQUENCE EXPANSION WITH CONTINUITY (Feature #4).
    // Any track touched by the matched facts so far is "relevant". For each such track
    // we ALWAYS include the current (highest-ord) step, then probabilistically reach
    // further back: roll each depth tier (1..4 steps back) at its configured chance;
    // the REACH is the FURTHEST depth whose roll succeeds; then include EVERY step from
    // current back to that reach CONTIGUOUSLY (continuity is mandatory — no gaps).
    expandSequenceTracks(databases, directResults, alreadyFound);

    // DETERMINISTIC tier inclusion (Feature #2a). The old code rolled Math.random()
    // against secondaryChance/tertiaryChance and silently dropped correctly-retrieved
    // facts — the real cause of "the writer skips facts." We now include facts by tier
    // up to fixed CAPS so inclusion is predictable while the token budget stays bounded.
    // Always keep all primary; then fill secondary up to MAX_SECONDARY, then tertiary up
    // to MAX_TERTIARY. The legacy secondaryChance/tertiaryChance settings are no longer
    // used for gating (kept in settings for persistence; see settings.js note).
    const MAX_SECONDARY = 12;
    const MAX_TERTIARY = 6;
    let secondaryKept = 0;
    let tertiaryKept = 0;
    const filteredResults = directResults.filter(result => {
        if (result.tier === 'primary') return true;
        if (result.tier === 'secondary') return secondaryKept++ < MAX_SECONDARY;
        if (result.tier === 'tertiary') return tertiaryKept++ < MAX_TERTIARY;
        return false;
    });

    // Filter by knownBy: only include facts the current character knows.
    // Empty knownBy means "everyone knows" (no filter).
    const ctx = SillyTavern.getContext();
    const currentCharName = ctx.characters?.[ctx.characterId]?.name || '';
    const currentUserName = ctx.name1 || '';
    const visibleResults = filteredResults.filter(({ fact }) => {
        const kb = fact.knownBy || [];
        if (kb.length === 0) return true; // everyone knows
        return kb.some(name => {
            const n = String(name).toLowerCase();
            return n === currentCharName.toLowerCase()
                || n === currentUserName.toLowerCase()
                || n === '{{char}}' || n === '{{user}}'
                || n === 'everyone' || n === 'all';
        });
    });

    // Format for Agent 2
    const formatted = formatFactsForWriter(visibleResults);

    const stats = {
        primary: visibleResults.filter(r => r.tier === 'primary').length,
        secondary: visibleResults.filter(r => r.tier === 'secondary').length,
        tertiary: visibleResults.filter(r => r.tier === 'tertiary').length,
    };

    addDebugLog('info', `Retrieval result: ${visibleResults.length} facts (P:${stats.primary} S:${stats.secondary} T:${stats.tertiary})`);
    if (visibleResults.length > 0) {
        const factSummary = visibleResults.slice(0, 5).map(r => `[${r.tier[0].toUpperCase()}] ${r.category}:${r.fact.key}`).join(', ');
        addDebugLog('info', `Top facts: ${factSummary}${visibleResults.length > 5 ? ` (+${visibleResults.length - 5} more)` : ''}`);
    }

    return { facts: visibleResults, formatted, stats };
}

/**
 * Resolve Agent 1's requested facts by EXACT identity (Feature #1).
 * Agent 1 is given a `Category/key` inventory and asked to request facts by their
 * exact key. Any requested item of the form `Category/key` is matched here against
 * the stored fact whose category + key match (case-insensitive). Exact hits are
 * returned as `primary` so they're always included. Items without a slash are left
 * for the existing fuzzy keyword path. Coexists with — does not replace — fuzzy match.
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string[]} requests - Agent 1's neededInfo entries
 * @returns {Array<{fact: Object, category: string, tier: string}>}
 */
function resolveExactKeys(databases, requests) {
    const results = [];
    const seen = new Set();
    for (const raw of (requests || [])) {
        const slashIdx = String(raw).indexOf('/');
        if (slashIdx < 0) continue; // not a Category/key request — leave to fuzzy path
        const reqCat = raw.slice(0, slashIdx).trim().toLowerCase();
        const reqKey = raw.slice(slashIdx + 1).trim().toLowerCase();
        if (!reqCat || !reqKey) continue;
        for (const [category, db] of Object.entries(databases)) {
            if (category.toLowerCase() !== reqCat) continue;
            for (const fact of (db.facts || [])) {
                if (String(fact.key).toLowerCase() !== reqKey) continue;
                const id = `${category}:${fact.key}`;
                if (seen.has(id)) continue;
                seen.add(id);
                results.push({ fact, category, tier: 'primary' });
            }
        }
    }
    if (results.length > 0) {
        addDebugLog('info', `Exact-key resolution: ${results.length} fact(s) matched by identity`);
    }
    return results;
}

/**
 * Default depth-dice probabilities (Feature #4). Each is the chance of reaching that
 * many steps back from the current step. Overridden by settings.depthDice* when present.
 */
const DEFAULT_DEPTH_PROBS = [0.70, 0.50, 0.25, 0.10]; // depth 1,2,3,4

/** Read configured depth probabilities (clamped 0..1), falling back to defaults. */
function getDepthProbs() {
    const s = (() => { try { return getSettings(); } catch { return null; } })() || {};
    const pick = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
    };
    return [
        pick(s.depthDice1, DEFAULT_DEPTH_PROBS[0]),
        pick(s.depthDice2, DEFAULT_DEPTH_PROBS[1]),
        pick(s.depthDice3, DEFAULT_DEPTH_PROBS[2]),
        pick(s.depthDice4, DEFAULT_DEPTH_PROBS[3]),
    ];
}

/**
 * Depth-dice sequence expansion with mandatory continuity (Feature #4).
 * Identifies every track already touched by the retrieved facts, then for each track
 * includes the current (highest-ord) step plus a CONTIGUOUS run of older steps back to
 * a probabilistically-chosen reach. Newly included steps are pushed as primary so the
 * writer reliably sees the relevant slice of history. Mutates `results` in place.
 * @param {Object<string, DatabaseSchema>} databases
 * @param {Array<{fact: Object, category: string, tier: string}>} results
 * @param {Set<string>} alreadyFound - `category:key` ids already in results
 */
function expandSequenceTracks(databases, results, alreadyFound) {
    // Collect relevant tracks from already-matched facts.
    const tracks = new Set();
    for (const r of results) {
        if (isSequenceFact(r.fact)) tracks.add(r.fact.track);
    }
    if (tracks.size === 0) return;

    const probs = getDepthProbs();

    for (const track of tracks) {
        const steps = getTrackSteps(databases, track); // ascending by ord
        if (steps.length === 0) continue;

        // Roll each depth tier; REACH = furthest depth whose roll succeeds (0 = current only).
        let reach = 0;
        for (let depth = 1; depth <= probs.length; depth++) {
            if (Math.random() < probs[depth - 1]) reach = depth;
        }
        // Number of steps to include from the tail: current + `reach` older = reach+1,
        // bounded by how many steps actually exist.
        const includeCount = Math.min(reach + 1, steps.length);
        const slice = steps.slice(steps.length - includeCount); // contiguous tail — no gaps

        for (const { fact, category } of slice) {
            const id = `${category}:${fact.key}`;
            if (alreadyFound.has(id)) continue;
            results.push({ fact, category, tier: 'primary' });
            alreadyFound.add(id);
        }
        addDebugLog('info', `Depth-dice track "${track}": reach ${reach} → included ${includeCount}/${steps.length} step(s)`);
    }
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

    for (const { fact, category, tier } of results) {
        const knownBy = (fact.knownBy || []).join(', ');
        const prefix = knownBy ? `[${knownBy}]` : '[everyone]';
        // Keep the KEY (Feature #2b) so the writer sees `Category/key = value` and can
        // tell similar facts apart and use them precisely.
        let line = `${prefix} ${category}/${fact.key} = ${fact.value}`;
        // Feature #3: surface the optional context note for TOP-TIER (primary) facts
        // only, to bound tokens. Secondary/tertiary lines never carry context.
        if (tier === 'primary' && typeof fact.context === 'string' && fact.context.trim()) {
            line += ` — ${fact.context.trim()}`;
        }
        lines.push(line);
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
    // Contractions (apostrophes stripped upstream)
    'ive', 'ill', 'youre', 'whats', 'dont', 'isnt', 'wasnt', 'hes', 'shes',
    'weve', 'theyre', 'youve', 'theyve', 'cant', 'couldnt', 'wouldnt',
    'shouldnt', 'hasnt', 'havent', 'didnt', 'doesnt', 'arent', 'werent',
    'thats', 'whos', 'lets', 'im', 'youll', 'hell', 'shell', 'well',
    'theyll', 'thatll', 'heres', 'theres', 'wheres',
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
