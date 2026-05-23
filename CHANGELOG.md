# Changelog

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
- **Added [README.md](README.md)** with a full walkthrough of how the 3 agents work — uses a fake 10-message chat (Tom + Helper) and shows exactly what each agent sees, what it outputs, and where the Agent 2 trim kicks in. Includes:
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
- **DEFAULT_MEMORY_PROMPT rewritten for atomic facts.** The previous prompt produced prose values like `"Rebecca owns a Braixen, stored in a black Pokeball, knows Will-O-Wisp"` — a single bloated fact mashing 3 properties together. Real transcript test showed only 8 facts stored from a rich 14-message Pokémon roleplay scene when ~25–30 atomic facts should have been captured.
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
