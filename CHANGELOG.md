# Changelog

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
