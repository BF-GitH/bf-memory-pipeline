// BF Memory Pipeline - Fact Retrieval Module
// Automation Step 1: Query databases and assemble facts with tiered relevance
// No LLM calls - pure database lookup with smart fallback matching

import { getAllDatabases, searchFacts, getTrackSteps, isSequenceFact, isActiveFact, clampImportance, normalizeKind, deriveSubject, deriveScope } from './database.js';
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
 * RENAME-TOLERANT knownBy visibility check. A fact is visible when its `knownBy` is empty
 * (everyone knows) OR when any stored name matches the current persona/character.
 *
 * Matching is tolerant so a RENAME (persona/character renamed mid-chat) never hides facts
 * stored under the old name:
 *   - case-insensitive + trimmed comparison (was exact-string before),
 *   - the literal templates `{{char}}`/`{{user}}` and the words `everyone`/`all` always match
 *     (so a fact tagged with the placeholder rather than the resolved name stays visible),
 *   - the current resolved persona name and character name both match.
 * This widens the prior exact-string compare; it does not change which third-party names
 * fail to match — only that the active user/char are matched robustly across whitespace and
 * case differences a rename can introduce.
 * @param {Object} fact
 * @param {{charName?:string, userName?:string}} [names] - precomputed current names (optional)
 * @returns {boolean}
 */
export function isFactVisible(fact, names = null) {
    const kb = (fact && fact.knownBy) || [];
    if (kb.length === 0) return true; // everyone knows
    let charName = names?.charName;
    let userName = names?.userName;
    if (charName === undefined || userName === undefined) {
        const ctx = SillyTavern.getContext();
        charName = ctx.characters?.[ctx.characterId]?.name || '';
        userName = ctx.name1 || '';
    }
    const cn = String(charName).trim().toLowerCase();
    const un = String(userName).trim().toLowerCase();
    return kb.some(name => {
        const n = String(name).trim().toLowerCase();
        if (!n) return false;
        if (n === '{{char}}' || n === '{{user}}' || n === 'everyone' || n === 'all') return true;
        if (cn && n === cn) return true;
        if (un && n === un) return true;
        return false;
    });
}

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

    // LAYER B — local fuzzy fallback (deterministic, zero API). For each needed-info entry
    // that yielded ZERO primary hits via the exact+keyword path above, run a character-
    // trigram similarity match against every ACTIVE fact's `key value tags aliases` text and
    // admit anything at/above FUZZY_THRESHOLD as SECONDARY (so the existing MAX_SECONDARY cap
    // bounds it). This catches typos/morphology the lexical layers miss
    // ("apartments"->"apartment", "<name>s"->"<name>"). Deterministic — no Math.random. Skips
    // `Category/key` requests (Layer C already resolved those exactly). Never duplicates a
    // fact already found by exact/keyword.
    fuzzyFallback(databases, neededInfo, directResults, exactIds);

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

    // LINK-FOLLOWING + SCOPE-AWARE EXPANSION (Phase 4b). Traverse the scope graph one hop:
    // place->events, person->events, event->place+people. Runs AFTER all candidate
    // generation and BEFORE the salience cap, so the existing MAX_SECONDARY/TERTIARY caps
    // bound the total. Deterministic (no Math.random, no LLM); one hop only; deduped by id.
    expandLinks(databases, directResults, alreadyFound);

    // DETERMINISTIC tier inclusion (Feature #2a). The old code rolled Math.random()
    // against secondaryChance/tertiaryChance and silently dropped correctly-retrieved
    // facts — the real cause of "the writer skips facts." We now include facts by tier
    // up to fixed CAPS so inclusion is predictable while the token budget stays bounded.
    // Always keep all primary; then fill secondary up to MAX_SECONDARY, then tertiary up
    // to MAX_TERTIARY. The legacy secondaryChance/tertiaryChance settings are no longer
    // used for gating (kept in settings for persistence; see settings.js note).
    // SALIENCE-RANKED capping. Primary facts are ALWAYS kept (unsorted, unchanged). When
    // secondary/tertiary candidates exceed their caps we must drop some — rank them by a
    // DETERMINISTIC salience score (importance + recency, no Math.random) so higher-
    // importance and more-recent facts win the slots instead of arbitrary match order.
    const MAX_SECONDARY = 12;
    const MAX_TERTIARY = 6;
    const now = Date.now();
    const primary = directResults.filter(r => r.tier === 'primary');
    const secondary = directResults.filter(r => r.tier === 'secondary');
    const tertiary = directResults.filter(r => r.tier === 'tertiary');
    // Stable-ish descending sort by salience (ties keep original relative order in V8's
    // stable sort, so still deterministic).
    const byScore = (a, b) => retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now);
    secondary.sort(byScore);
    tertiary.sort(byScore);
    const filteredResults = [
        ...primary,
        ...secondary.slice(0, MAX_SECONDARY),
        ...tertiary.slice(0, MAX_TERTIARY),
    ];

    // Filter by knownBy: only include facts the current character knows.
    // Empty knownBy means "everyone knows" (no filter).
    const visibleResults = filteredResults.filter(({ fact }) => isFactVisible(fact));

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
 * LAYER B threshold: minimum character-trigram Jaccard similarity for a fuzzy fallback
 * match to be admitted. ~0.4 catches typos/morphology ("apartments"->"apartment",
 * "<name>s"->"<name>") without flooding in unrelated facts. Named const so it's tunable.
 */
