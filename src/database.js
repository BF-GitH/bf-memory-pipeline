// BF Memory Pipeline - Database Module
// Manages fact databases via SillyTavern Data Bank (character attachments)
// Each database is a JSON file stored as a character attachment

import { addDebugLog } from './settings.js';

const DB_PREFIX = 'bf_memory_db_';
// Deliberate per-category fact cap. This is a token-cost product decision: every
// stored fact can end up in the retrieval/injection budget, so the owner caps it
// to keep prompts cheap. Raise this only as a conscious cost tradeoff. Eviction
// beyond this cap is now logged (FIX #4) instead of happening silently.
const MAX_FACTS_PER_DB = 50;

// Salience defaults (importance/kind feature). Applied when a fact lacks the field so
// older facts behave sensibly. importance is 1-5 (3 = neutral), kind is trait/state/event.
export const DEFAULT_IMPORTANCE = 3;
export const DEFAULT_KIND = 'trait';
const VALID_KINDS = new Set(['trait', 'state', 'event']);

// Salience-aware eviction tuning (saveDatabase). A fact's keep-score blends normalized
// importance with a recency term, and `kind` sets how fast recency decays:
//   score = IMPORTANCE_WEIGHT*(importance/5) + RECENCY_WEIGHT*recencyDecay(age, kind)
// Traits decay slowly (long half-life → near-permanent protection for foundational
// identity facts even when stale); states/events decay fast so transient goals/moods
// lose to permanent traits when the cap forces a cut. Lowest score is evicted first.
const IMPORTANCE_WEIGHT = 0.65;
const RECENCY_WEIGHT = 0.35;
// Half-lives in days (recency term = 0.5 ** (ageDays / halfLife)).
const HALF_LIFE_DAYS = { trait: 90, state: 3, event: 7 };

/**
 * Clamp an importance value to an integer 1-5, defaulting when absent/invalid.
 * @param {*} v
 * @returns {number} 1..5
 */
export function clampImportance(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return DEFAULT_IMPORTANCE;
    return Math.min(5, Math.max(1, n));
}

/**
 * Normalize a kind to one of trait|state|event, defaulting when absent/invalid.
 * @param {*} v
 * @returns {('trait'|'state'|'event')}
 */
export function normalizeKind(v) {
    const k = String(v || '').trim().toLowerCase();
    return VALID_KINDS.has(k) ? k : DEFAULT_KIND;
}

/**
 * True when a fact is CURRENTLY valid (supersession feature). A fact is active unless it
 * has been explicitly superseded (`active === false`). Absent `active` => active, so
 * every fact written before this feature is treated as currently valid (back-compat).
 * @param {FactSchema} fact
 * @returns {boolean}
 */
export function isActiveFact(fact) {
    return !(fact && fact.active === false);
}

/**
 * Decide whether an INCOMING write should SUPERSEDE the existing fact it reconciles to
 * (i.e. mark the old value as ended and record the new current value) rather than just
 * correct it in place. Supersession is reserved for CHANGEABLE STATE — a status, a
 * current location/goal that genuinely moved on — so the timeline stays truthful while
 * durable traits (name/age/species) keep today's silent in-place correction (a typo fix
 * is NOT a state change). It triggers only when ALL hold:
 *   - the EXISTING fact is itself a `state` (durable traits are corrected, not superseded),
 *   - the incoming write does not itself declare a non-state kind (so a write explicitly
 *     re-typing the fact as a trait is treated as a correction), and
 *   - the value MATERIALLY changed (a no-op re-mention never supersedes).
 * An explicit Agent-3 signal (`supersedes:true` on the incoming fact) forces supersession
 * on a materially-changed value regardless of kind heuristics. Track/sequence facts are
 * handled separately (append-only) and never reach this path.
 * @param {FactSchema} existing - the fact being reconciled to
 * @param {FactSchema} incoming - the new write
 * @param {boolean} explicitSignal - true when Agent 3 emitted the `~` supersession marker
 * @returns {boolean}
 */
function shouldSupersede(existing, incoming, explicitSignal) {
    if (!existing || !incoming) return false;
    // Never supersede when the value is unchanged — that's a pure re-mention/no-op.
    if (factValuesEqual(existing.value, incoming.value)) return false;
    // Explicit writer signal wins (still requires a materially-changed value, checked above).
    if (explicitSignal === true) return true;
    // Heuristic: only changeable STATE supersedes. Existing must be a state; and if the
    // incoming write explicitly re-types the fact as a NON-state kind, treat it as a
    // correction (in-place) rather than a supersession.
    const existingKind = normalizeKind(existing.kind);
    if (existingKind !== 'state') return false;
    const incHasKind = incoming.kind !== undefined && incoming.kind !== null && String(incoming.kind).trim();
    if (incHasKind && normalizeKind(incoming.kind) !== 'state') return false;
    return true;
}

/** Loose value equality (trim + case-insensitive) — mirrors agent-memory's sameValue. */
function factValuesEqual(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * Compute a salience keep-score for a non-sequence fact. Higher = more worth keeping.
 * Blends importance (foundational-ness) with kind-modulated recency decay so durable
 * traits survive even when old, while transient states/events fade fast.
 * @param {FactSchema} fact
 * @param {number} now - reference timestamp (ms)
 * @returns {number}
 */
function salienceScore(fact, now) {
    // Superseded facts (temporal-validity feature) carry the LOWEST salience so they are
    // evicted FIRST under the cap — history compresses gracefully without crowding out
    // currently-valid facts. A tiny recency tiebreak keeps the most-recently-superseded
    // snapshot last to go among the inactive set.
    if (fact && fact.active === false) {
        const at = Number(fact.supersededAt) || Number(fact.lastUpdated) || 0;
        const ageDays = at > 0 ? Math.max(0, (now - at) / 86400000) : 36500;
        return -1 + Math.pow(0.5, ageDays / 7) * 0.001; // ~ -1, newer-superseded slightly higher
    }
    const importance = clampImportance(fact?.importance);
    const kind = normalizeKind(fact?.kind);
    const last = Number(fact?.lastUpdated) || 0;
    const ageDays = last > 0 ? Math.max(0, (now - last) / 86400000) : 36500; // never-updated → very old
    const halfLife = HALF_LIFE_DAYS[kind] || HALF_LIFE_DAYS.trait;
    const recency = Math.pow(0.5, ageDays / halfLife); // 1 (fresh) → 0 (ancient)
    return IMPORTANCE_WEIGHT * (importance / 5) + RECENCY_WEIGHT * recency;
}

function getContext() {
    return SillyTavern.getContext();
}

/**
 * Get the current character's avatar identifier
 */
function getCharacterAvatar() {
    const context = getContext();
    return context.characters?.[context.characterId]?.avatar || null;
}

/**
 * Get all memory databases for the current character
 * @returns {Promise<Object<string, DatabaseSchema>>} Map of category -> database
 */
export async function getAllDatabases() {
    const avatar = getCharacterAvatar();
    if (!avatar) return {};

    const context = getContext();
    const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];

    const databases = {};
    for (const attachment of attachments) {
        if (!attachment.name?.startsWith(DB_PREFIX)) continue;

        try {
            const content = await fetchAttachmentContent(attachment.url);
            if (content) {
                const db = JSON.parse(content);
                databases[db.category] = db;
            }
        } catch (e) {
            console.error(`[BFMemory] Failed to load DB: ${attachment.name}`, e);
        }
    }

    return databases;
}

