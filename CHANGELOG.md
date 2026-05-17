# Changelog

## [0.3.2] - 2026-05-17

### Fixed (HIGH — caught by Tier 1 smoke test)
- **Pipeline no longer aborts when Agent 1 (Draft) returns empty**: previously, if Deepseek returned an empty completion for the draft agent, `pipeline.js` did an early `return` and the writer never injected facts into the prompt. The user got a plain AI response with no memory context. Now: Agent 1 failure logs a warning but the pipeline continues with `draft = ''`, so the retrieved facts still reach the writer (memory > nothing). The user-facing impact: even when the draft LLM hiccups, your character still sees the established facts.
- **One-shot retry on empty LLM completion in `callAgentLLM`**: providers (especially Deepseek) intermittently return empty bodies. We now retry once before giving up. Empty responses from Agent 1 / Agent 3 should be substantially rarer.

## [0.3.1] - 2026-05-17

### Added
- **Version label in extension header**: the drawer title "BF's Memory Pipeline" now displays the installed version (`v0.3.1`) next to the name, fetched live from `manifest.json` (single source of truth). Lets testers/users instantly verify which version is loaded — critical for catching stale browser caches where a patched file on disk hasn't replaced the in-memory copy.

## [0.3.0] - 2026-05-17

### Fixed (HIGH — behavior bugs surfaced by test suite v2)
- **Cross-profile data leak on character switch**: `autoSaveDbProfile()` previously snapshotted in-memory databases into the active profile slot on `CHAT_CHANGED`. By flush time, ST had already advanced state, so e.g. Seraphina's facts could end up in Assistant's profile. Fix: removed the unsafe save-on-switch entirely; persistence now happens via capture-at-write in `saveCurrentToActiveProfile(profileKey)`, with the profile key captured at pipeline start (`src/pipeline.js`). Also added an integrity guard that refuses writes to deleted profiles and surfaces a toast. Removed a second residual `MESSAGE_RECEIVED → saveCurrentToActiveProfile()` handler that had the same leak class.
- **Agent 3 ignored USER facts**: messages like "I am Bernd, I work at Google in Berlin" produced 0 stored facts because Agent 3 ran only on the N-1 AI message. Fix: Agent 3 now also sees the latest user message in the same call (combined `[USER:...] ... [CHAR:...]` block). The prompt has been rewritten to anchor on `{{user}}` / `{{char}}` macros (resolved via ST's `substituteParams`), with a CRITICAL clause for first-person disclosures and a new few-shot example for user-fact extraction. User persona description is also injected.

### Added (MED)
- **Relationships schema is no longer dead**: extended the Agent 3 output format with an optional `| rel:key1,key2` segment. The parser writes these into `fact.relationships.primary`, which the existing retrieval logic uses to expand fallback keywords. `upsertFact()` now MERGES (unions) relationships instead of replacing them, so prior tier links survive subsequent updates.
- **Review counter persists across page reload**: `messagesSinceLastReview` and `pendingReviewItems` now live in `chat_metadata.bf_mem_review` instead of module-scope JS, with an in-memory fallback that drains into chat metadata once a chat is opened. Counters are per-chat (correct behavior — reviewing facts about chat A shouldn't reset when you switch to chat B).
- **`knownBy` filtering enforced at code level**: `retrieveFacts()` now filters facts by current `{{char}}` / `{{user}}` name before formatting them into the injection. A fact tagged `knownBy: [Seraphina]` is no longer included when you chat with a different character.
- **Speculative retrieval stopword list extended**: added ~35 missing contractions (`ive, ill, youre, dont, isnt, hes, shes, theyre, cant, didnt, doesnt, thats, lets, im, ...`) so speculative keywords contain less noise (test G2 found ~40-50% noise rate pre-fix).

### Internal
- `runMemoryUpdater()` signature gained `isUserMessage`, `userPersona`, `prevUserMessage` parameters (all backward-compatible defaults).
- Renamed `lastAutoSavedChat` → `lastAutoLoadedChat` to match new semantics (the save logic is gone, it only deduplicates loads).
- `mergeRelationships()` helper added to `database.js` (set-union per tier).
- Code-reviewed by an independent reviewer agent after patch agents; 7 follow-up improvements applied including the two HIGH-severity items (residual MESSAGE_RECEIVED save + Agent 3 user-message targeting).

### Known limitations
- `relationships.secondary` and `tertiary` arrays are still always empty when written by Agent 3 (only `primary` is parsed). The retrieval tier expansion for secondary/tertiary will only work if these are populated by future schema work (e.g. structured outputs via `generateRaw({jsonSchema})`).
- In group chats, `knownBy` filtering uses only the current single `characterId`. Multi-character group filtering not yet implemented.
- The `{{user}}` macro in `knownBy` only matches if the model outputs the literal unresolved macro — defensive guard only.

## [0.2.1] - 2026-05-17

### Security
- **XSS fix**: `escapeHtml()` now escapes quote characters (`"` and `'`) in addition to `<`, `>`, `&`. The previous `textContent → innerHTML` trick failed to escape quotes, allowing attribute-context injection in the linked-chats popup (e.g. a crafted `chatId` could register event handlers via `data-chat="..."`). Affected: `src/settings.js`, `src/review-popup.js`.

### Fixed
- **No more brick on corrupt settings**: `initSettings()` now guards against the persisted settings blob being a non-object (null, array, string, primitive). On corruption, resets to defaults via `structuredClone(DEFAULT_SETTINGS)` and surfaces a toast warning instead of leaving the UI un-rendered.
- **`Save Current` preserves linked-chats array**: `saveDbProfile()` now spreads the existing profile before overwriting, matching the canonical pattern already used in `autoSaveDbProfile`. Previously, manually saving a profile dropped its `linkedChats` field.
- **Writer Format placeholders**: switched `.replace()` → single-pass regex `/\{(facts|draft)\}/g` so multiple `{facts}` / `{draft}` in the template all get substituted, and there's no order-dependent re-substitution if `factsText` contains the literal string `{draft}`.
- **Writer Format safety guard**: if `{facts}` or `{draft}` is missing from the template, the corresponding section is now appended at the end instead of silently dropped from the prompt.
- **Settings validation/clamping**: added `clamp()` + `validateSettings()`. Persisted garbage values (e.g. `contextMessages: -1`, `secondaryChance: 250`) are now coerced to valid ranges on load instead of showing labels like `-100%` and feeding bad slice counts to Agent 1.
- **Textareas save on every keystroke**: prompt textareas (`#bf_mem_draft_prompt`, `#bf_mem_memory_prompt`, `#bf_mem_writer_format`) now persist on `input` instead of `change` (blur). Long edits no longer lost on navigation. Also removed `.trim()` from input handler so trailing whitespace survives.

### Migrations
- Added `migrateLegacySettings()` for soft migration of the deprecated `extension_settings.bf_memory` key. Copies legacy fields (`recentMessageCount`, `customExtractorPrompt`, `customWriterRule`, `extractorProfileId`, `useExtractorProfile`) into the current schema if the current value is unset. The old key is left in place for rollback safety, per ST core convention. `schemaVersion` marker prevents repeated migrations.

### Internal
- `Object.hasOwn` (modern idiom) used in defaults-merge loop instead of `=== undefined`.
- All five fixes validated via three independent research agents (community / ST core source / extension repos) and a final code-review pass.

## [0.2.0] - 2026-05-16

### Added
- **Database Profiles**: save/load/delete database snapshots from the Database tab
  - Share fact sets across characters or restore previous states
  - Dropdown shows profile name, DB count, and fact count
  - Save Current (overwrite), Save As New (prompt for name), Load, Delete
- Profiles stored globally in extension settings (persist across all chats)

### Fixed
- Generation trigger no longer posts "weird" system messages to chat
  - Now uses `context.Generate('normal')` directly instead of `/trigger` slash command
  - Falls back to `/trigger` only if Generate isn't available

## [0.1.0] - 2026-05-16

### Added
- Initial release
- 3-agent pipeline: Draft Agent -> Fact Retrieval -> Writer -> Memory Updater
- Draft Agent (Agent 1): plans reply direction and lists needed facts
- Writer (Agent 2): injects memory context into main model's prompt
- Memory Updater (Agent 3): extracts facts from confirmed messages, updates databases
- Fact Retrieval: pure DB lookup with tiered relevance (no LLM cost)
  - Primary facts: always included
  - Secondary facts: configurable chance (default 50%)
  - Tertiary facts: configurable chance (default 15%)
- Smart fallback mappings (location->furniture, food->allergies, etc.)
- Database system: many small DBs (max 50 facts each) via ST Data Bank
- Fact ownership tracking (who knows what)
- Cross-reference relationships between databases
- Swipe safety: only processes N-1 message, never current
- Review popup: user reviews new/changed facts every N messages
- Separate connection profile for cheap/fast agents (Draft + Memory Updater)
- Writer uses default SillyTavern profile (main model)
- Settings UI with all configurable parameters
- Database browser
- Debug logging panel