const FUZZY_THRESHOLD = 0.4;

/**
 * Character-trigram Jaccard similarity between two strings (Layer B, deterministic, zero
 * dependencies). Lowercases, pads with spaces so word edges form trigrams, builds the set
 * of 3-char shingles for each side, and returns |A∩B| / |A∪B| in [0,1]. Robust to typos
 * and morphological variants (shared stems share most trigrams) while staying cheap enough
 * to run over a few hundred facts in well under 1ms. No randomness.
 * @param {string} a
 * @param {string} b
 * @returns {number} similarity in [0,1]
 */
export function trigramSimilarity(a, b) {
    const grams = (s) => {
        const t = `  ${String(s || '').toLowerCase().trim()}  `;
        const set = new Set();
        for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
        return set;
    };
    const A = grams(a);
    const B = grams(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * LAYER B fuzzy fallback (mutates `results` in place). For each needed-info entry that the
 * exact+keyword path failed to surface as a PRIMARY hit, fuzzy-match it (character-trigram
 * Jaccard) against every active fact's `key value tags aliases` text and push matches at/
 * above FUZZY_THRESHOLD as SECONDARY. Skips `Category/key` requests (Layer C handles those)
 * and any fact already present (deduped via `seenIds`). Deterministic.
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string[]} neededInfo - Agent 1's needed-info entries (NOT the context keywords)
 * @param {Array<{fact: Object, category: string, tier: string}>} results - mutated in place
 * @param {Set<string>} seenIds - `category:key` ids already in results (mutated)
 */
function fuzzyFallback(databases, neededInfo, results, seenIds) {
    // Which entries already have a primary hit? An entry "covered" if any primary result's
    // match text contains an entry word (cheap re-check against the existing primaries) — if
    // not, it's a candidate for fuzzy rescue. We only fuzzy entries with NO primary coverage.
    const primaries = results.filter(r => r.tier === 'primary');
    const primaryText = primaries
        .map(r => `${r.fact.key} ${r.fact.value} ${(r.fact.tags || []).join(' ')} ${(r.fact.aliases || []).join(' ')}`.toLowerCase())
        .join('  ');

    let admitted = 0;
    for (const raw of (neededInfo || [])) {
        const entry = String(raw || '').trim();
        if (!entry) continue;
        if (entry.indexOf('/') >= 0) continue; // Category/key request — Layer C's job
        const entryLower = entry.toLowerCase();
        // Skip entries that the exact/keyword path already covered as primary (any
        // meaningful word of the entry already present in a primary fact's text).
        const words = entryLower.split(/\s+/).filter(w => w.length > 3);
        const covered = words.length > 0 && words.some(w => primaryText.includes(w));
        if (covered) continue;

        // Compare each WORD of the entry against each TOKEN of the fact and take the best
        // pair similarity. Token-level matching is the right granularity for typo/morphology
        // rescue ("apartments"~"apartment"); a whole-string Jaccard would be diluted by a
        // long value's unrelated trigrams and never clear the threshold.
        const entryWords = words.length > 0 ? words : [entryLower];
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact)) continue; // never fuzzy-surface superseded history
                const id = `${category}:${fact.key}`;
                if (seenIds.has(id)) continue; // already found by exact/keyword path
                const factText = `${fact.key} ${fact.value} ${(fact.tags || []).join(' ')} ${(fact.aliases || []).join(' ')}`.toLowerCase();
                const tokens = factText.split(/[^a-z0-9]+/).filter(t => t.length > 2);
                let best = 0;
                for (const ew of entryWords) {
                    for (const tok of tokens) {
                        const sim = trigramSimilarity(ew, tok);
                        if (sim > best) best = sim;
                        if (best >= FUZZY_THRESHOLD) break;
                    }
                    if (best >= FUZZY_THRESHOLD) break;
                }
                if (best >= FUZZY_THRESHOLD) {
                    results.push({ fact, category, tier: 'secondary' });
                    seenIds.add(id);
                    admitted++;
                }
            }
        }
    }
    if (admitted > 0) {
        addDebugLog('info', `Fuzzy fallback (Layer B): admitted ${admitted} secondary fact(s) at threshold ${FUZZY_THRESHOLD}`);
    }
}

