# Changelog

## [0.25.0] - 2026-05-24

### Added — housekeeping + taxonomy growth (350 → ~1000 labels, and a growth engine)
Closes the rebuild roadmap: the small portability/log fixes, plus the shelf-label expansion with both a manual and an AI-assisted way to keep growing it. The fact schema is unchanged and existing facts keep resolving — taxonomy growth never rewrites the store.

**Portability seam.** Core data/LLM/logic modules (`database`, `llm-call`, `fact-retrieval`, and the agent-* modules) now reach SillyTavern only through a single thin adapter (`src/host.js`) instead of touching the `SillyTavern` global directly — so the engine stays "loosely clipped" and could move to another host later without a rebuild. Behavior is unchanged (pure indirection). ([src/host.js](src/host.js) + migrated core modules)

**Log fix.** Switching chats no longer loses the last few (especially verbose) debug-log lines: the outgoing chat's log tail is flushed to its own file before the buffer swaps to the new chat. ([src/settings.js](src/settings.js))

**Taxonomy expanded to a ~1000-label 3-level tree.** Layer 2 grew from ~90 flat aspects to **~940 leaf aspects** organized under **~77 sub-areas** within the 7 fixed categories (People holds ~⅓; the old `Time` idea folds under World). The fact still stores only `category` + `aspect`; a flattener preserves the exact storage/menu/retrieval contract, so nothing downstream changed. The Scribe now navigates a grouped (drill) menu instead of a flat list, and a synonym layer canonicalizes near-duplicates (`phobias→fears`, `occupation→career`, …) so the same concept always files to one leaf. Every prior label is preserved and every old fact still resolves. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js))

**User-added labels.** From the Database tab you can add your own Layer-1 categories and Layer-2 leaves; they persist in a global overlay merged on top of the built-ins, are deduped/canonicalized on add (a near-duplicate is absorbed as a synonym, not a second label), and show with a "custom" marker. ([src/database.js](src/database.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html), [style.css](style.css))