/**
 * Get a single database by category name
 * @param {string} category
 * @returns {Promise<DatabaseSchema|null>}
 */
export async function getDatabase(category) {
    const all = await getAllDatabases();
    return all[category] || null;
}

/**
 * Save a database (create or overwrite)
 * @param {DatabaseSchema} db
 */
export async function saveDatabase(db) {
    const avatar = getCharacterAvatar();
    if (!avatar) throw new Error('No character selected');

    // Enforce max facts limit.
    if (db.facts.length > MAX_FACTS_PER_DB) {
        const evictCount = db.facts.length - MAX_FACTS_PER_DB;
        // Feature #4 + salience — continuity-aware, salience-aware eviction. A sequence
        // track is a contiguous chain (step ords 1..N); eviction must NOT punch holes
        // mid-chain or wipe a whole track. Policy:
        //   1) Evict NON-sequence facts first, LOWEST salience score first (importance +
        //      kind-modulated recency) so foundational traits survive and transient
        //      states/goals are shed first — replaces the old plain oldest-first rule.
        //   2) If still over cap, trim each track from its OLDEST steps inward (lowest
        //      ord first), keeping the latest steps so the recent chain (and the
        //      "current" tail used by retrieval) stays intact and contiguous (unchanged).
        const now = Date.now();
        const seqFacts = db.facts.filter(isSequenceFact);
        const nonSeqFacts = db.facts.filter(f => !isSequenceFact(f));

        // Step 1: drop lowest-salience non-sequence facts (sort descending so pop() takes
        // the lowest score). Record the score on each evicted fact for the debug log.
        nonSeqFacts.sort((a, b) => salienceScore(b, now) - salienceScore(a, now));
        const evicted = [];
        let overflow = (nonSeqFacts.length + seqFacts.length) - MAX_FACTS_PER_DB;
        while (overflow > 0 && nonSeqFacts.length > 0) {
            const f = nonSeqFacts.pop();
            f.__evictScore = salienceScore(f, now); // transient annotation for logging
            evicted.push(f);
            overflow--;
        }

        // Step 2: if non-sequence facts weren't enough, trim oldest steps PER track
        // (lowest ord first) so each chain loses its tail-end history, never a hole.
        if (overflow > 0 && seqFacts.length > 0) {
            const byTrack = new Map();
            for (const f of seqFacts) {
                if (!byTrack.has(f.track)) byTrack.set(f.track, []);
                byTrack.get(f.track).push(f);
            }
            // Round-robin across tracks, evicting the lowest-ord (oldest) step each pass,
            // so no single track is wiped while another keeps deep history.
            const trackQueues = [...byTrack.values()].map(arr =>
                arr.slice().sort((a, b) => (Number(a.ord) || 0) - (Number(b.ord) || 0)));
            let progress = true;
            while (overflow > 0 && progress) {
                progress = false;
                for (const q of trackQueues) {
                    if (overflow <= 0) break;
                    if (q.length > 1) { // never let a track drop below its newest step
                        evicted.push(q.shift());
                        overflow--;
                        progress = true;
                    }
                }
            }
            // Last resort (every track down to 1 step and still over): drop oldest singletons.
            if (overflow > 0) {
                const singles = trackQueues.flat().sort((a, b) => (a.lastUpdated || 0) - (b.lastUpdated || 0));
                while (overflow > 0 && singles.length > 0) { evicted.push(singles.shift()); overflow--; }
            }
        }

        const evictedSet = new Set(evicted);
        db.facts = db.facts.filter(f => !evictedSet.has(f));
        // NON-SILENT eviction (FIX #4): the old code dropped facts with only a
        // console.warn, so late-session facts vanished from exports with no trace
        // in the user-visible debug log. Surface it. (Cap value unchanged — see
        // MAX_FACTS_PER_DB note; raising it is the owner's cost decision.)
        console.warn(`[BFMemory] DB "${db.category}" has ${db.facts.length + evictCount} facts, evicting ${evictCount} lowest-salience`);
        // Report the score reason: each non-sequence eviction shows key, score, importance
        // and kind so the user can see WHY it lost. Track-step evictions have no score.
        const evictedDesc = evicted.map(f => {
            if (typeof f.__evictScore === 'number') {
                const imp = clampImportance(f.importance);
                const kind = normalizeKind(f.kind);
                return `${f.key || '?'} (score ${f.__evictScore.toFixed(2)}, imp ${imp}, ${kind})`;
            }
            return `${f.key || '?'} (track step)`;
        }).filter(Boolean).join(', ');
        for (const f of evicted) delete f.__evictScore; // strip transient annotation (don't persist)
        addDebugLog('fail', `Evicted ${evictCount} fact(s) from "${db.category}" (cap ${MAX_FACTS_PER_DB}, lowest-salience non-sequence first then oldest track steps): ${evictedDesc}`);
    }

    const fileName = `${DB_PREFIX}${db.category.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;
    const content = JSON.stringify(db, null, 2);
    const base64Data = btoa(unescape(encodeURIComponent(content)));

    const context = getContext();
    const extensionSettings = context.extensionSettings;

    // Ensure character attachments array exists
    if (!extensionSettings.character_attachments) {
        extensionSettings.character_attachments = {};
    }
    if (!extensionSettings.character_attachments[avatar]) {
        extensionSettings.character_attachments[avatar] = [];
    }

    const attachments = extensionSettings.character_attachments[avatar];

    // Remove existing attachment with same name
    const existingIdx = attachments.findIndex(a => a.name === fileName);
    if (existingIdx >= 0) {
        try {
            await deleteAttachmentFile(attachments[existingIdx].url);
        } catch { /* ignore */ }
        attachments.splice(existingIdx, 1);
    }

    // Upload new file
    const { uploadFileAttachment } = await import('../../../../chats.js');
    const uniqueName = `${Date.now()}_${fileName}`;
    const fileUrl = await uploadFileAttachment(uniqueName, base64Data);
    if (!fileUrl) throw new Error('Upload failed');

    attachments.push({
        url: fileUrl,
        size: content.length,
        name: fileName,
        created: Date.now(),
    });

    // Save settings immediately (not debounced) to prevent data loss on page close
    if (context.saveSettingsDebounced) {
        context.saveSettingsDebounced();
        // Force flush if available
        if (typeof context.saveSettingsDebounced.flush === 'function') {
            context.saveSettingsDebounced.flush();
        }
    }
}

/**
 * Delete a database by category
 * @param {string} category
 */
export async function deleteDatabase(category) {
    const avatar = getCharacterAvatar();
    if (!avatar) return;

    const context = getContext();
    const attachments = context.extensionSettings?.character_attachments?.[avatar] || [];
    const fileName = `${DB_PREFIX}${category.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;

    const idx = attachments.findIndex(a => a.name === fileName);
    if (idx >= 0) {
        try {
            await deleteAttachmentFile(attachments[idx].url);
        } catch { /* ignore */ }
        attachments.splice(idx, 1);
        context.saveSettingsDebounced?.();
    }
}

/**
 * Create a new empty database
 * @param {string} category
 * @returns {DatabaseSchema}
 */
export function createEmptyDatabase(category) {
    return {
        category,
        facts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

/**
 * Add or update a fact in a database
 * @param {DatabaseSchema} db
 * @param {FactSchema} fact
 * @returns {DatabaseSchema} Updated database
 */
export function upsertFact(db, fact) {
    // `supersedes` is a TRANSIENT write-time signal (temporal-validity feature), consumed
    // by shouldSupersede() below — it must NEVER be persisted onto a stored fact. Read it
    // off a local copy so the spreads (`...fact`) below can't leak it onto db.facts.
    const supersedesSignal = fact && fact.supersedes === true;
    if (fact && 'supersedes' in fact) { fact = { ...fact }; delete fact.supersedes; }

    // SEQUENCE FACTS (Feature #4): a fact carrying a `track` is one ordered step in a
    // timeline (e.g. `<char>_location_3`). Each step is its OWN fact — they must NEVER
    // be collapsed by the reconcile-on-write normalize-merge below (which would make
    // `_2` and `_3` overwrite each other and destroy the chain — the known bug). We
    // therefore (a) skip the normalized variant match entirely for track facts and (b)
    // auto-assign a monotonic `ord` from the existing steps in that track at write time,
    // so the LLM never has to track step numbers reliably.
    if (isSequenceFact(fact)) {
        // Auto-assign ord if missing/invalid: max existing ord in this track + 1.
        let ord = Number(fact.ord);
        if (!Number.isInteger(ord) || ord <= 0) {
            ord = nextOrdForTrack(db, fact.track);
        }
        const seqFact = { ...fact, ord };
        // Match an existing step ONLY by exact (track + ord) identity — re-running the
        // same extraction shouldn't duplicate a step, but distinct ords stay distinct.
        const exactStepIdx = db.facts.findIndex(f =>
            isSequenceFact(f) && f.track === seqFact.track && Number(f.ord) === ord);
        // Also honor an exact KEY match (idempotent re-write of the same step key).
        const exactKeyIdx = exactStepIdx >= 0 ? exactStepIdx : db.facts.findIndex(f => f.key === seqFact.key);
        if (exactKeyIdx >= 0) {
            const existing = db.facts[exactKeyIdx];
            const mergedRels = mergeRelationships(existing.relationships, seqFact.relationships);
            const mergedContext = mergeContext(existing.context, seqFact.context);
            const mergedAliases = mergeAliases(existing.aliases, seqFact.aliases);
            const sal = mergeSalience(existing, seqFact);
            db.facts[exactKeyIdx] = { ...existing, ...seqFact, key: existing.key, relationships: mergedRels, context: mergedContext, aliases: mergedAliases, ...sal, lastUpdated: Date.now() };
        } else {
            db.facts.push({ ...seqFact, ...normalizeSalienceFields(seqFact), lastUpdated: Date.now() });
        }
        db.updatedAt = Date.now();
        return db;
    }

    // 1) Exact key match — always update in place.
    let existingIdx = db.facts.findIndex(f => f.key === fact.key);
    // 2) Reconcile-on-write (FIX #2c): if no exact match, look for a fact whose key
    //    is a CLEAR variant of the incoming key (e.g. `demeanor` vs `demeanor_1`,
    //    `hair_color` vs `haircolor`, `trait` vs `traits`). Without this, Agent 3
    //    mints parallel keys and contradictory facts coexist (a "gentle" trait
    //    lingering alongside a later "rough" one). We only merge clear normalized
    //    matches — distinct properties (different normalized keys) stay separate.
    //    Sequence steps are handled above and never reach this path.
    if (existingIdx < 0) {
        const normIncoming = normalizeFactKey(fact.key);
        if (normIncoming) {
            // Never collapse a non-sequence write onto a sequence step (or vice versa).
            existingIdx = db.facts.findIndex(f => !isSequenceFact(f) && normalizeFactKey(f.key) === normIncoming);
        }
    }
    // 3) STRONGER PARALLEL-KEY DEDUP (feature #5): if STILL no match and the incoming
    //    write is a changeable `state`, look for an existing CURRENT state fact with the
    //    SAME subject + SAME leading facet/aspect under a parallel key (the real-data bug:
    //    four live `fiona_clothing*` facts for one evolving thing). Only the incoming
    //    `state` kind is considered — untyped/trait/event writes never trigger this, to
    //    stay conservative. The match is then routed through the existing supersession
    //    path below (which snapshots the old value as history), so a parallel near-dup
    //    updates the canonical fact instead of coexisting. We pin the canonical key to the
    //    matched fact's key so subsequent writes converge on it.
    if (existingIdx < 0 && normalizeKind(fact.kind) === 'state'
        && fact.kind !== undefined && fact.kind !== null && String(fact.kind).trim()) {
        const parallelIdx = findParallelStateKey(db, fact, -1);
        if (parallelIdx >= 0) {
            existingIdx = parallelIdx;
            // Adopt the existing canonical key so the merge updates-in-place / supersedes
            // rather than renaming (mirrors the in-place-correction policy below).
            fact = { ...fact, key: db.facts[parallelIdx].key };
        }
    }
    if (existingIdx >= 0) {
        const existing = db.facts[existingIdx];
        // Merge relationships (union) rather than replace, so prior tier links survive.
        const mergedRels = mergeRelationships(existing.relationships, fact.relationships);
        // Preserve context across merges: a new write keeps the old context note unless
        // it provides its own (Feature #3) — so re-mentioning a fact without context
        // doesn't wipe a previously-attached note.
        const mergedContext = mergeContext(existing.context, fact.context);
        // Layer A: union aliases (dedupe) so re-mentions accumulate nicknames/descriptors
        // rather than overwrite. Match-only — never shown to the writer.
        const mergedAliases = mergeAliases(existing.aliases, fact.aliases);
        // Merge salience: keep the HIGHER importance (a fact only grows more foundational
        // as it's re-mentioned, never wiped by a bare re-mention); prefer the incoming
        // kind if the writer provided one, else keep existing.
        const sal = mergeSalience(existing, fact);

        // TEMPORAL SUPERSESSION (Phase 3): when a CHANGEABLE-STATE fact's value genuinely
        // changes (or Agent 3 explicitly signals it), keep history truthful by snapshotting
        // the OLD value as a retained-but-inactive copy, then advancing the canonical fact
        // in place to the new ACTIVE value. Durable traits (and no-op re-mentions) keep the
        // existing silent in-place correction below. We retain only the SINGLE most-recent
        // superseded snapshot per logical key (older inactive snapshots for the same
        // normalized key are dropped) so this never blows the fact cap — deeper history is
        // the job of the track/diary feature, not this lightweight breadcrumb.
        if (existing.active !== false && shouldSupersede(existing, fact, supersedesSignal)) {
            const now = Date.now();
            const snapshotKey = makeSupersededKey(db, existing.key);
            // Build the inactive history snapshot from the OLD fact's state.
            const snapshot = {
                ...existing,
                key: snapshotKey,
                active: false,
                supersededAt: now,
                supersededBy: existing.key, // in-place: canonical key is unchanged
            };
            // Drop any prior superseded snapshot of this same logical key (keep just one).
            const normCanon = normalizeFactKey(existing.key);
            db.facts = db.facts.filter(f =>
                !(f.active === false && f !== existing && normalizeFactKey(stripSupersededSuffix(f.key)) === normCanon));
            // Re-find the canonical fact (filter may have shifted indices).
            const canonIdx = db.facts.findIndex(f => f.key === existing.key);
            db.facts.push(snapshot);
            // Advance the canonical fact to the new active value, clearing any stale
            // supersession markers (it's the current truth again).
            db.facts[canonIdx] = {
                ...existing, ...fact, key: existing.key, relationships: mergedRels,
                context: mergedContext, aliases: mergedAliases, ...sal, active: true,
                supersededAt: undefined, supersededBy: undefined, lastUpdated: now,
            };
            db.updatedAt = now;
            return db;
        }

        // Keep the existing canonical key so we update in place instead of renaming
        // (renaming would orphan any relationship refs pointing at the old key).
        db.facts[existingIdx] = { ...existing, ...fact, key: existing.key, relationships: mergedRels, context: mergedContext, aliases: mergedAliases, ...sal, lastUpdated: Date.now() };
    } else {
        db.facts.push({ ...fact, ...normalizeSalienceFields(fact), lastUpdated: Date.now() });
    }
    db.updatedAt = Date.now();
    return db;
}

// Suffix appended to a superseded snapshot's key so it (a) stays a distinct fact and
// (b) normalizes differently from the live canonical key (so reconcile-on-write never
// collapses a new write onto a history snapshot).
const SUPERSEDED_SUFFIX = '__was';

/**
 * Mint a unique key for an inactive history snapshot of `canonicalKey`. Numeric tail keeps
 * snapshots distinct if more than one ever coexists transiently.
 * @param {DatabaseSchema} db
 * @param {string} canonicalKey
 * @returns {string}
 */
function makeSupersededKey(db, canonicalKey) {
    const base = `${canonicalKey}${SUPERSEDED_SUFFIX}`;
    let n = 1;
    let key = `${base}${n}`;
    const taken = new Set((db.facts || []).map(f => f.key));
    while (taken.has(key)) { n++; key = `${base}${n}`; }
    return key;
}

/** Strip the superseded-snapshot suffix (and its numeric tail) back to the canonical key. */
function stripSupersededSuffix(key) {
    return String(key || '').replace(new RegExp(`${SUPERSEDED_SUFFIX}\\d*$`), '');
}

/**
 * Derive the SUBJECT axis of a fact (the who/what it is about) — feature: subject axis.
 * Prefers an explicit `subject` field (emitted by Agent 3 via the `subj:` marker); falls
 * back deterministically to the token before the first underscore in the key
 * (`felix_apartment_bed` -> `felix`). Returns '' when neither is derivable. Lowercased,
 * trimmed. Back-compat: facts with no `subject` field still resolve via the key prefix.
 * @param {FactSchema} fact
 * @returns {string}
 */
export function deriveSubject(fact) {
    if (!fact) return '';
    const explicit = String(fact.subject || '').trim().toLowerCase();
    if (explicit) return explicit;
    const key = String(fact.key || '').trim().toLowerCase();
    if (!key) return '';
    const us = key.indexOf('_');
    return us > 0 ? key.slice(0, us) : key;
}

/**
 * Derive the FACET/aspect of a fact: the key with its subject prefix removed and the
 * trailing qualifier token (the last `_segment`) dropped, normalized. This groups
 * temporal-state variants of ONE evolving thing
 * (`fiona_clothing`, `fiona_clothing_change`, `fiona_clothing_current`) onto one aspect
 * (`clothing`) so STRONGER-DEDUP can supersede instead of minting parallel keys, while
 * keeping genuinely distinct sub-properties (`x_womens_clothing_stock` vs `..._reason`)
 * apart only when they share NO leading facet token. Used together with a strict gate in
 * upsertFact (state-only, same-subject, shared leading facet token) so the match stays
 * conservative. Returns '' when the key is just the subject (no facet).
 * @param {FactSchema} fact
 * @returns {string}
 */
function factAspect(fact) {
    const key = String(fact?.key || '').trim().toLowerCase();
    if (!key) return '';
    const subject = deriveSubject(fact);
    // Strip a leading "subject_" prefix from the key when the subject came from the key.
    let rest = key;
    if (subject && key === subject) return ''; // key is just the subject — no facet
    if (subject && key.startsWith(subject + '_')) rest = key.slice(subject.length + 1);
    const tokens = rest.split('_').filter(Boolean);
    if (tokens.length === 0) return '';
    // Drop the trailing qualifier token when there's more than one facet token, so
    // `clothing_change`/`clothing_current` collapse to `clothing` but a single-token
    // facet (`clothing`) is preserved as-is.
    const facetTokens = tokens.length > 1 ? tokens.slice(0, -1) : tokens;
    return facetTokens.join('');
}

/**
 * Leading facet token of a fact (first token after the subject prefix). Used as the
 * conservative shared-aspect gate for STRONGER-DEDUP — two state facts must agree on
 * this token (and subject) before parallel-key reconciliation is even considered.
 * @param {FactSchema} fact
 * @returns {string}
 */
function leadingFacetToken(fact) {
    const key = String(fact?.key || '').trim().toLowerCase();
    if (!key) return '';
    const subject = deriveSubject(fact);
    let rest = key;
    if (subject && key === subject) return '';
    if (subject && key.startsWith(subject + '_')) rest = key.slice(subject.length + 1);
    const tokens = rest.split('_').filter(Boolean);
    return tokens[0] || '';
}

/**
 * STRONGER-DEDUP (feature #5): find an existing NON-sequence STATE fact that the incoming
 * write should supersede because it describes the SAME subject + SAME evolving aspect
 * under a parallel key (e.g. incoming `fiona_clothing_current` vs stored `fiona_clothing`).
 * Conservative gate — ALL must hold:
 *   - both incoming and candidate resolve to a non-empty, EQUAL subject,
 *   - both share the same leading facet token (so `clothing*` only merges with `clothing*`),
 *   - the candidate is a CURRENT `state` fact (durable traits/events are never collapsed),
 *   - the incoming write is itself a state (or untyped — see caller; untyped is excluded),
 *   - neither is a sequence/track fact (handled separately, append-only),
 *   - the candidate is not the exact-key match already found.
 * Returns the matched index or -1. Reuses the supersession path so the old value is kept
 * as inactive history rather than silently overwritten.
 * @param {DatabaseSchema} db
 * @param {FactSchema} incoming
 * @param {number} excludeIdx - index already matched by exact/normalized key (skip it)
 * @returns {number}
 */
function findParallelStateKey(db, incoming, excludeIdx) {
    if (!db || !Array.isArray(db.facts)) return -1;
    if (isSequenceFact(incoming)) return -1;
    const incSubject = deriveSubject(incoming);
    if (!incSubject) return -1;
    const incLead = leadingFacetToken(incoming);
    if (!incLead) return -1;
    const incAspect = factAspect(incoming);
    if (!incAspect) return -1;
    for (let i = 0; i < db.facts.length; i++) {
        if (i === excludeIdx) continue;
        const f = db.facts[i];
        if (isSequenceFact(f)) continue;
        if (f.active === false) continue;            // never reconcile onto history snapshots
        if (normalizeKind(f.kind) !== 'state') continue; // only changeable state collapses
        if (deriveSubject(f) !== incSubject) continue;
        if (leadingFacetToken(f) !== incLead) continue;
        if (factAspect(f) !== incAspect) continue;
        return i;
    }
    return -1;
}

/**
 * True if a fact is a sequence/event step — i.e. it carries a non-empty `track`
 * (Feature #4). Such facts form an ordered chain and are EXEMPT from reconcile-on-write
 * collapse and from key-normalized merging.
 * @param {FactSchema} fact
 * @returns {boolean}
 */
export function isSequenceFact(fact) {
    return !!(fact && typeof fact.track === 'string' && fact.track.trim());
}

/**
 * Compute the next monotonic ord for a track: (max existing ord in that track) + 1,
 * starting at 1 for a brand-new track. Called at write time so the LLM doesn't have
 * to number steps itself.
 * @param {DatabaseSchema} db
 * @param {string} track
 * @returns {number}
 */
function nextOrdForTrack(db, track) {
    let max = 0;
    for (const f of (db.facts || [])) {
        if (isSequenceFact(f) && f.track === track) {
            const o = Number(f.ord);
            if (Number.isInteger(o) && o > max) max = o;
        }
    }
    return max + 1;
}

/**
 * Stamp normalized importance/kind onto a fresh (NEW) fact. Only writes the fields when
 * the incoming fact actually provided them, so a fact written without them stays lean
 * and falls back to DEFAULT_IMPORTANCE/DEFAULT_KIND at read time (back-compat).
 * @param {FactSchema} fact
 * @returns {{importance?: number, kind?: string}}
 */
function normalizeSalienceFields(fact) {
    const out = {};
    if (fact && fact.importance !== undefined && fact.importance !== null) {
        out.importance = clampImportance(fact.importance);
    }
    if (fact && fact.kind !== undefined && fact.kind !== null && String(fact.kind).trim()) {
        out.kind = normalizeKind(fact.kind);
    }
    return out;
}

/**
 * Merge salience (importance/kind) on a fact update. Keep the HIGHER importance so a
 * fact never loses foundational weight from a bare re-mention; prefer the incoming kind
 * when provided, else keep the existing. Returns only the fields that should be set so
 * a spread can't clobber an existing value with undefined.
 * @param {FactSchema} existing
 * @param {FactSchema} incoming
 * @returns {{importance?: number, kind?: string}}
 */
function mergeSalience(existing, incoming) {
    const out = {};
    const hasIncImp = incoming && incoming.importance !== undefined && incoming.importance !== null;
    const hasExImp = existing && existing.importance !== undefined && existing.importance !== null;
    if (hasIncImp || hasExImp) {
        const inc = hasIncImp ? clampImportance(incoming.importance) : -Infinity;
        const ex = hasExImp ? clampImportance(existing.importance) : -Infinity;
        out.importance = Math.max(inc, ex);
    }
    const incKind = incoming && incoming.kind !== undefined && incoming.kind !== null && String(incoming.kind).trim();
    if (incKind) out.kind = normalizeKind(incoming.kind);
    else if (existing && existing.kind) out.kind = normalizeKind(existing.kind);
    return out;
}

/**
 * Union aliases across a re-mention (Layer A): accumulate nicknames/descriptors rather than
 * overwrite, so each re-mention can add a new way to refer to the subject. Dedupes
 * case-insensitively (keeping first-seen casing), preserves order. Returns undefined when
 * the union is empty so a fact without aliases stays lean (back-compat).
 * @param {string[]|undefined} existing
 * @param {string[]|undefined} incoming
 * @returns {string[]|undefined}
 */
function mergeAliases(existing, incoming) {
    const seen = new Set();
    const out = [];
    for (const list of [existing, incoming]) {
        if (!Array.isArray(list)) continue;
        for (const a of list) {
            const s = String(a ?? '').trim();
            if (!s) continue;
            const k = s.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(s);
        }
    }
    return out.length ? out : undefined;
}

/** Prefer an incoming context note; fall back to the existing one. Empty → undefined. */
function mergeContext(existing, incoming) {
    const inc = (typeof incoming === 'string') ? incoming.trim() : '';
    if (inc) return inc;
    const ex = (typeof existing === 'string') ? existing.trim() : '';
    return ex || undefined;
}

/**
 * Find the existing fact a given key would reconcile to (exact match first, then a
 * conservative normalized-key match). Returns the matched fact or null. Used by
 * applyUpdates to classify a write as NEW vs UPDATED vs SKIPPED with the SAME
 * matching rule upsertFact uses, so the status reported to the UI is accurate.
 * @param {DatabaseSchema} db
 * @param {string} key
 * @returns {FactSchema|null}
 */
export function findFactMatch(db, key) {
    if (!db || !Array.isArray(db.facts)) return null;
    const exact = db.facts.find(f => f.key === key);
    if (exact) return exact;
    const norm = normalizeFactKey(key);
    if (!norm) return null;
    return db.facts.find(f => normalizeFactKey(f.key) === norm) || null;
}

/**
 * Normalize a fact key for conservative reconcile-on-write matching.
 * Strips trailing numeric/ordinal suffixes, separators, and a trailing plural 's'
 * so cosmetic variants of the SAME property collapse to one canonical form while
 * genuinely different properties stay distinct. Returns '' for empty input.
 *   demeanor / demeanor_1 / demeanor2 -> "demeanor"
 *   hair_color / haircolor            -> "haircolor"
 *   trait / traits                    -> "trait"
 */
function normalizeFactKey(key) {
    let k = String(key || '').toLowerCase().trim();
    if (!k) return '';
    k = k.replace(/[_\-\s]*\d+$/, '');   // drop trailing numeric suffix (_1, 2, -3)
    k = k.replace(/[_\-\s]+/g, '');      // drop all separators
    if (k.length > 3 && k.endsWith('s')) k = k.slice(0, -1); // crude singularize
    return k;
}

function mergeRelationships(existing, incoming) {
    const result = { primary: [], secondary: [], tertiary: [] };
    for (const tier of ['primary', 'secondary', 'tertiary']) {
        const e = Array.isArray(existing?.[tier]) ? existing[tier] : [];
        const i = Array.isArray(incoming?.[tier]) ? incoming[tier] : [];
        result[tier] = Array.from(new Set([...e, ...i]));
    }
    return result;
}

/**
 * Remove a fact from a database
 * @param {DatabaseSchema} db
 * @param {string} key
 * @returns {DatabaseSchema}
 */
export function removeFact(db, key) {
    db.facts = db.facts.filter(f => f.key !== key);
    db.updatedAt = Date.now();
    return db;
}

/**
 * Get character names to filter from keyword matching (they appear in every fact)
 * @returns {Set<string>} lowercased character name words
 */
function getCharacterNameWords() {
    const names = new Set();
    try {
        const context = getContext();
        const charName = context.characters?.[context.characterId]?.name || '';
        const userName = context.name1 || '';
        for (const name of [charName, userName]) {
            for (const word of name.split(/\s+/)) {
                if (word.length > 2) names.add(word.toLowerCase());
            }
        }
    } catch (e) { /* ignore */ }
    return names;
}

/**
 * Search across all databases for facts matching keywords
 * @param {Object<string, DatabaseSchema>} databases - All databases
 * @param {string[]} keywords - Keywords to search for
 * @returns {Array<{fact: FactSchema, category: string, tier: string}>}
 */
export function searchFacts(databases, keywords) {
    const MAX_PRIMARY = 8;
    const results = [];
    const nameWords = getCharacterNameWords();
    const lowerKeywords = keywords.map(k => k.toLowerCase());

    // Pre-process keywords: split into words, filter out char names and short words
    const keywordWordSets = lowerKeywords.map(kw => {
        return kw.split(/\s+/).filter(w => w.length > 3 && !nameWords.has(w));
    }).filter(words => words.length > 0);

    for (const [category, db] of Object.entries(databases)) {
        const categoryLower = category.toLowerCase();

        for (const fact of db.facts) {
            // Supersession: skip facts whose value has been superseded so retrieval/
            // injection surfaces only what is CURRENTLY true. History snapshots are
            // retained on disk (and visible via the track/diary) but never injected here.
            if (!isActiveFact(fact)) continue;
            // Layer A (aliases): fold the fact's aliases into the keyword-match text alongside
            // key/value/tags so an alternative name/nickname can satisfy a hit. Aliases are
            // MATCH-ONLY — they affect search here but are NEVER shown to the writer (see
            // formatFactsForWriter, which excludes them exactly like `context`).
            const factText = `${fact.key} ${fact.value} ${(fact.tags || []).join(' ')} ${(fact.aliases || []).join(' ')}`.toLowerCase();

            // Direct keyword match: require phrase-level relevance
            // Single-word keywords: that word must match
            // Multi-word keywords: at least 2 words must match (not just any one)
            const directMatch = keywordWordSets.some(words => {
                if (words.length === 0) return false;
                const matchCount = words.filter(word => factText.includes(word) || categoryLower.includes(word)).length;
                if (words.length === 1) return matchCount >= 1;
                return matchCount >= 2; // Multi-word phrases need 2+ word hits
            });

            if (directMatch) {
                results.push({ fact, category, tier: 'primary' });
                continue;
            }

            // Check relationship links for secondary/tertiary matches
            if (fact.relationships) {
                const secondaryMatch = (fact.relationships.secondary || []).some(ref => {
                    const refLower = ref.toLowerCase();
                    return keywordWordSets.some(words =>
                        words.some(word => refLower.includes(word))
                    );
                });
                if (secondaryMatch) {
                    results.push({ fact, category, tier: 'secondary' });
                    continue;
                }

                const tertiaryMatch = (fact.relationships.tertiary || []).some(ref => {
                    const refLower = ref.toLowerCase();
                    return keywordWordSets.some(words =>
                        words.some(word => refLower.includes(word))
                    );
                });
                if (tertiaryMatch) {
                    results.push({ fact, category, tier: 'tertiary' });
                }
            }
        }
    }

    // Cap primary results: if too many, demote extras to secondary
    const primaryResults = results.filter(r => r.tier === 'primary');
    if (primaryResults.length > MAX_PRIMARY) {
        // Keep the first MAX_PRIMARY as primary, demote the rest
        let primaryCount = 0;
        for (const result of results) {
            if (result.tier === 'primary') {
                primaryCount++;
                if (primaryCount > MAX_PRIMARY) {
                    result.tier = 'secondary';
                }
            }
        }
    }

    // Relationship-based expansion: facts related to primary hits get promoted
    const primaryFacts = results.filter(r => r.tier === 'primary');
    const alreadyFound = new Set(results.map(r => `${r.category}:${r.fact.key}`));

    for (const primaryResult of primaryFacts) {
        if (!primaryResult.fact.relationships) continue;
        const relatedRefs = [
            ...(primaryResult.fact.relationships.primary || []),
            ...(primaryResult.fact.relationships.secondary || []),
        ];

        // Search remaining facts for relationship matches
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of db.facts) {
                if (!isActiveFact(fact)) continue; // never expand into superseded history
                const id = `${category}:${fact.key}`;
                if (alreadyFound.has(id)) continue;

                const factIdentifiers = `${category} ${fact.key} ${(fact.tags || []).join(' ')}`.toLowerCase();
                const matched = relatedRefs.some(ref => factIdentifiers.includes(ref.toLowerCase()));
                if (matched) {
                    results.push({ fact, category, tier: 'secondary' });
                    alreadyFound.add(id);
                }
            }
        }
    }

    return results;
}

/**
 * Get all database category names
 * @param {Object<string, DatabaseSchema>} databases
 * @returns {string[]}
 */
export function getCategoryNames(databases) {
    return Object.keys(databases);
}

/**
 * Produce a COMPACT keys-only inventory of all stored facts as `Category/key`
 * (one per line, no values) so it can be cheaply injected into Agent 1's prompt as
 * a menu of EXACT keys it can request. Values are intentionally omitted to keep the
 * inventory token cost low; Agent 1 only needs to know what exists, not its content.
 * @param {Object<string, DatabaseSchema>} databases - All databases
 * @returns {string} Newline-separated `Category/key` list (empty string if none)
 */
export function summarizeKeys(databases) {
    if (!databases || Object.keys(databases).length === 0) return '';
    const lines = [];
    for (const [category, db] of Object.entries(databases)) {
        for (const fact of (db.facts || [])) {
            // Supersession: omit inactive history snapshots from the requestable inventory
            // so Agent 1 only sees currently-valid keys (and we don't pay tokens for stale ones).
            if (!isActiveFact(fact)) continue;
            if (fact.key) lines.push(`${category}/${fact.key}`);
        }
    }
    return lines.join('\n');
}

// Canonical category order for the MENU (two-stage retrieval). Unsorted always last —
// it's the catch-all and is ALWAYS sent to the finder regardless of picks, so listing it
// last keeps the menu readable. Categories not in this list (custom buckets) are appended
// after, in insertion order, so the menu never silently drops a real category.
export const MENU_CATEGORY_ORDER = ['Identity', 'Relationships', 'World', 'History', 'Status', 'Behavior', 'Unsorted'];

/** Case-insensitive lookup of a database by category name. Returns [name, db] or null. */
function findDbByCategory(databases, category) {
    const want = String(category || '').trim().toLowerCase();
    if (!want) return null;
    for (const [name, db] of Object.entries(databases)) {
        if (String(name).toLowerCase() === want) return [name, db];
    }
    return null;
}

/**
 * STAGE 1 — build the compact MENU (the picker's map of the store). Lists each KIND
 * (category) and, under it, the SUBJECTS present (from deriveSubject) with active-fact
 * counts. NO values — it's the structure, not the contents — so it stays small even when
 * the DB is large. Example line: `World: felix(11), club(4)`. Subjects with an empty
 * derived subject are grouped under `(N)`. Only ACTIVE facts are counted/shown (superseded
 * history is omitted — it's never a retrieval target). Categories with zero active facts
 * are skipped. Deterministic ordering: MENU_CATEGORY_ORDER first, then any extras; subjects
 * sorted by descending count then name.
 * @param {Object<string, DatabaseSchema>} databases
 * @returns {string} Multi-line menu (one category per line), or '' when nothing stored.
 */
export function summarizeMenu(databases) {
    if (!databases || Object.keys(databases).length === 0) return '';
    // Ordered list of category names: canonical order first, then any custom extras.
    const present = Object.keys(databases);
    const presentLower = new Set(present.map(c => c.toLowerCase()));
    const ordered = [];
    for (const c of MENU_CATEGORY_ORDER) {
        if (presentLower.has(c.toLowerCase())) ordered.push(c);
    }
    for (const c of present) {
        if (!MENU_CATEGORY_ORDER.some(m => m.toLowerCase() === c.toLowerCase())) ordered.push(c);
    }

    const lines = [];
    for (const cat of ordered) {
        const found = findDbByCategory(databases, cat);
        if (!found) continue;
        const [name, db] = found;
        // Count active facts per subject.
        const counts = new Map();
        for (const fact of (db.facts || [])) {
            if (!isActiveFact(fact)) continue;
            const subj = deriveSubject(fact); // may be '' for subject-less facts
            counts.set(subj, (counts.get(subj) || 0) + 1);
        }
        if (counts.size === 0) continue; // skip empty categories
        const entries = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0])));
        const parts = entries.map(([subj, n]) => subj ? `${subj}(${n})` : `(${n})`);
        lines.push(`${name}: ${parts.join(', ')}`);
    }
    return lines.join('\n');
}

