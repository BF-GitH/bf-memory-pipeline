// BF Memory Pipeline - Database Module
// Manages fact databases via SillyTavern Data Bank (character attachments)
// Each database is a JSON file stored as a character attachment

const DB_PREFIX = 'bf_memory_db_';
const MAX_FACTS_PER_DB = 50;

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

    // Enforce max facts limit
    if (db.facts.length > MAX_FACTS_PER_DB) {
        console.warn(`[BFMemory] DB "${db.category}" has ${db.facts.length} facts, trimming to ${MAX_FACTS_PER_DB}`);
        db.facts = db.facts.slice(-MAX_FACTS_PER_DB);
    }

    const fileName = `${DB_PREFIX}${db.category.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`;
    const content = JSON.stringify(db, null, 2);
    const base64Data = btoa(unescape(encodeURIComponent(content)));

    const context = getContext();
    const { extension_settings } = context;

    // Ensure character attachments array exists
    if (!extension_settings.character_attachments) {
        extension_settings.character_attachments = {};
    }
    if (!extension_settings.character_attachments[avatar]) {
        extension_settings.character_attachments[avatar] = [];
    }

    const attachments = extension_settings.character_attachments[avatar];

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

    // Save settings
    context.saveSettingsDebounced?.();
}

/**
 * Delete a database by category
 * @param {string} category
 */
export async function deleteDatabase(category) {
    const avatar = getCharacterAvatar();
    if (!avatar) return;

    const context = getContext();
    const attachments = context.extension_settings?.character_attachments?.[avatar] || [];
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
    const existingIdx = db.facts.findIndex(f => f.key === fact.key);
    if (existingIdx >= 0) {
        db.facts[existingIdx] = { ...db.facts[existingIdx], ...fact, lastUpdated: Date.now() };
    } else {
        db.facts.push({ ...fact, lastUpdated: Date.now() });
    }
    db.updatedAt = Date.now();
    return db;
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
 * Search across all databases for facts matching keywords
 * @param {Object<string, DatabaseSchema>} databases - All databases
 * @param {string[]} keywords - Keywords to search for
 * @returns {Array<{fact: FactSchema, category: string, tier: string}>}
 */
export function searchFacts(databases, keywords) {
    const results = [];
    const lowerKeywords = keywords.map(k => k.toLowerCase());

    for (const [category, db] of Object.entries(databases)) {
        const categoryLower = category.toLowerCase();

        for (const fact of db.facts) {
            const factText = `${fact.key} ${fact.value} ${(fact.tags || []).join(' ')}`.toLowerCase();

            // Check for direct keyword match (primary)
            const directMatch = lowerKeywords.some(kw => factText.includes(kw) || categoryLower.includes(kw));
            if (directMatch) {
                results.push({ fact, category, tier: 'primary' });
                continue;
            }

            // Check relationship links for secondary/tertiary matches
            if (fact.relationships) {
                const secondaryMatch = (fact.relationships.secondary || []).some(ref =>
                    lowerKeywords.some(kw => ref.toLowerCase().includes(kw)),
                );
                if (secondaryMatch) {
                    results.push({ fact, category, tier: 'secondary' });
                    continue;
                }

                const tertiaryMatch = (fact.relationships.tertiary || []).some(ref =>
                    lowerKeywords.some(kw => ref.toLowerCase().includes(kw)),
                );
                if (tertiaryMatch) {
                    results.push({ fact, category, tier: 'tertiary' });
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
 */