**AI "Suggest new labels" button.** A manual, on-demand action (no per-turn cost): it scans homeless facts (the `Unsorted/misc` pile + facts stuck on a category default), asks the model once to cluster them and propose new leaves (reusing existing labels where possible), and shows them in an **approve/reject** popup. Approved labels are written through the same deduped overlay path. ([src/taxonomy-suggest.js](src/taxonomy-suggest.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**Also:** the Database tab no longer shows the obsolete `/50` per-category cap (removed by the never-delete work) — it shows the real fact count and how many are cold-tiered.

## [0.24.0] - 2026-05-24

### Added — scale work, part 2: infinite facts, recall, summaries, episodic memory, auto-linking
The rest of the rebuild toward unbounded memory (the "1–9" batch), built on the 0.23.0 storage foundation. All additive; the two new injection/tool features are **default-OFF** so existing behavior is unchanged until you opt in. Needs in-browser testing for the IndexedDB- and tool-calling-dependent paths.

**1 · Never throw memories away (uncap + cold tier).** The ~50-per-category hot cap no longer **deletes** overflow — the lowest-salience facts are marked `cold` (kept on disk, still queryable, just deprioritized) and **resurface** the moment they're re-mentioned or directly matched. Nothing is ever evicted. ([src/database.js](src/database.js))

**2 · Indexed retrieval + scoped Scribe dedup.** A per-turn in-memory index (`byCatAspect` / `bySubject` / `byToken` / `aspectCounts`) replaces the several O(all-facts) scans the hot paths each did, so retrieval stays fast at tens of thousands of facts. The Scribe's duplicate check now looks at a **scoped candidate set** instead of dumping the whole DB into its prompt. ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-memory.js](src/agent-memory.js), [src/pipeline.js](src/pipeline.js))

**4 · Use-it-or-lose-it.** Facts that actually get injected into the Writer's context are **strengthened** (a `useCount` + `lastUsedAt` refresh feeds salience), so frequently-used facts stay hot and win scarce slots; untouched facts decay and drift cold (never deleted). Bumps persist via the existing post-reply save. ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/pipeline.js](src/pipeline.js))

**5 · Writer recall tool (pull-detail) — default OFF.** Optional `search_memory` function-tool exposed on the main Writer path: when the Writer needs a fact that wasn't pushed, it can fetch it on demand (deterministic, zero-API, read-only, hard-capped). Enable in the Writer tab; requires a tool-calling-capable main model. ([src/agent-writer.js](src/agent-writer.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html), [index.js](index.js))

**6 · Summary pyramid + multi-pass — injection default OFF.** The reflection pass now also maintains a short **per-shelf** (category/aspect) summary rolling up into the existing whole-story summary, folded into the one reflection LLM call and cost-bounded (only changed buckets, capped per pass). An optional **"Big Picture"** block injects the story + scene-relevant shelf summaries above the facts (token-capped); the Writer drills into specifics via the recall tool. ([src/agent-reflect.js](src/agent-reflect.js), [src/agent-writer.js](src/agent-writer.js), [src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**8 · Episodic scene memory.** New `moment` fact kind for significant emotional/relational beats (slower decay than ordinary events — 30-day half-life), with an optional short `tone` field surfaced compactly to the Writer. The Scribe records genuine turning points as a narrative beat in the note (who + where + why it mattered), not just dry `key = value`. ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-finder.js](src/agent-finder.js), [src/agent-memory.js](src/agent-memory.js))

**9 · Automatic associative linking.** A freshly-written fact deterministically auto-links (zero-API) to related existing facts by shared subject / location / `involved` members / lexical token overlap, recorded into `relationships` (unioned, never clobbered, hard-capped). Retrieval's existing link-following then surfaces the connections. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**Never-delete compliance.** The reflection janitor's re-evaluation **DROP** verdict now **cold-tiers** the fact instead of deleting it (the only remaining automated `removeFact` is a category *relocation* during PROMOTE, which preserves the fact). ([src/agent-reflect.js](src/agent-reflect.js), [src/database.js](src/database.js))

*(Items 3 and 7 — scoped dedup and the speed fixes — shipped in this batch and 0.23.0 respectively.)*

## [0.23.0] - 2026-05-24

### Changed — scale work, part 1: speed fixes + hybrid storage foundation
First two steps of the rebuild toward unbounded memory. Backward-compatible; falls back to prior behavior if the new storage can't initialize.

**Performance fixes (safe, immediate).** ([src/database.js](src/database.js), [src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))
- `getAllDatabases()` is now memoized per turn (keyed by character avatar) and invalidated on every write/chat-change — it was being re-fetched + re-parsed ~4-5× per turn.
- The whole chat is no longer re-serialized every turn just to stamp `bf_mem_processed` — a chat save is triggered only when the flag actually changed.
- The full chat is no longer tokenized twice per turn for the token stat (the no-trim path reuses the baseline + injection count).
- The "run on current chat" backfill loads the DB once before the loop (not per message) and yields periodically so it can't freeze the UI.

**Hybrid persistence foundation (durable + fast).** ([src/database.js](src/database.js))
- Facts now live in a fast **IndexedDB** working store, with the existing SillyTavern character-attachment kept as a **durable, device-independent snapshot/backup** (throttled write + flush on chat-change/unload). On a new device or cleared cache it **rehydrates** IndexedDB from the snapshot; existing attachment DBs are **migrated** into IndexedDB once on first run.
- **Graceful fallback:** if IndexedDB is unavailable, blocked (private mode), or errors at any point, the extension transparently reverts to attachment-only behavior (zero regression). Every fallback is logged once (`storage.fallback`) so it's visible in the Debug tab.
- The public storage API and the per-turn cache contract are unchanged — no caller behavior changed this phase. (The fact cap is **not** removed yet; that and indexed-query retrieval come in the next phases on top of this foundation.)
- **Note:** IndexedDB can't be exercised outside a browser, so this needs real in-browser testing; the fallback keeps it safe if anything misbehaves.

## [0.22.0] - 2026-05-24

### Changed — agents renamed, menus reorganized, Scribe prompt reworked
A clarity + usability pass across the whole UI and the memory-extraction prompt.

**Agents renamed (UI labels only; internal keys unchanged).** Agent 1 → **Drafter**, Agent 2 → **Writer**, Agent 3 → **Scribe** (writes facts to memory), Agent 4 → **Librarian** (fetches facts for the Writer). Settings tabs reordered chronologically — **Drafter → Librarian → Writer → Scribe** → General → Database → Last Generated → Last Inserted → Tokens → Debug — and the Librarian got its **own tab** (the finder toggle / connection profile / prompt moved there from the Writer tab). ([templates/settings.html](templates/settings.html), [src/settings.js](src/settings.js))

**Scribe (memory) prompt reworked.** Now explicitly instructed to **read the whole message including dialogue** (dialogue is the best signal for character growth + relationships); the `>note` field is used for a **verbatim quote OR a short summary** when atomic tags can't carry the moment; uncertain one-offs are **recorded to `Unsorted`/misc** (with `conf:low`) instead of skipped, and the reflection pass gained a **re-evaluation step** that later promotes recurring misc facts to a proper aspect or drops confirmed one-offs. The per-message character limit on the Drafter's view was **removed** (it reads full messages now). ([src/agent-memory.js](src/agent-memory.js), [src/agent-reflect.js](src/agent-reflect.js), [src/pipeline.js](src/pipeline.js))

**Value↔note: store both, slim at injection.** The Scribe always writes BOTH the atomic value and (when warranted) the note — full fidelity in the DB. The **Writer injection now shows the note in place of the value** when a fact has one (the note already contains the gist), avoiding value+note duplication in the Writer's context. Applies across all three injection formatters. ([src/agent-memory.js](src/agent-memory.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-finder.js](src/agent-finder.js), [src/pipeline.js](src/pipeline.js))

**Menu cleanup.** Removed the inert secondary/tertiary chance sliders (dead since deterministic retrieval), the "story so far" checkbox, and the "use separate profiles" toggle (per-agent connection profiles are now always active via [src/profiler.js](src/profiler.js)). The Librarian context slider was replaced with an explanation (it always reads the last 2 messages). The Scribe tab was reordered (prompt up top, re-evaluation fields at the bottom). ([templates/settings.html](templates/settings.html), [src/settings.js](src/settings.js), [src/profiler.js](src/profiler.js))

**Prompt transparency.** Each agent's prompt editor now has a read-only **"What actually gets sent (assembly order)"** box showing how the final prompt is built (system prompt + the auto-injected character card / persona / Memory Menu / recent chat / facts / scene card / draft), accurate to the actual `build*Prompt` / `buildWriterInjection` code. ([templates/settings.html](templates/settings.html), [style.css](style.css))

**Verbose log persisted to its own file.** The full debug log (including verbose) is now written to a dedicated per-chat attachment file (`bf_mem_debuglog_<chat>.json`, capped ~4000 entries, throttled 15s + on unload, reloaded on chat open) — so verbose history survives reload **without** bloating the chat `.jsonl` (a small non-verbose slice still lives in chat metadata for instant paint). ([src/settings.js](src/settings.js), [src/database.js](src/database.js))

## [0.21.0] - 2026-05-24

### Added — comprehensive debug logging + queryable Debug tab (Phase 8)
The flat, lossy text log became a structured, run-grouped, before→after audit trail that answers "what ran when, what changed, why" — without bloating `chat_metadata` or breaking the existing readers. Entirely additive: every entry still carries the legacy `{type, message, timestamp}` keys, so the old Copy export and persisted-log shape-check keep working.

**Structured entry schema (Phase 8a — logging core).** Each log entry gains `level` (5-value superset of the 3-value `type`), `subsystem`, `runId`, `event` (dotted machine key), `data` blob, `reason` code, `before`/`after`, plus `seq`/`ts`/`iso` for stable, machine-parseable ordering. `addDebugLog` stays backward-compatible (2-arg legacy form still valid; new `opts` object is optional), with a RAM ring buffer (`MAX_DEBUG_ENTRIES_MEM = 2000`, drop-oldest) and a separate verbose-stripped, byte-budgeted persisted slice (`MAX_DEBUG_ENTRIES_PERSIST`). Old persisted logs back-fill `level`/`subsystem`/`ts` and parse a leading `[Rxxxx]` prefix so they still group. ([src/settings.js](src/settings.js))

**Instrumented ~135 events across subsystems (Phase 8b).** Pipeline, agents 1/3, finder, retrieval, db, entity, and reflection now emit structured events. Previously **silent fact mutations** (new/updated/superseded/skipped/evicted/deleted) are logged with compact `before → after` diffs and `reason` codes. Retrieval emits an **admission + exclusion ledger** answering why each fact was or wasn't used, with an on-demand `explainFactRetrieval(key)` "why not?" probe. Each turn shares ONE `runId` across the pre-reply and post-reply boundary, ending in a single `run.summary` event (duration, per-agent status, fact counts, token accounting). Cache-eligibility is logged honestly (client `cache_control` is stripped server-side). ([src/pipeline.js](src/pipeline.js), [src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-memory.js](src/agent-memory.js), [src/agent-reflect.js](src/agent-reflect.js), [src/agent-entities.js](src/agent-entities.js))

**Debug tab UI (Phase 8c).** ([templates/settings.html](templates/settings.html), [src/settings.js](src/settings.js), [style.css](style.css))
- **Per-run grouping.** Entries collapse into one `<details>` block per `runId` (newest first, collapsed by default), with the `run.summary` rendered as a compact header (e.g. `Run R3f2 · 320ms · A1✓ A3✓ · facts 3N/1U/0S · +4.1k tok`). Run-less entries collect under an "Ungrouped / manual" section.
- **Filter toolbar.** Level checkboxes (fail/pass/info default-on, debug/verbose opt-in), a subsystem dropdown, and a runId/text search — all pure client-side passes over the in-memory buffer, re-rendering on change, with a live `showing N / total` count. Entries are color-coded by level.
- **Verbose toggle.** A clearly-labeled checkbox bound to the `debugVerbose` setting — when off, verbose entries are dropped at ingestion (RAM-only firehose, never persisted) and the verbose display checkbox greys out.
- **JSON export.** A new "Export JSON" button downloads + copies the full ring buffer via `exportLogsJSON()`; the existing text Copy/Clear buttons are unchanged.
- **"Why not?" probe.** A small input + button calls `explainFactRetrieval(key)` and shows the fact's fate inline.

## [0.20.0] - 2026-05-23

### Changed — token-cost savings (after a 3-agent overspend audit)
An audit found ~3 LLM calls every turn re-sending overlapping context, with Agent 3 (the note-taker: a ~4.2k-token prompt + the full fact DB) the dominant cost, re-running on every generated swipe. This release lands the safe code-side savings; the biggest win (caching Agent 3's static prompt) is a server-side SillyTavern setting (see note).

- **Per-swipe extraction gated.** Agent 3 extraction was firing on every generated swipe (4 swipes ≈ 4× the ~7k-token call). Both `MESSAGE_RECEIVED` and `MESSAGE_SWIPED` now feed a single ~1.8s settle-debounce (`scheduleSettleExtraction`), so a heavily-swiped turn extracts **once** — on the kept/settled reply. A normal single-reply turn still extracts exactly once, promptly. All guards intact (`bf_mem_processed`, Stop/`pipelineCancelled`, capture-at-write, character-changed, `memoryExtractionInFlight`). Reflection + entity-check now also tick once per settled turn rather than per swipe. ([src/pipeline.js](src/pipeline.js))
- **Dead payloads dropped.** (a) The fact-key inventory (`summarizeKeys`) is no longer built or sent to Agent 1 when the finder is on (default) — it was only used by the deterministic fallback; the menu still goes to Agent 1 as before. (b) Reflection's rolling `#STORY` summary (no longer injected since 0.18) is no longer generated or fed back each pass — only the `#OBS` observation-writeback remains; the settings panel still renders observation chips. ([src/pipeline.js](src/pipeline.js), [src/agent-reflect.js](src/agent-reflect.js))

### Note — prompt caching is a server-side setting, not an extension feature
The biggest potential saving (caching Agent 3's large static system prompt) **cannot be set from an extension** — SillyTavern's connection layer strips client `cache_control`, and caching is driven by server config. The extension's prompts are already structured cache-optimally (static system prompt first, all variable data after). To enable it, set in SillyTavern's `config.yaml`: `claude.enableSystemPromptCache: true` (and optionally `claude.extendedTTL: true`). A doc-comment recording this invariant was added to [src/llm-call.js](src/llm-call.js). ([src/llm-call.js](src/llm-call.js))

## [0.19.0] - 2026-05-23

### Changed — granular ~82-label Layer-2 taxonomy + two-tier menu
The broad Layer-2 labels (identity/appearance/body/status/…) were too coarse — a planner LLM picked almost all of them every turn, so the menu didn't filter. Replaced with a granular, scene-trigger vocabulary so opening a label is a real signal. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js), [src/agent-draft.js](src/agent-draft.js))
- **~82 granular Layer-2 labels** across the 7 categories. People gets the big set (childhood, finances, fears, wardrobe, injuries, secrets, vices, daily_routine, current_location, …) — specific drawers that stay shut in an ordinary scene.
- **Two-tier menu:** the planner (Agent 1) now sees ONLY non-empty labels with counts (small + discriminating even with 82 defined); the note-taker (Agent 3) and the Database tab see the FULL fixed vocab for consistent filing.
- **Relationships stay character-AGNOSTIC** (history/friendship/romance/tension/trust/…), discriminated by the existing `subj:@<A>` + `with:@<B>` pair-tag rather than a per-character label (avoids menu-cardinality blowup). 
- Back-compat: legacy aspects (body→appearance, background→childhood, role→career, goals→current_goal, behavior→habits, …) remap on read; unknowns snap to the category default.

### Fixed — ESM-breaking unescaped backtick (extension-load bug)
`DEFAULT_MEMORY_PROMPT` had one bare `` `~` `` (line 168) instead of an escaped `` \`~\` ``, which closed the prompt's template literal early. `node --check` (script mode) tolerated it, but SillyTavern loads extensions as ES modules, where it threw `SyntaxError: Unexpected token '~'` and broke `agent-memory.js` from loading. Now escaped; verified by a module-mode parse of every source file. (Latent since the supersession example was added.) ([src/agent-memory.js](src/agent-memory.js))

## [0.18.0] - 2026-05-23

### Changed — 3-layer fact model (rough → aspect → character-tag) + default skeleton
Restructures how facts are organized and retrieved, fixing two problems: (1) nothing seeded the structure, so a fresh chat had zero layers until a fact landed; (2) the character was the Layer-2 menu branch, so every character surfaced in the menu and the detail finder pulled ALL of a character's facts (token cost). Backward-compatible — legacy facts/categories are remapped on read.

**New 3-layer model.** ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js))
- **Layer 1 — `category`** (rough, genre-agnostic): `People · Places · Things · Relationships · Events · World · Unsorted`. A legacy-category map (`mapLegacyCategory`, scope-sensitive) re-buckets the old Identity/World/Status/Behavior/History categories on read, so existing databases keep working.
- **Layer 2 — `aspect`** (new field, fixed vocab per category, character-agnostic): e.g. People→ identity/appearance/body/background/role/status/mood/goals/behavior/skills; Places→ residence/public/region/feature; Events→ milestone/scene/action; etc. (`TAXONOMY` constant.) Agent 3 emits it via `aspect:`; falls back to a per-category default when omitted.
- **Layer 3 — character tag.** The character is now a TAG carried in `involved` (`with:@<NAME>` / `@npc`), NOT the menu branch. A person's facts live across many category/aspect branches and are pulled by tag-filter, not by a per-character branch.

**Default skeleton from turn 1.** The full Layer-1 + Layer-2 taxonomy is a code constant; `buildSkeletonDatabases`/`withSkeleton` present the complete empty skeleton (categories + aspects, counts 0) in the menu and the Database tab from the very first turn — no more "No databases yet." Empty-file spam is avoided: category files are written on first fact (write-on-first-fact), not seeded as empty uploads. ([src/database.js](src/database.js), [src/settings.js](src/settings.js))

**Menu + finder rewired to category/aspect with a character tag-filter.** ([src/agent-draft.js](src/agent-draft.js), [src/pipeline.js](src/pipeline.js), [src/agent-finder.js](src/agent-finder.js))
- `summarizeMenu` + `collectBranchFacts` now key off `category/aspect` (character-agnostic), so the menu Agent 1 sees stays small no matter how many characters exist.
- Agent 1 picks `Category` / `Category/aspect` `#Branches`, and optionally names the focus character(s) in a new `#Focus:` line (which never becomes a branch).
- New `filterCandidatesByFocus` keeps, for the detail finder, the focus character's facts + all non-character (place/event/world) facts + untagged facts + the always-included `Unsorted` catch-all, and drops other characters' character-scoped facts in the same aspects — so the finder is never handed every character's stuff. Applied before `expandLinks`, so place⇄event⇄people link-following and place-recall still function. Empty/over-narrow candidate sets fall back to deterministic retrieval.

## [0.17.0] - 2026-05-23

### Added — entity scope + link-following retrieval + character registry (Phase 4)
The full arc since 0.16.0, landed across four sub-phases. All backward-compatible (absent fields/state/settings behave as before).

**Phase 4a — scope + participants + place filing.** Facts gain an explicit `scope` axis (`character | place | event`) so the store knows whether a row describes a person, a location, or something that happened; derived deterministically from category/track when the model omits it. Event facts carry an `involved` participant list (the who) and a `location` link (the where), so a single event can tie people⇄place together. Unnamed/one-off people file under a shared `npc` drawer (`subj:npc | with:<the descriptor>`) instead of cluttering the store, and a place-filing fix routes World/location facts to the correct `place` scope so they stop being mis-derived as characters. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))

**Phase 4b — link-following retrieval.** A new graph-walk pass expands the candidate set along the scope links AFTER the lexical/fuzzy layers: place→events, person→events, event→place, and event→people. Any retrieved event pulls in the place it happened at and the key facts of each `involved` participant, so recalling one node surfaces the connected ones without extra API calls. Bounded by the existing tier caps; deterministic. ([src/fact-retrieval.js](src/fact-retrieval.js))

**Phase 4c — character registry + recurring-cast detection.** A per-chat character registry tracks every named entity seen (name, status, first/last-seen, mention count). An every-N-message detector flags recurring people, freshly-named NPCs, and walk-ons worth promoting, batched into a single Recurring/NPC/Later review popup instead of interrupting per message. Promoting an NPC auto-migrates its `npc_*` facts onto the real name (re-keyed, subject restamped). New registry UI surfaces the tracked cast and pending promotions. ([src/agent-entities.js](src/agent-entities.js), [src/review-popup.js](src/review-popup.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**Phase 4d — anonymization + secrets pass (release prep).** Final sweep before going public: every illustrative person/place/org/object name in code comments, prompt examples, and CHANGELOG/README prose was replaced with generic placeholders (`<NAME>`, `<CHAR>`, `<PLACE>`, `<CITY>`, `<ORG>`, `<PET>`, `<OBJECT>`), and the README walkthrough rewritten to use placeholders throughout. No functional code, element IDs, function names, settings keys, or grammar markers were changed — illustrative content only. A credential scan (API keys, tokens, bearer strings, hex/base64 blobs) found nothing to redact. ([README.md](README.md), [src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js))

## [0.16.0] - 2026-05-23

### Added — extraction-quality + two-stage retrieval + latency arc (Phases 1–3b)
The full arc since 0.15.0, landed across four phases. All backward-compatible (absent fields/state/settings behave as before).

**Phase 1 — extraction quality + a catch-all.** Closes the "facts get mis-filed or silently dropped" class.
- **Unsorted catch-all.** A new `Unsorted` category is a first-class home: a fact whose category matches none of the six topical buckets is routed there instead of being silently mis-filed as `Status`. Active Unsorted facts are ALWAYS folded into retrieval candidates (`collectBranchFacts`) so the catch-all can never be blanked. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **Subject axis.** Facts gain an explicit `subject` (who/what the fact is ABOUT) via an `aka`-grammar-compatible `subj:` segment, deterministically derived from the key prefix when omitted, so the field is always present downstream as a real index axis. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **Mandatory importance + kind.** `!N` (1–5) and `kind:trait|state|event` are now required on every fact; when the model omits them they are INFERRED from observable signals (category/track/key) and FLAGGED `inferredFields` (inferred-vs-stated) rather than silently defaulted. These protect foundational facts from eviction and rank retrieval. ([src/agent-memory.js](src/agent-memory.js))
- **Provenance.** Optional `conf:high|med|low|0-1` confidence and a `validAt` stamp (the source message index where the fact became true) ride along, both optional/back-compat. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **Parallel-key dedup.** `upsertFact` reconciles on write — on an exact-key miss it conservatively matches a normalized-key variant and updates in place instead of minting a parallel contradictory key. ([src/database.js](src/database.js))

**Phase 2 — two-stage menu→detail retrieval.** Replaces the single blind keyword pass with a cheap menu pick + a focused detail finder, all without embeddings.
- **Stage 1 — menu.** New `summarizeMenu()` builds a compact KIND×SUBJECT map (counts, NO values); Agent 1 picks relevant `#Branches` from it. ([src/database.js](src/database.js), [src/agent-draft.js](src/agent-draft.js))
- **Stage 2 — finder.** New module [src/agent-finder.js](src/agent-finder.js) (`runFinderAgent`, Agent 4) reads the FULL active facts under Agent 1's picked branches (plus Unsorted), and chooses the precise set to inject. New Agent 4 connection profile id (`getAgent4ProfileId`). ([src/profiler.js](src/profiler.js))
- **Rename-tolerant `knownBy` + deterministic fallback.** Visibility filtering is rename-tolerant; when the finder is disabled, errors, times out, or returns nothing, retrieval falls back to the deterministic speculative+delta-keyword pass which ALWAYS still folds in active Unsorted facts — a failed detail pass can never blank memory. ([src/pipeline.js](src/pipeline.js), [src/fact-retrieval.js](src/fact-retrieval.js))

**Phase 3a — injection slimming + reflection-as-janitor + finder UI.** Dropped the "story so far" injection from the writer (the writer now receives only the scene sheet + chosen facts + Agent 1's draft); raised the Agent-1 draft per-message char limit (and character-card limits) so long turns aren't truncated; next-scene hints (`#NextHint`) are stashed as a backstage breadcrumb on the user message's `extra` (never injected); the reflection pass became a silent dedupe-janitor / observation writer (no longer injects); finder settings/UI surfaced. ([src/pipeline.js](src/pipeline.js), [src/agent-draft.js](src/agent-draft.js), [src/agent-writer.js](src/agent-writer.js), [src/settings.js](src/settings.js))

**Phase 3b — Agent 3 OFF the blocking path + swipe fixes.** The latency + swipe-quality cleanup.
- **Agent 3 moved off the pre-generation blocking path.** Previously the user waited for Agent 3 to extract facts about the PREVIOUS exchange before THEIR reply generated. Agent 3 (`runMemoryUpdater`) now runs POST-reply on `MESSAGE_RECEIVED` (new `runMemoryExtraction()`), the same off-critical-path place reflection already uses. The blocking path now runs ONLY Agent 1 (draft/menu) + speculative retrieval + the Stage-2 finder (the agents that feed THIS reply). The reply is fully present by extraction time, so we extract the real accepted text — and the AI message itself is the target (`findMemoryTargetIndex(chat, true)`). Every guard is preserved: `bf_mem_processed` gating (no double-extract), `pipelineCancelled`/Stop discards the write, capture-at-write of the DB profile + character avatar (pinned at extraction start, the correct moment now timing shifted), group/dry/internal skips, and the review-popup/`saveChatDebounced`/`saveCurrentToActiveProfile` commit. Wrapped in try/catch — an extraction failure can never break generation or the next turn. A `memoryExtractionInFlight` guard prevents overlapping extractions. ([src/pipeline.js](src/pipeline.js))
- **Token accounting kept consistent.** The blocking path records the run once with Agent 3 = 0 (`recordRunTokens({…, memoryResult: null})`); a new `addAgent3Tokens()` folds Agent 3's input/output into the session totals on `MESSAGE_RECEIVED` WITHOUT bumping the run count or re-counting baseline/actual input, and updates `lastRunTokens.agent3*` so the per-run breakdown still shows the Agent 3 line. ([src/settings.js](src/settings.js), [src/pipeline.js](src/pipeline.js))
- **Swipe fix (a) — no stale draft on a divergent re-roll.** Swipes/regens previously re-injected the cached injection verbatim, including Agent 1's draft scene-direction planned for the ORIGINAL roll, which mis-steered a divergent re-roll. A second cached injection (`lastInjectionNoDraft`) carries the SAME scene + facts (turn-stable, safe to reuse) but DROPS the stale draft; both swipe re-inject paths now use it. Still fast — no agent re-run. ([src/pipeline.js](src/pipeline.js))
- **Swipe fix (b) — extract the ACCEPTED swipe.** With Agent 3 on `MESSAGE_RECEIVED` targeting the just-received message, generating any swipe extracts the accepted content (the active swipe IS the message's current text) — closing the gap where a swiped-then-stopped reply never got extracted. Navigating onto an ALREADY-generated swipe (which fires `MESSAGE_SWIPED` but not `MESSAGE_RECEIVED`) is handled by a debounced settle-extraction scheduled in `MESSAGE_SWIPED`; rapid navigation only extracts the final settled swipe, and the `bf_mem_processed` gate prevents double-extracting the same accepted content. The timer is cleared on chat change. ([src/pipeline.js](src/pipeline.js))

## [0.15.0] - 2026-05-23

### Added — reflection/consolidation + middle-ground retrieval (no vectors)
Two upgrades closing out the memory-research blueprint. Backward-compatible (absent fields/state behave as before).

**Reflection / consolidation pass (Phase 3).** A periodic pass that compresses accumulated detail into higher-level memory so long sessions keep narrative continuity without unbounded growth. New module [src/agent-reflect.js](src/agent-reflect.js): `runReflection()` makes ONE LLM call (reusing Agent 3's connection profile) over a bounded bundle (prior summary + scene/beats + a few timeline steps + a compact active-fact summary), parsing a `#STORY` summary + `#OBS` observations. Cost-aware and infrequent: armed at the end of a successful pipeline run and executed on `MESSAGE_RECEIVED` (off the latency-critical path), wrapped in graceful-degradation so a failure never breaks the pipeline. Write-back: the rolling summary is stored per-chat in `chat_metadata.bf_mem_reflection` (`getReflection`/`setReflection`/`reloadReflectionFromChat`, reloaded on CHAT_CHANGED), and observations (e.g. "<CHARACTER> manipulates others for resources") are written as `Behavior` facts with `kind:trait`, importance 4, tags `observation`/`reflection`, so they ride the existing retrieval/eviction/supersession machinery (reconcile-on-write prevents duplicate spam). Optional "[Story so far]" injection below the scene card, hard-capped. New settings: `reflectionEnabled` (default on), `reflectionInterval` (default 12, clamped 4–100), `reflectionInject`, `reflectionMaxTokens` (default 200), `reflectionPrompt` — toggle + interval slider + inject toggle + live read-only view + prompt editor in the Agent 3 tab. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**Middle-ground retrieval — a 3-layer cascade, no embeddings, no extra API calls.** Replaces the rejected vector approach (browser-only / mobile cost / storage bloat / loss of bounded predictability; and Agent 1 already provides the semantic step). Solves the synonym/paraphrase brittleness of pure keyword matching (e.g. a fact stored under one label not matching a later paraphrase or descriptor for the same subject):
- **Layer A — aliases-at-write.** New optional `aliases: string[]` on the fact schema. Agent 3 optionally emits nicknames/descriptors via an `aka:` segment; `searchFacts` folds them into the match text (MATCH-ONLY — never shown to the writer, mirroring `context`); `upsertFact` unions+dedupes aliases across re-mentions. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js))
- **Layer B — local fuzzy fallback.** New `trigramSimilarity()` (char-trigram Jaccard, zero deps); when a needed-info entry yields no primary hit, token-level fuzzy match against each active fact's `key value tags aliases` admits matches ≥ `FUZZY_THRESHOLD` (0.4) as secondary (bounded by the existing cap). Catches typos/morphology (apartments→apartment, <NAME>s→<NAME>). Deterministic. ([src/fact-retrieval.js](src/fact-retrieval.js))
- **Layer C — caged Agent-1 rerank.** `DEFAULT_DRAFT_PROMPT` tightened to "pick from the menu first" — Agent 1 prefers exact `Category/key` from the inventory for current-moment subjects INCLUDING paraphrases the lexical layers can't bridge; `resolveExactKeys` hardened (whitespace/punctuation-tolerant, validated against the inventory so hallucinated keys are silently dropped). ([src/agent-draft.js](src/agent-draft.js), [src/fact-retrieval.js](src/fact-retrieval.js))

Integration order in `retrieveFacts`: exact-key picks → primary; keyword+alias → primary/secondary; fuzzy fallback → secondary (uncovered needed-info only). Existing tier caps, salience ranking, sequence/track expansion, supersession + knownBy filtering all run unchanged afterward.

## [0.14.0] - 2026-05-23

### Added — temporal validity / supersession (memory-research Phase 3)
When a CHANGEABLE-STATE fact's value genuinely changes, the OLD value is now marked SUPERSEDED (retained as history) rather than silently overwritten — so retrieval surfaces only what's currently true while the timeline stays truthful. Backward-compatible: facts without the new fields behave exactly as before (treated as currently valid).

**Validity representation.** Facts gain optional `active` (absent/`true` => currently valid), plus `supersededAt` (ms, doubles as validTo) and `supersededBy` (history breadcrumb) on the inactive snapshot. `isActiveFact()` is the single filter ([src/database.js](src/database.js)). Chosen for simplicity: retrieval just checks `active !== false`.

**Write path — lightweight, capped.** `upsertFact` now snapshots the OLD value as a retained-but-inactive copy (under a distinct `__was` key so reconcile-on-write never collapses onto it) and advances the canonical fact in place to the new ACTIVE value. Gated by `shouldSupersede`: triggers only for a CHANGEABLE-STATE existing fact (`kind:state`) whose value MATERIALLY changed, or on an explicit Agent-3 signal — durable traits (name/age) keep today's silent in-place correction (a typo fix is not a supersession). Only the SINGLE most-recent snapshot per logical key is retained (older ones pruned) so it never blows the 50-fact cap; track/sequence facts remain append-only and are untouched. ([src/database.js](src/database.js))

**Extraction — optional `~` marker.** Agent 3 may append `| ~` to mark a write as replacing the prior value of a changeable-state fact. Optional: if omitted, supersession is inferred from changed `kind:state`. New grammar marker doesn't collide with `|/@/#/rel:/@src:/>/track:/!N/kind:`. Prompt + the relocation example updated minimally. ([src/agent-memory.js](src/agent-memory.js))

**Retrieval — current-only by default.** `searchFacts`, the relationship-expansion pass, `resolveExactKeys`, the Agent 1 key inventory (`summarizeKeys`), and Agent 3's existing-DB summary all skip superseded facts, so only currently-valid facts are injected/listed. History is retained on disk (and dovetails with the track/diary feature). ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-memory.js](src/agent-memory.js))

**Eviction — history compresses first.** Superseded facts get the lowest salience score (≈ -1, with a tiny recency tiebreak) in `saveDatabase`, so they are the FIRST evicted under the cap — track-step protection unchanged. ([src/database.js](src/database.js))

## [0.13.0] - 2026-05-23

### Added — always-on scene card (live core working memory)
A tiny, always-injected block telling the writer WHAT IS TRUE RIGHT NOW (MemGPT core-context idea) — so Agent 2 always has the present moment, not just a bag of facts. Backward-compatible: absent scene state behaves as no scene card.

**State model.** A single small per-chat object in `chat_metadata.bf_mem_scene`: `{ location, present[], goals[], beats[], updatedAt, runId }`. Shape-checked reload helpers `getScene` / `setScene` / `reloadSceneFromChat` ([src/settings.js](src/settings.js)) mirror the existing `bf_mem_*` pattern (tokens/log/facts) and reload on CHAT_CHANGED so it survives reload and is per-chat scoped. Beats are a rolling window of the last 3 (append newest, drop oldest, de-dupe immediate repeat).

**Update path — NO new LLM call.** Folded into Agent 1 (the draft planner, which already runs every pipeline turn and reasons about the current scene). Agent 1's output grammar gains an optional `#Scene` block (Location / Present / Goals / Beat); `parseSceneBlock` extracts it without breaking the existing `#Draft` / `#Needed_Facts` outputs (the Needed_Facts capture is now bounded before `#Scene`). pipeline.js persists it via `setScene` each run, guarded by the same not-cancelled + character-didn't-change checks as Agent 3 writes. ([src/agent-draft.js](src/agent-draft.js), [src/pipeline.js](src/pipeline.js))

**Injection — always, hard-capped.** `buildSceneBlock` ([src/agent-writer.js](src/agent-writer.js)) renders one compact line `[Scene] Location: … | Present: … | Goal: … | Recently: …`, hard-capped (~150 tokens, defensive char-budget truncation with ellipsis). `buildWriterInjection` prepends it ABOVE the fact list in the single combined injected system message. Injected EVERY turn the pipeline runs (and re-injected on swipe/regen via the cached injection) whenever enabled and a scene exists — regardless of whether facts were retrieved. Not injected when the pipeline is disabled/skipped/cancelled.

**Settings + UI.** New `sceneCardEnabled` (default true) + `sceneCardMaxTokens` (default 150, clamped 30–400) in DEFAULT_SETTINGS + `validateSettings`. Toggle `bf_mem_scene_enabled` and a read-only live scene view (`bf_mem_scene_view`) added to the Agent 1 tab. ([src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

## [0.12.0] - 2026-05-23

### Added — smarter retrieval, fact context, and an ordered "diary"
Four workflow upgrades, each independently shippable and backward-compatible (older facts/settings load unchanged; absent new fields behave as before).

**Agent 1 stops guessing — fact key inventory.** Agent 1 previously got only the chat + character cards and free-associated keywords, so retrieval was blind to what facts actually existed. New `summarizeKeys()` ([src/database.js](src/database.js)) builds a compact `Category/key` inventory (keys only, no values) that is injected into Agent 1's prompt; Agent 1 now requests EXACT existing keys, and retrieval resolves `Category/key` requests by identity (`resolveExactKeys` in [src/fact-retrieval.js](src/fact-retrieval.js)) in addition to the existing fuzzy/keyword path. ([src/agent-draft.js](src/agent-draft.js), [src/pipeline.js](src/pipeline.js))

**Deterministic retrieval — no more random fact-dropping.** Removed the `Math.random()` gate that probabilistically dropped correctly-retrieved secondary/tertiary facts before injection (the real cause of "the writer skips facts"). Inclusion is now deterministic: all primary, then secondary up to `MAX_SECONDARY` (12), then tertiary up to `MAX_TERTIARY` (6) — token budget still bounded, behavior predictable. The legacy `secondaryChance`/`tertiaryChance` settings are retained for compatibility but no longer gate anything (sliders inert, marked deprecated; UI removal later). ([src/fact-retrieval.js](src/fact-retrieval.js))

**Writer sees the key + a stronger instruction.** `formatFactsForWriter` now emits `[knownBy] Category/key = value` (the key was previously dropped, so the writer couldn't tell similar facts apart). `DEFAULT_WRITER_FORMAT` rewritten to instruct the writer to actively USE facts as established truth and weave them in, not merely "don't contradict." ([src/agent-writer.js](src/agent-writer.js), [src/pipeline.js](src/pipeline.js))

**Optional CONTEXT note on facts.** New optional `context` field stores the prose around a fact (e.g. a strategic admission: the bare value plus the note that another character baited it). Agent 3 emits it via a `>`-prefixed segment and attaches it only when the surrounding situation changes the fact's meaning. Context is EXCLUDED from keyword matching and injected for PRIMARY-tier facts only (`Category/key = value — <context>`) to bound tokens. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js), [src/fact-retrieval.js](src/fact-retrieval.js))

**Linked "diary" (ordered event log) + depth-dice retrieval.** Sequences (e.g. a character's location over time) are now first-class instead of being overwritten:
- Facts gain optional `track` (timeline name) + `ord` (monotonic step). Each step is its OWN fact, **exempt from the reconcile-on-write collapse** that previously overwrote the chain. `ord` is auto-assigned at write time (`nextOrdForTrack`), so the model doesn't have to count. A separate single overwriting current-state fact keeps "where are they now" atomic. ([src/database.js](src/database.js): `isSequenceFact`, `getTrackSteps`, `nextOrdForTrack`)
- Eviction keeps the latest N steps PER track (round-robin trim of lowest `ord`, never below 1/track) so the 50-fact cap can't punch holes mid-chain or wipe a track. Non-sequence facts evict first.
- Retrieval (`expandSequenceTracks` in [src/fact-retrieval.js](src/fact-retrieval.js)): when a track is relevant, ALWAYS include the current step, then roll each depth tier; the reach = furthest successful roll; include every step from current back to that reach CONTIGUOUSLY (continuity guaranteed by a contiguous slice — no gaps). Default probabilities depth1–4 = 70/50/25/10%, exposed as **sliders** in the Agent 2 retrieval tab (`bf_mem_depth1..4`). ([src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

## [0.11.0] - 2026-05-23

### Fixed — 10 issues surfaced by a long real-session bug report
Each issue was diagnosed by an independent investigation pass, then fixed.

**Reliability**
- **Agent 3 silently stopped mid-session.** The trigger gate relied on a monotonic `lastTriggeredUserMsgIndex` that never rewound on swipe/Stop, so once it got ahead it permanently skipped every later turn. Now gated on the per-message `bf_mem_processed` flag (source of truth), with a shared `findMemoryTargetIndex()` and a new `MESSAGE_SWIPED` handler that rewinds indices and clears the stale flag. ([src/pipeline.js](src/pipeline.js))
- **Sticky cancel flag.** `pipelineCancelled` is now reset on `MESSAGE_RECEIVED`, so a Stop on one turn can't poison later turns.
- **Token counter desync.** `setRunTokens` (input) only ran on the happy path while `setMainOutputTokens` (output) fired on every reply incl. swipes. Token recording now runs even on the cancelled/early-return path (wrapped in try/catch via `recordRunTokens`), and output is gated on a per-cycle `runRecordedInput` flag. `setRunTokens`/`setMainOutputTokens` are hardened against NaN and skip empty runs. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))

**Memory quality**
- **Source attribution off-by-one.** Facts were stamped with the AI message index even when disclosed in the user turn. Added an optional `@src:user|char` tag to the Agent 3 grammar; user-sourced facts now attribute to the user message index, char/untagged to the AI target. Live and backfill/icon paths now index identically (backward-compatible when the tag is absent). ([src/agent-memory.js](src/agent-memory.js), [src/pipeline.js](src/pipeline.js))
- **Missed / contradictory facts.** (a) Agent 3 context window default raised 2 → 5 so long single-message backstory reveals fit. (b) Memory prompt's omission bias relaxed — higher cap on dense turns, short clauses allowed for genuine backstory, "skip when uncertain" softened to capture clearly-stated reveals. (c) `upsertFact` now reconciles on write: on exact-key miss it conservatively matches a normalized-key variant and updates in place instead of minting a parallel contradictory key. ([src/settings.js](src/settings.js), [src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **Silent fact eviction.** `MAX_FACTS_PER_DB` (50) eviction was dropping facts with only a `console.warn`, so late-session facts vanished from exports with no trace. Eviction now logs to the debug panel (count + category + keys). Cap value unchanged — raising it is a deliberate token-cost decision. ([src/database.js](src/database.js))

**UI / reporting**
- **"Last Generated" == "Last Inserted".** Both panels were fed the same proposed array. `applyUpdates` now classifies each write NEW/UPDATED/SKIPPED and returns the committed subset (`.applied`); Last Generated keeps the full proposed set, Last Inserted shows only what actually changed. ([src/agent-memory.js](src/agent-memory.js), [src/pipeline.js](src/pipeline.js))
- **Backfill didn't populate "Last Generated."** `runAgent3OnFullChat` now accumulates per-message results and calls `setLastGenerated`/`setLastInserted` at the end. ([src/settings.js](src/settings.js))
- **Debug log didn't survive reload.** `chat_metadata.bf_mem_log` was saved via the debounced `saveMetadata`, so rapid entries superseded each other and only ~2 reached disk. Added a guaranteed synchronous flush on `beforeunload` (`flushDebugLogNow`) plus a throttled immediate chat save (≤ once / 5s). ([src/settings.js](src/settings.js))
- **Incomplete debug log.** Added a consolidated per-run SUMMARY entry (runId, duration, Agent 1 ok/failed, Agent 3 NEW/UPDATED/SKIPPED, full token breakdown). Enable/disable state changes are now logged (incl. the corrupt-settings reset and validation coercion that could silently flip `enabled` off). `MAX_DEBUG_ENTRIES` raised 200 → 500. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))

**Cost**
- **Full-chat backfill API cost.** Confirmed `skipAlreadyProcessed` defaults ON and short-circuits *before* the LLM call; added a trivially-empty-message pre-filter (empty/whitespace, < 15 visible chars, pure-OOC) so no call is spent on zero-fact messages; the confirm dialog now shows an estimate of how many LLM calls the run will make. (True multi-message batching deferred — it would change the Agent 3 output contract.) ([src/settings.js](src/settings.js))

## [0.10.0] - 2026-05-17

### Changed — settings reorganized into per-agent tabs
The old type-grouped tabs ("Pipeline" + "Prompts") split a single agent's settings across multiple places. Now each agent has ONE tab with everything for it:

- **Agent 1** tab: its connection profile · its context-messages slider · its draft-planner prompt (+ reset)
- **Agent 2** tab: a note that it's the main model (no separate profile) · its context-limit/trim slider · fact-retrieval %s (they feed the writer's injection) · the Writer Injection Format template (+ reset)
- **Agent 3** tab: its connection profile · its context-messages slider · review-interval slider · its memory-updater prompt (+ reset)
- **General** tab: "use separate profiles" master toggle · show-toast toggle
- Data tabs unchanged: Database · Last Generated · Last Inserted · Tokens · Debug
- Enable toggle stays in the always-visible status bar

Every element id was preserved, so all existing handlers/persistence keep working — purely a layout move. The generic `setupTabs()` auto-wires the new tabs.

### Removed
- Dead `#bf_mem_profile_section` toggle calls in settings.js (the wrapper no longer exists; the `useMemoryProfile` flag still gates whether agents use their profiles, via `getAgent1ProfileId` / `getAgent3ProfileId`).

## [0.9.0] - 2026-05-17

### Added — token comparison
- **New "Tokens" tab** showing a side-by-side comparison of token cost, split INPUT vs OUTPUT:
  - **Baseline** — what the full chat would have cost the main model (no extension)
  - **With extension** — main model (trimmed chat + facts) + Agent 1 (Draft) + Agent 3 (Memory), each broken out
  - **NET vs baseline** — input saved (green) or spent (red), output overhead from agents (amber)
  - **Last Run** + **This Session** (running totals) views, with a session-reset button
- **Honesty banner:** if Agent 2 trim is OFF (actual main input ≈ baseline within 3%), the panel says plainly that there are no input savings and the agent calls are pure overhead — pointing you to the Agent 2 Context Limit slider. The NET-input figure turns red (not green) when the extension costs more than it saves, so it can't be misread as a win.

### How tokens are measured
- Uses ST's local tokenizer (`getTokenCountAsync` / `countTokensOpenAIAsync`). Provider usage isn't exposed to extensions, so counts are **approximate** (exact for OpenAI/Llama, estimated for Claude). The DELTA is what matters and both sides use the same tokenizer, so the comparison is meaningful. UI labels it "approx."
- Captured in [src/pipeline.js](src/pipeline.js): baseline counted before trim, actual counted after trim+inject. Agent counts threaded out via new `tokensIn`/`tokensOut` fields on the Draft/Memory result objects. Main reply counted on `MESSAGE_RECEIVED`.
- Persisted in `chat_metadata.bf_mem_tokens` (`{lastRun, session}`) — survives reload, per-chat scoped, auto-reloads on chat change.

### Internal
- [src/agent-draft.js](src/agent-draft.js) + [src/agent-memory.js](src/agent-memory.js): return `tokensIn`/`tokensOut` (0 on error path)
- [src/settings.js](src/settings.js): `setRunTokens()`, `setMainOutputTokens()`, `reloadTokensFromChat()`, `renderTokens()`, session-reset handler
- [src/pipeline.js](src/pipeline.js): `countChatTokens()` helper, baseline/actual capture around injection, MESSAGE_RECEIVED main-output capture
- New tab auto-wired by the generic `setupTabs()` (no hardcoded tab list)

## [0.8.0] - 2026-05-17

### Added — backfill + per-message tracking
- **"Run Agent 3 on full chat" button** in the Database tab. For when you installed the extension after a chat was already going — extracts facts from every existing message sequentially.
  - Skip-already-processed checkbox (default on) so re-running only hits new messages
  - Live progress: "Message X/N · Y facts added"
  - Cancel button to abort mid-run
  - Per-message LLM token cost — warning confirm before starting
- **Per-message brain icon** next to each message's edit button (inspired by MemoryBooks extension).
  - 🧠 **Grey** = Agent 3 has NOT processed this message yet
  - 🧠 **Green** = already processed
  - 🧠 **Blue (pulsing)** = currently running
  - **Click** = force Agent 3 to extract from this specific message (useful if you edited a message and want to re-extract, or if a specific message has facts the normal pipeline missed)
  - **Editing a message** automatically resets its flag to grey (prior extraction invalidated)

### Shared state convention
- New per-message flag `message.extra.bf_mem_processed = true` (persisted natively by ST in chat .jsonl)
- Set automatically:
  - In the normal pipeline after Agent 3 happy path (both AI target and the user message Agent 3 also saw)
  - By the full-chat backfill worker
  - By the per-message icon click handler
- Cleared automatically:
  - When a message is edited (the existing extraction is invalidated)
- Hidden from system/comment/narrator messages — only real chat messages get the icon

### Internal
- New module: [src/message-icon.js](src/message-icon.js) — self-contained, listens to `CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED` / `MESSAGE_UPDATED` / `CHAT_CHANGED`, idempotent re-inject
- New export: `runAgent3OnFullChat({skipAlreadyProcessed, onProgress, shouldCancel})` in [src/settings.js](src/settings.js)
- [src/pipeline.js](src/pipeline.js) now stamps `extra.bf_mem_processed = true` on both the AI target message and the user message after each successful Agent 3 run
- [index.js](index.js) wires `initMessageIcons()` alongside `initSettings()` and `initPipeline()`
- [style.css](style.css) — grey → green → blue (pulse) state transitions for the icon

## [0.7.3] - 2026-05-17

### Docs
- **Added [README.md](README.md)** with a full walkthrough of how the 3 agents work — uses a fake 10-message chat (<NAME> + <CHAR>) and shows exactly what each agent sees, what it outputs, and where the Agent 2 trim kicks in. Includes:
  - Step-by-step trace of one generation cycle
  - Agent reference table (LLM call? what it sees? output?)
  - Full settings reference
  - Tradeoff table for tuning sliders
  - Starter config for "facts replace history" mode

No code changes — docs only. Manifest version bumped so the in-UI version label confirms the new docs are pulled.

## [0.7.2] - 2026-05-17

### Changed — Agent 2 slider now actually does what was wanted
v0.7.1's "Agent 2 Context Messages" slider was implemented in the WRONG direction — it duplicated the last N messages INTO the injection (force-attention), which was mostly wasteful since the main model already sees full chat history via ST.

The user wanted the OPPOSITE: **hide old messages from the main model** so it focuses only on the recent exchange + the facts we inject. This makes the facts actually *replace* the hidden chat history (the intended architecture for a memory pipeline).

- **Label changed:** "Agent 2 Context Limit (trim chat)"
- **Range:** 0–50 (was 0–20)
- **Behavior when > 0:** before injection, the chat history sent to the main model gets trimmed in-place to the last N user/AI messages. System prefix (character card, system prompt) preserved. Reversible — change slider back to 0 to restore full history.
- **Tradeoff:** cleaner focus, lower token cost — but the stored facts have to be good enough to replace the hidden history. If your facts are sparse, the model will feel amnesiac.

### Removed
- `{context}` placeholder support in Writer Format (added speculatively in v0.7.1, no longer needed since we don't duplicate chat into the injection).
- `contextBlock` parameter in `buildWriterInjection()`.

### Internal
- New `trimChatHistory(messages, keepLast)` helper in [src/agent-writer.js](src/agent-writer.js) — preserves system prefix, splices oldest user/AI messages.
- [src/agent-writer.js](src/agent-writer.js) `injectMemoryContext()` now accepts `options.trimToLast`.
- [src/pipeline.js](src/pipeline.js) reads `settings.agent2ContextMessages`, passes as `{trimToLast: N}` to `injectMemoryContext()`.

## [0.7.1] - 2026-05-17

### Added
- **Agent 2 (Writer) context-messages slider** for symmetry with Agent 1 / Agent 3 controls. Default 0 = off (current behavior).
  - **What it does when > 0:** duplicates the last N chat messages into the injection block (as `[USER]` / `[CHAR]` tagged lines).
  - **Why it's usually unnecessary:** the main model (Agent 2) already sees full chat history via ST's normal prompt assembly. This setting is for FORCING the model's attention onto recent exchanges when the chat is long.
  - Costs extra tokens (duplicates messages already in the prompt).
- New `{context}` placeholder support in the Writer Format template. If your custom template includes `{context}`, the chat block is substituted there. Otherwise it's auto-prepended.

### Internal
- [src/agent-writer.js](src/agent-writer.js) `buildWriterInjection()` gained an optional `contextBlock` parameter (3rd arg, default `''`). Backward-compatible: existing callers without the arg behave exactly as before.
- [src/pipeline.js](src/pipeline.js) gathers up to `agent2ContextMessages` last messages from chat and passes as the new param.

## [0.7.0] - 2026-05-17

### Added — per-agent configuration
- **Separate connection profile per agent.** Agent 1 (Draft) and Agent 3 (Memory Updater) can now run on DIFFERENT connection profiles instead of sharing one. Use cases:
  - A cheap fast model for Agent 3 extraction (Deepseek), a stronger reasoning model for Agent 1 drafting (Sonnet).
  - Each agent tunable independently for cost/quality trade-offs.
  - Writer (Agent 2) still always uses your default/active profile.
  - Leave either dropdown blank → uses default profile for that agent.
- **Separate context-message count per agent.** Agent 1 and Agent 3 can each have their own window:
  - **Agent 1 (Draft):** slider 1–50, default 5 (how many recent messages to plan the reply from)
  - **Agent 3 (Memory):** slider 1–20, default 2 (default 2 = current behavior: just the latest user msg + AI msg. Higher = more context for better extraction at higher token cost.)

### Migration
- Existing `memoryProfile` (single shared profile) → copied to BOTH `agent1Profile` AND `agent3Profile` on first load. Old key preserved for rollback safety.
- Existing `contextMessages` (single shared count) → copied to `agent1ContextMessages` if the user had changed it from default. Old key preserved.
- Schema version unchanged — additive migration only.

### Internal
- New exports in [src/profiler.js](src/profiler.js): `getAgent1ProfileId()`, `getAgent3ProfileId()`. Old `getMemoryProfileId()` kept as alias returning the Agent 1 profile.
- [src/agent-memory.js](src/agent-memory.js) `runMemoryUpdater()` last param renamed `prevUserMessage → priorMessages` (now an array of `{role, text}` for richer Agent 3 context). Backward-compatible: default empty array = no extra context, same as before.
- [src/pipeline.js](src/pipeline.js) now gathers up to `agent3ContextMessages` prior messages from chat (excluding the target itself), tags them USER/CHAR, passes as array.

## [0.6.0] - 2026-05-17

### Fixed (HIGH — mobile UX)
- **Review popup no longer hides above the screen on mobile.** Root cause: the overlay flex-centered vertically against `100%` of the layout viewport (full screen height, unchanged when Android soft keyboard opens). The 80vh popup was pushed off-screen with no scroll recovery.
- New behavior:
  - Overlay anchors to TOP (`align-items: flex-start`) on mobile, with `padding: env(safe-area-inset-top)`. Vertical centering restored ONLY on desktop via `@media (hover: hover) and (min-height: 700px)`.
  - JS-set `--bf-mem-vv-h` CSS var tracks `window.visualViewport.height` so the popup never grows taller than the keyboard-free area. Listens to `visualViewport` resize/scroll + `orientationchange`.
  - Popup max-height now `var(--bf-mem-vv-h, min(80dvh, 80vh))` — uses dynamic viewport units that shrink with iOS keyboards as fallback.
  - On open: first editable field gets `.focus()` + `scrollIntoView({block:'center'})` so mobile users see it immediately.
  - Backdrop click now dismisses the popup (previously only Accept/Save/Dismiss buttons could close it — useless if they scrolled off-screen on a tall popup).
  - Centralized `cleanup()` removes all listeners on every dismiss path (no leak).

### Changed (UI restructure)
- **Replaced the "Summary" tab with TWO new tabs: "Last Generated" and "Last Inserted".**
  - **Last Generated** shows every fact Agent 3 PROPOSED in the most recent pipeline run (raw output, before any guard).
  - **Last Inserted** shows the subset that ACTUALLY landed in the database, with status badge: `NEW` / `UPDATED` / `SKIPPED` (skipped = pipeline cancelled or char switched mid-run).
  - Both tabs persist in `chat_metadata` (per-chat) so they survive page reload — same pattern as the debug log + review counter.
  - Auto-refresh on `CHAT_CHANGED` so each chat shows its own facts (not stale cross-chat data).
  - Review popup edits append to the "Last Inserted" view in real time.
- Deleted: `lastPipelineSummary`, `updatePipelineSummary()`, `renderSummary()`, `formatInline()` (all summary-tab plumbing).
- Added: `setLastGenerated()`, `setLastInserted()`, `appendLastInserted()`, `reloadFactsFromChat()`, `renderFactList()` (exports + helpers in settings.js).
- Added: `update.wasNew = isNew` in `agent-memory.js applyUpdates()` so pipeline.js can surface NEW vs UPDATED badges per fact.

### Internal
- Designed by 2 parallel research agents (mobile-popup-fix + tab-redesign-spec). Applied by 2 sequential patch agents (popup + tabs).

## [0.5.1] - 2026-05-17

### Changed (HIGH impact — Agent 3 extraction quality)
- **DEFAULT_MEMORY_PROMPT rewritten for atomic facts.** The previous prompt produced prose values like `"<character> owns <item>, stored in <container>, knows <ability>"` — a single bloated fact mashing 3 properties together. A real transcript test showed only 8 facts stored from a rich 14-message scene when ~25–30 atomic facts should have been captured.
- The new prompt locks the model into **1–5 word values, one property per fact**. Adds a STRICT format block, a WRONG→RIGHT splitting demo, a DO NOT STORE list (negative facts, transient emotions, atmosphere, generic biology, items-momentarily-in-hand), and 6 generic placeholder-based few-shot examples (no real names/locations to bias extraction).
- Expected outcome: ~3× more retrievable facts per scene at roughly the SAME token cost (atomic values are shorter than prose).

### Added
- **Persistent debug logs.** The debug log is now stored in `chat_metadata.bf_mem_log` (same pattern as the review counter). Logs survive page reload. On chat-change → log view reloads from the new chat's metadata. Cap remains 200 entries per chat. "Clear Log" button clears the persistent copy too.
  - New helpers: `loadDebugLogFromMeta()`, `saveDebugLogToMeta()`, `reloadDebugLogFromChat()` (exported)
  - Shape-checked on load — malformed entries silently dropped
  - `addDebugLog()` writes to chat_metadata on every entry

### Internal
- Synthesized from 3 parallel research agents: atomic-format-rules / few-shot-examples-designer / anti-patterns-and-negative-examples.

## [0.5.0] - 2026-05-17

### Fixed (10 issues surfaced by persona-based research — Test Suite v3.3)

#### Pipeline / state (HIGH)
- **`/cut` now also resets `lastProcessedMessageIndex`** (not just `lastTriggeredUserMsgIndex` as in v0.4.0). Previously, after a `/cut`, Agent 3 thought it had already processed indices that no longer existed and silently skipped new AI replies. ([src/pipeline.js](src/pipeline.js) MESSAGE_DELETED handler.)
- **Pipeline now skips quiet/impersonate/continue generations.** Quick Reply scripts that call `/gen`, the Impersonate button, and `/continue` previously burned billable Agent 1 + Agent 3 LLM calls per invocation. Added filters for `data.quiet`, `data.type === 'quiet'`, `'impersonate'`, `'continue'`. ([src/pipeline.js](src/pipeline.js) `shouldRunPipeline`.)
- **Character card truncation bumped from 500/300/300 → 2000/1000/1000 chars** (description / personality / scenario). Serious roleplay cards have critical lore in the back half. Prior limits caused Agent 1 to plan replies that contradicted established lore. ([src/pipeline.js](src/pipeline.js) `getCharacterInfo`.)

#### Network resilience (HIGH)
- **LLM_TIMEOUT_MS bumped from 30s → 60s** for mobile network tolerance. Mobile users on 4G/5G or edge-of-WiFi routinely hit cold-OpenRouter routes that take 20–40s. ([src/llm-call.js](src/llm-call.js))
- **`callAgentLLM` now retries on network errors**, not just empty responses. Mobile users hit `ERR_NETWORK_CHANGED` mid-call on WiFi↔cellular switches. Each attempt wrapped in try/catch; both empty and thrown errors trigger one retry. ([src/llm-call.js](src/llm-call.js))

#### Agent 3 prompt quality (HIGH)
- **Transient asterisk actions no longer extracted as facts.** `*she smiled*`, `*nods*`, `*brushes hair*` etc. are now explicitly negative-listed in the Agent 3 prompt for BOTH `{{user}}` AND `{{char}}`. Only lasting reveals like `*revealing a scar from childhood*` get extracted.
- **OOC brackets `[OOC: ...]` no longer extracted.** `[OOC: my real name is X]` is meta-commentary, not in-character disclosure. Three new few-shot examples added to demonstrate.
- **Quoted historical text not re-extracted.** When user types `Remember when you said "X"?`, the quoted X isn't extracted as a fresh disclosure.

#### Mobile UX (MED→HIGH)
- **5-tab strip now wraps + scrolls horizontally on narrow viewports** (360px phones with accessibility zoom). Added `flex-wrap: wrap` + `overflow-x: auto` + 36px min touch target to `.bf-mem-tab`. ([style.css](style.css))
- **Pull-to-refresh disabled inside drawer scroll containers.** Mobile users could accidentally reload the page when scrolling up inside the DB list / debug log / review popup at the top of their scroll range, losing unsaved edits. `overscroll-behavior: contain` applied to all known scroll containers. ([style.css](style.css))
- **Copy Log fallback now uses a textarea overlay** instead of `prompt()`. The native `prompt()` truncates long text and lacks select-all on mobile. New overlay has Select All / Close buttons and is long-press friendly. ([src/settings.js](src/settings.js))

### Test Suite v3.3 (139 checks, tiered)
Bumped from v3.2 (94 checks) after deep research by 3 persona agents: Heavy Roleplayer (15 UX gaps), ST Power User (14 integration gaps), Mobile-Termux User (15 mobile gaps). Total 44 new test cases distributed across Tier 1 (smoke +10 = 23), Tier 2 (integration +22 = 58), Tier 3 (behavioral +12 = 57).

### Known limitations / future work
- No native mobile-themed dialog for `prompt()`/`confirm()` (DB profile save, delete, etc.). Native Chrome dialogs work but look out-of-place.
- Author's Note / Vector Storage / built-in Summarize co-injection still order-dependent at depth=1. Future: expose `injectionDepth` setting + use `setExtensionPrompt`.
- Plot-twist updates still create duplicate keys instead of overwriting (e.g., `char_species = human` + new `char_vampire_reveal`). Future: prompt-side instruction to prefer overwrites.
- The 5-message context window for Agent 1 is too short for long-arc narrative awareness. Future: per-character override.

## [0.4.1] - 2026-05-17

### Fixed (caught by Tier 1 v3.2)
- **`getMeta()` now shape-checks `chatMetadata.bf_mem_review` before use**: previously the guard was `if (!md[META_KEY])`, which treats a corrupted string value as truthy and skips reinitialization. The subsequent `.push()` on a non-array would throw `TypeError: Cannot read properties of undefined (reading 'push')`. Now validates: object, not array, with `pendingReviewItems: Array` and `messagesSinceLastReview: number`. Otherwise reinitializes to the empty shape.

## [0.4.0] - 2026-05-17

### Fixed (8 critical issues surfaced by Test Suite v3.2 research)

#### HIGH — write integrity / no-data-loss
- **Stop button now actually stops Agent 3 writes**: previously, when the user clicked Stop, in-flight Agent 1/Agent 3 CMRS calls finished and wrote to the DB anyway. Now a `pipelineCancelled` flag is set on `GENERATION_STOPPED`; checked before Agent 3's `trackUpdate`/`saveCurrentToActiveProfile` and before the injection step. CMRS calls themselves can't be aborted (no AbortSignal exposed by ST), but their results are discarded.
- **Character-switch mid-pipeline no longer contaminates the new character**: the v0.3.0 capture-at-write fix protected the profile-snapshot layer; v0.4.0 adds the deeper-layer guard. `capturedCharAvatar` is captured at pipeline start; if the live avatar differs when Agent 3 returns, the writes are discarded with a toast warning.
- **`/cut` no longer breaks the pipeline**: previously, deleting a message left `lastTriggeredUserMsgIndex` stale, so the next genuine user message (re-using the deleted index) got silently skipped by the "already triggered" guard. Added a `MESSAGE_DELETED` listener that recomputes the index.
- **Group chats now skip the pipeline cleanly**: previously, the pipeline ran with `characterId` = active speaker (not addressee), causing fact cross-contamination between group members. Now detects `ctx.groupId || ctx.selected_group` and short-circuits with a show-once toast: "BF Memory: group chats not supported — memory pipeline disabled for this chat."
- **`is_system` / extension-injected messages excluded from Agent 3**: previously, the memoryTargetIndex walkback grabbed any non-user message, including synthetic system messages injected by other extensions (Auto-Summarize, Tracker, etc.), polluting our DB with second-order data. Now skips `msg.is_system` and `msg.extra?.type`.
- **MAX_FACTS_PER_DB now uses LRU eviction** instead of FIFO: when a database exceeds 50 facts, the **least-recently-updated** facts are evicted (not the oldest-by-insertion-order). Foundational identity facts that get reinforced by `upsertFact` survive; throwaway tertiary facts get pruned. Prevents losing `user_name` after long campaigns.

#### MED→HIGH — UX correctness
- **Review popup no longer fires for the wrong chat**: previously, the `setTimeout(..., 2000)` for the deferred popup could fire after the user switched chats, popping in chat B while the user was in chat C. Now captures `chatId` at schedule time and aborts the popup if it changed.
- **First message after chat-open is no longer silently dropped**: the 5-second cooldown previously blocked ALL pipeline runs in that window, including legitimate first sends. Now the cooldown only blocks when there's NO new user message (spurious chat-load events); genuine new user messages always fire.

### Test Suite v3.2 (94 checks, tiered)
Bumped from v3.1 (58 checks) after deep research by 3 agents (Detailed code analysis + Contrarian breakage modes + Edge case enumeration). New coverage includes group chat behavior, Stop-button cancellation, /cut handling, char-switch races, MAX_FACTS eviction, /sendas filtering, /preset switching, parser injection, knownBy filter, internationalization, cache invalidation, profile-delete races, etc.

### Internal
- New module-scope flags: `pipelineCancelled`, `groupSkipToastShown` (resets on CHAT_CHANGED).
- New listener: `MESSAGE_DELETED`.
- Nesting depth in Agent 3 result handler is now 5 levels deep — readable but a future refactor candidate.

### Known limitations
- Cancellation flag is module-scope; theoretical race if two pipelines could overlap. In practice prevented by `isInternalCall` and index guards.
- Group chat support is a future enhancement (v0.5+). Today the pipeline skips groups with a toast.
- Facts without a `lastUpdated` field (legacy pre-v0.2.0 data) get sorted as `lastUpdated=0` by the LRU comparator and are evicted first.

## [0.3.2] - 2026-05-17

### Fixed (HIGH — caught by Tier 1 smoke test)
- **Pipeline no longer aborts when Agent 1 (Draft) returns empty**: previously, if Deepseek returned an empty completion for the draft agent, `pipeline.js` did an early `return` and the writer never injected facts into the prompt. The user got a plain AI response with no memory context. Now: Agent 1 failure logs a warning but the pipeline continues with `draft = ''`, so the retrieved facts still reach the writer (memory > nothing). The user-facing impact: even when the draft LLM hiccups, your character still sees the established facts.
- **One-shot retry on empty LLM completion in `callAgentLLM`**: providers (especially Deepseek) intermittently return empty bodies. We now retry once before giving up. Empty responses from Agent 1 / Agent 3 should be substantially rarer.

## [0.3.1] - 2026-05-17

### Added
- **Version label in extension header**: the drawer title "BF's Memory Pipeline" now displays the installed version (`v0.3.1`) next to the name, fetched live from `manifest.json` (single source of truth). Lets testers/users instantly verify which version is loaded — critical for catching stale browser caches where a patched file on disk hasn't replaced the in-memory copy.

## [0.3.0] - 2026-05-17

### Fixed (HIGH — behavior bugs surfaced by test suite v2)
- **Cross-profile data leak on character switch**: `autoSaveDbProfile()` previously snapshotted in-memory databases into the active profile slot on `CHAT_CHANGED`. By flush time, ST had already advanced state, so e.g. one character's facts could end up in another character's profile. Fix: removed the unsafe save-on-switch entirely; persistence now happens via capture-at-write in `saveCurrentToActiveProfile(profileKey)`, with the profile key captured at pipeline start (`src/pipeline.js`). Also added an integrity guard that refuses writes to deleted profiles and surfaces a toast. Removed a second residual `MESSAGE_RECEIVED → saveCurrentToActiveProfile()` handler that had the same leak class.
- **Agent 3 ignored USER facts**: messages like "I am <NAME>, I work at <ORG> in <CITY>" produced 0 stored facts because Agent 3 ran only on the N-1 AI message. Fix: Agent 3 now also sees the latest user message in the same call (combined `[USER:...] ... [CHAR:...]` block). The prompt has been rewritten to anchor on `{{user}}` / `{{char}}` macros (resolved via ST's `substituteParams`), with a CRITICAL clause for first-person disclosures and a new few-shot example for user-fact extraction. User persona description is also injected.

### Added (MED)
- **Relationships schema is no longer dead**: extended the Agent 3 output format with an optional `| rel:key1,key2` segment. The parser writes these into `fact.relationships.primary`, which the existing retrieval logic uses to expand fallback keywords. `upsertFact()` now MERGES (unions) relationships instead of replacing them, so prior tier links survive subsequent updates.
- **Review counter persists across page reload**: `messagesSinceLastReview` and `pendingReviewItems` now live in `chat_metadata.bf_mem_review` instead of module-scope JS, with an in-memory fallback that drains into chat metadata once a chat is opened. Counters are per-chat (correct behavior — reviewing facts about chat A shouldn't reset when you switch to chat B).
- **`knownBy` filtering enforced at code level**: `retrieveFacts()` now filters facts by current `{{char}}` / `{{user}}` name before formatting them into the injection. A fact tagged `knownBy: [<NAME>]` is no longer included when you chat with a different character.
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
