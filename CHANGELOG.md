# Changelog

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