/**
 * Resolve Agent 1's requested facts by EXACT identity (Feature #1).
 * Agent 1 is given a `Category/key` inventory and asked to request facts by their
 * exact key. Any requested item of the form `Category/key` is matched here against
 * the stored fact whose category + key match (case-insensitive). Exact hits are
 * returned as `primary` so they're always included. Items without a slash are left
 * for the existing fuzzy keyword path. Coexists with — does not replace — fuzzy match.
 *
 * LAYER C hardening: the match is case-insensitive AND tolerant of surrounding
 * whitespace/punctuation Agent 1 may wrap a pick in (bullets, trailing periods, brackets,
 * quotes). Crucially it is VALIDATED against the actual inventory — a request only yields a
 * result when a stored fact's category+key genuinely match, so a HALLUCINATED key simply
 * matches nothing and is silently dropped (never injected as an empty/placeholder fact).
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string[]} requests - Agent 1's neededInfo entries
 * @returns {Array<{fact: Object, category: string, tier: string}>}
 */
function resolveExactKeys(databases, requests) {
    const results = [];
    const seen = new Set();
    // Strip surrounding whitespace and stray punctuation (bullets, quotes, brackets,
    // trailing/leading separators) Agent 1 might wrap an identifier in, then lowercase.
    const norm = (s) => String(s)
        .trim()
        .replace(/^[\s\-*•"'`(\[\{]+/, '')
        .replace(/[\s.,;:"'`)\]\}]+$/, '')
        .trim()
        .toLowerCase();
    for (const raw of (requests || [])) {
        const slashIdx = String(raw).indexOf('/');
        if (slashIdx < 0) continue; // not a Category/key request — leave to fuzzy path
        const reqCat = norm(raw.slice(0, slashIdx));
        const reqKey = norm(raw.slice(slashIdx + 1));
        if (!reqCat || !reqKey) continue;
        for (const [category, db] of Object.entries(databases)) {
            if (category.toLowerCase() !== reqCat) continue;
            for (const fact of (db.facts || [])) {
                if (String(fact.key).toLowerCase() !== reqKey) continue;
                if (!isActiveFact(fact)) continue; // never surface superseded history via exact-key
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
 * Deterministic salience score used to RANK which secondary/tertiary facts fill the
 * limited slots (no Math.random). Mirrors the eviction blend at a coarse level: higher
 * importance and more-recent facts score higher. kind modulates recency the same way as
 * eviction (traits decay slowly; states/events fade fast). Primary facts never go through
 * this — they're always kept — so this only orders the overflow tiers.
 * @param {Object} fact
 * @param {number} now - reference timestamp (ms)
 * @returns {number}
 */
const RETRIEVAL_IMPORTANCE_WEIGHT = 0.65;
const RETRIEVAL_RECENCY_WEIGHT = 0.35;
const RETRIEVAL_HALF_LIFE_DAYS = { trait: 90, state: 3, event: 7 };
function retrievalSalience(fact, now) {
    const importance = clampImportance(fact?.importance);
    const kind = normalizeKind(fact?.kind);
    const last = Number(fact?.lastUpdated) || 0;
    const ageDays = last > 0 ? Math.max(0, (now - last) / 86400000) : 36500;
    const halfLife = RETRIEVAL_HALF_LIFE_DAYS[kind] || RETRIEVAL_HALF_LIFE_DAYS.trait;
    const recency = Math.pow(0.5, ageDays / halfLife);
    return RETRIEVAL_IMPORTANCE_WEIGHT * (importance / 5) + RETRIEVAL_RECENCY_WEIGHT * recency;
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
 * Lowercase + trim a link token (a subject/place/person name) for case-insensitive
 * comparison across `subject`, `location`, and `involved` fields. Returns '' for empty.
 * @param {*} s
 * @returns {string}
 */
function linkToken(s) {
    return String(s ?? '').trim().toLowerCase();
}

/**
 * LINK-FOLLOWING + SCOPE-AWARE EXPANSION (Phase 4b). After candidate generation, traverse
 * the scope graph ONE hop so a fact arrives with its linked context. Mutates `results` in
 * place; newly pulled facts enter as SECONDARY (so the existing MAX_SECONDARY cap bounds
 * them) and respect isFactVisible. Deterministic — no Math.random, no LLM. Deduped by
 * `category:key` via `alreadyFound`; a single hop (newly added facts are NOT re-expanded)
 * so it can never loop.
 *
 * Four link directions (each keyed off scope/subject, NOT the owning character, so a place
 * fact is recalled when the PLACE is the topic even if its owner is absent):
 *   1. PLACE -> EVENTS:  any place fact (scope:place) or place SUBJECT among the candidates
 *      pulls EVENT facts whose `location` link points at that place subject/key (sub-places
 *      included via key prefix match).
 *   2. PERSON -> EVENTS: any character SUBJECT among the candidates pulls EVENT facts whose
 *      `involved` list includes that person.
 *   3. EVENT -> PLACE:   any retrieved EVENT pulls the place fact named by its `location`.
 *   4. EVENT -> PEOPLE:  any retrieved EVENT pulls the key character facts of each `involved`
 *      participant (their facts whose subject matches the participant).
 *
 * @param {Object<string, DatabaseSchema>} databases
 * @param {Array<{fact: Object, category: string, tier: string}>} results - mutated in place
 * @param {Set<string>} alreadyFound - `category:key` ids already in results (mutated)
 */
export function expandLinks(databases, results, alreadyFound) {
    // SNAPSHOT the seed set up front so we expand exactly one hop: facts we add below are
    // appended to `results` but are NOT themselves traversed (the loops read `seeds`).
    const seeds = results.slice();

    // Build the relevance sets from the SEED candidates (deterministic, scope-aware).
    const relevantPlaces = new Set();   // place subjects/keys we should surface events for
    const relevantPeople = new Set();   // character subjects we should surface events for
    const seedEvents = [];              // event facts whose context (place+people) we pull
    for (const r of seeds) {
        const fact = r.fact;
        if (!fact) continue;
        const scope = deriveScope(fact);
        const subject = linkToken(deriveSubject(fact));
        const key = linkToken(fact.key);
        if (scope === 'place') {
            // A place is in scope: remember its subject AND its key so events can match
            // either the place subject (`<PLACE>`) or a sub-place key prefix.
            if (subject) relevantPlaces.add(subject);
            if (key) relevantPlaces.add(key);
        } else if (scope === 'event') {
            seedEvents.push(fact);
        } else {
            // character (or default) scope: the subject is a person of interest.
            if (subject) relevantPeople.add(subject);
        }
    }

    // Track which event facts are already pulled in as event-seeds for direction 3/4, so a
    // freshly pulled event (from direction 1/2) ALSO gets its context expanded — but only
    // within this single pass over a fixed candidate list (no recursion).
    const eventQueue = seedEvents.slice();

    const admit = (category, fact) => {
        if (!fact) return false;
        if (!isActiveFact(fact)) return false;          // never surface superseded history
        if (!isFactVisible(fact)) return false;          // respect knownBy
        const id = `${category}:${fact.key}`;
        if (alreadyFound.has(id)) return false;
        results.push({ fact, category, tier: 'secondary' });
        alreadyFound.add(id);
        return true;
    };

    let pulled = 0;

    // DIRECTIONS 1 & 2 — PLACE/PERSON -> EVENTS. Scan every event fact once; admit it when
    // its `location` link names a relevant place (exact subject/key OR sub-place key prefix)
    // or its `involved` list includes a relevant person. Newly admitted events are queued so
    // their own place+people context expands below (still one hop from the seed set).
    if (relevantPlaces.size > 0 || relevantPeople.size > 0) {
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (deriveScope(fact) !== 'event') continue;
                if (!isActiveFact(fact)) continue;
                const id = `${category}:${fact.key}`;
                if (alreadyFound.has(id)) continue;
                let hit = false;
                // Direction 1: event located at a relevant place (or a sub-place of it).
                const loc = linkToken(fact.location);
                if (loc && relevantPlaces.size > 0) {
                    for (const place of relevantPlaces) {
                        // Match the place subject/key exactly, or treat the event location as
                        // a sub-place when one key/subject is a prefix of the other.
                        if (loc === place || loc.startsWith(place + '_') || place.startsWith(loc + '_')) {
                            hit = true;
                            break;
                        }
                    }
                }
                // Direction 2: event whose participants include a relevant person.
                if (!hit && relevantPeople.size > 0 && Array.isArray(fact.involved)) {
                    for (const p of fact.involved) {
                        if (relevantPeople.has(linkToken(p))) { hit = true; break; }
                    }
                }
                if (hit && admit(category, fact)) {
                    pulled++;
                    eventQueue.push(fact); // expand this event's own context below
                }
            }
        }
    }

    // DIRECTIONS 3 & 4 — EVENT -> PLACE + PEOPLE. For every event in scope (seed events plus
    // events freshly pulled above), pull the place fact named by its `location` and the key
    // facts of each `involved` participant. Resolve targets by SUBJECT (scope-aware), so a
    // place fact filed under the place subject is found even if its owning character isn't
    // in scene.
    if (eventQueue.length > 0) {
        // Index active facts by scope+subject ONCE so the per-event lookups stay cheap.
        const placesBySubject = new Map();  // subject -> [{category, fact}]
        const peopleBySubject = new Map();  // subject -> [{category, fact}]
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact)) continue;
                const subj = linkToken(deriveSubject(fact));
                if (!subj) continue;
                const scope = deriveScope(fact);
                const map = scope === 'place' ? placesBySubject : (scope === 'character' ? peopleBySubject : null);
                if (!map) continue; // events aren't pulled as event-context targets
                if (!map.has(subj)) map.set(subj, []);
                map.get(subj).push({ category, fact });
            }
        }
        // Dedupe the queue of events to traverse (an event may appear as both seed and pull).
        const seenEventIds = new Set();
        for (const ev of eventQueue) {
            const evId = `${ev.key}`;
            if (seenEventIds.has(evId)) continue;
            seenEventIds.add(evId);
            // Direction 3: the event's linked place.
            const loc = linkToken(ev.location);
            if (loc && placesBySubject.has(loc)) {
                for (const { category, fact } of placesBySubject.get(loc)) {
                    if (admit(category, fact)) pulled++;
                }
            }
            // Direction 4: the event's participants' character facts.
            if (Array.isArray(ev.involved)) {
                for (const p of ev.involved) {
                    const subj = linkToken(p);
                    if (subj && peopleBySubject.has(subj)) {
                        for (const { category, fact } of peopleBySubject.get(subj)) {
                            if (admit(category, fact)) pulled++;
                        }
                    }
                }
            }
        }
    }

    if (pulled > 0) {
        addDebugLog('info', `Link expansion (Phase 4b): pulled ${pulled} linked fact(s) as secondary (places:${relevantPlaces.size} people:${relevantPeople.size} events:${eventQueue.length})`);
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