/**
 * STAGE 2 input — collect the FULL active facts living under the branches Agent 1 picked,
 * PLUS (always, unconditionally) every active fact in the Unsorted catch-all. A branch is a
 * `Category` (all subjects in it) or `Category/subject` (just that subject, matched via
 * deriveSubject). Matching is case-insensitive and tolerant of surrounding punctuation
 * Agent 1 may wrap a pick in. Superseded history is excluded. Returns results in the same
 * `{ fact, category }` shape retrieveFacts/formatFactsForWriter use, deduped by
 * `category:key`. Unknown/hallucinated branches simply match nothing.
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string[]} branches - Agent 1's branch picks (`Category` or `Category/subject`)
 * @returns {Array<{fact: Object, category: string}>}
 */
export function collectBranchFacts(databases, branches) {
    const out = [];
    const seen = new Set();
    const norm = (s) => String(s ?? '')
        .trim()
        .replace(/^[\s\-*•"'`(\[\{]+/, '')
        .replace(/[\s.,;:"'`)\]\}]+$/, '')
        .trim()
        .toLowerCase();

    const push = (category, fact) => {
        if (!isActiveFact(fact)) return;
        const id = `${category}:${fact.key}`;
        if (seen.has(id)) return;
        seen.add(id);
        out.push({ fact, category });
    };

    // Parse picks into a set of wanted categories and category/subject pairs.
    const wantWholeCat = new Set();       // lowercased category names (all subjects)
    const wantCatSubject = new Set();     // `category||subject` lowercased pairs
    for (const raw of (branches || [])) {
        const s = String(raw ?? '');
        const slashIdx = s.indexOf('/');
        if (slashIdx < 0) {
            const cat = norm(s);
            if (cat) wantWholeCat.add(cat);
        } else {
            const cat = norm(s.slice(0, slashIdx));
            const subj = norm(s.slice(slashIdx + 1));
            if (cat && subj) wantCatSubject.add(`${cat}||${subj}`);
            else if (cat) wantWholeCat.add(cat); // `Category/` with empty subject -> whole category
        }
    }

    for (const [category, db] of Object.entries(databases)) {
        const catLower = category.toLowerCase();
        const wholeCat = wantWholeCat.has(catLower);
        const isUnsorted = catLower === 'unsorted'; // ALWAYS included
        for (const fact of (db.facts || [])) {
            if (!isActiveFact(fact)) continue;
            if (wholeCat || isUnsorted) { push(category, fact); continue; }
            const subj = deriveSubject(fact);
            if (subj && wantCatSubject.has(`${catLower}||${subj}`)) push(category, fact);
        }
    }
    return out;
}

/**
 * Silent dedupe-janitor pass over a single database (refinement #12). Rebuilds the
 * fact list by re-feeding every ACTIVE non-sequence fact through upsertFact into a fresh
 * copy, so the existing reconcile-on-write machinery (normalized-key variants + parallel
 * changeable-state collapse + supersession) merges near-duplicates that accumulated over
 * a long session. Sequence/track facts and superseded history snapshots are preserved
 * verbatim and never collapsed (they form ordered/historical chains). Pure in-memory; the
 * CALLER persists via saveDatabase. Returns { db, before, after, merged }.
 *
 * Idempotent: a DB with no duplicates round-trips to itself (merged === 0).
 * @param {DatabaseSchema} db
 * @returns {{db: DatabaseSchema, before: number, after: number, merged: number}}
 */
export function dedupeDatabase(db) {
    if (!db || !Array.isArray(db.facts)) return { db, before: 0, after: 0, merged: 0 };
    const before = db.facts.length;
    // Partition: sequence steps + inactive history snapshots are preserved as-is; only the
    // active non-sequence facts are re-reconciled against each other.
    const preserved = [];
    const reconcilable = [];
    for (const f of db.facts) {
        if (!f || typeof f !== 'object') continue;
        if (isSequenceFact(f) || f.active === false) preserved.push(f);
        else reconcilable.push(f);
    }
    const rebuilt = createEmptyDatabase(db.category);
    rebuilt.facts = [...preserved]; // keep history/sequence so parallel-state collapse still sees context
    for (const f of reconcilable) {
        // Re-feed a shallow copy so upsertFact's spreads can't mutate the original objects.
        upsertFact(rebuilt, { ...f });
    }
    const after = rebuilt.facts.length;
    return {
        db: { ...db, facts: rebuilt.facts, updatedAt: Date.now() },
        before,
        after,
        merged: Math.max(0, before - after),
    };
}

// Internal helpers

async function fetchAttachmentContent(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.text();
    } catch {
        return null;
    }
}

async function deleteAttachmentFile(url) {
    try {
        const { deleteFileFromServer } = await import('../../../../chats.js');
        await deleteFileFromServer(url);
    } catch (e) {
        console.error('[BFMemory] Failed to delete file:', e);
    }
}

/**
 * @typedef {Object} DatabaseSchema
 * @property {string} category - Database category name
 * @property {FactSchema[]} facts - Array of facts
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} FactSchema
 * @property {string} key - Fact identifier (e.g. "coffee_preference", "first_meeting")
 * @property {string} value - Fact content
 * @property {string[]} tags - Cross-reference tags (e.g. ["allergy", "food"])
 * @property {string[]} knownBy - Characters who know this fact
 * @property {Object} relationships - Tier links to other categories
 * @property {string[]} relationships.primary
 * @property {string[]} relationships.secondary
 * @property {string[]} relationships.tertiary
 * @property {number} lastUpdated
 * @property {string} [source] - Message reference where fact was established
 * @property {string} [context] - OPTIONAL prose note giving the situation around a fact
 *   (Feature #3). Injection-only and EXCLUDED from searchFacts() match text. Absent on
 *   facts written by older versions (backward-compatible).
 * @property {string[]} [aliases] - OPTIONAL alternative names/nicknames/descriptors the
 *   fact's subject might be referred to by in a future message (Layer A of the retrieval
 *   cascade). MATCH-ONLY: folded into searchFacts() match text so a paraphrase can satisfy
 *   a keyword hit, but NEVER shown to the writer (excluded from formatFactsForWriter,
 *   exactly like `context`). Unioned (deduped) across re-mentions in upsertFact. Absent on
 *   facts from older versions (backward-compatible — behaves exactly like no aliases).
 * @property {string} [track] - OPTIONAL timeline name (Feature #4). Presence marks this
 *   fact as one ordered step in a sequence (e.g. a location track). Sequence facts are
 *   exempt from reconcile-on-write collapse.
 * @property {number} [ord] - OPTIONAL monotonic step number within `track` (1-based),
 *   auto-assigned at write time.
 * @property {number} [importance] - OPTIONAL salience 1-5 (Feature: importance/kind).
 *   How foundational/poignant the fact is (5 = core identity, 1 = trivial transient).
 *   Default 3 when absent (see DEFAULT_IMPORTANCE). Drives salience-aware eviction and
 *   retrieval ordering. Absent on facts from older versions (backward-compatible).
 * @property {('trait'|'state'|'event')} [kind] - OPTIONAL fact kind. `trait` = durable
 *   (age, name, personality); `state` = current/transient (mood, current goal/location);
 *   `event` = something that happened (often a track step). Default 'trait' when absent
 *   (see DEFAULT_KIND). Modulates how fast a fact decays during eviction.
 * @property {boolean} [active] - OPTIONAL temporal-validity flag (supersession feature).
 *   ABSENT or `true` => currently valid (the default for every fact ever written). Set to
 *   `false` when a later write supersedes this fact's value (a `state` that changed). A
 *   superseded fact is RETAINED for history but excluded from the normal writer-injection
 *   path and is the first to be shed under the eviction cap. Backward-compatible: older
 *   facts have no `active` field and are treated as active.
 * @property {number} [supersededAt] - OPTIONAL ms timestamp when this fact was superseded
 *   (i.e. when `active` was set false). Doubles as `validTo`. Absent while active.
 * @property {string} [supersededBy] - OPTIONAL key of the fact that replaced this value
 *   (history breadcrumb). For in-place supersession the key is unchanged, so this equals
 *   the fact's own key. Absent while active.
 * @property {string} [subject] - OPTIONAL subject axis (feature: subject axis): the who/what
 *   the fact is about (a character or place name, e.g. `felix`). Emitted by Agent 3 via the
 *   `subj:` marker; when absent it is DERIVED deterministically from the key prefix (the
 *   token before the first underscore) by deriveSubject(). Will become a retrieval index
 *   axis. Backward-compatible: facts without it derive a subject from the key on read.
 * @property {(number|string)} [confidence] - OPTIONAL provenance: how sure the fact is.
 *   Either a 0-1 number or one of `low`/`med`/`high` (Agent 3 emits via the `conf:` marker).
 *   Absent on older facts (backward-compatible).
 * @property {number} [validAt] - OPTIONAL provenance: the source message index (or ms time)
 *   at which the fact became true. Defaults to the source message index at write time.
 *   Absent on older facts (backward-compatible).
 */

/**
 * Return all steps of a sequence track, sorted ascending by ord. Used by retrieval's
 * depth-dice continuity logic (Feature #4).
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string} track
 * @returns {Array<{fact: FactSchema, category: string}>}
 */
export function getTrackSteps(databases, track) {
    const steps = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (isSequenceFact(fact) && fact.track === track) {
                steps.push({ fact, category });
            }
        }
    }
    steps.sort((a, b) => (Number(a.fact.ord) || 0) - (Number(b.fact.ord) || 0));
    return steps;
}
