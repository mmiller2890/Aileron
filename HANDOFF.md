# HANDOFF — Code-review fix passes for the Assistant (Aileron) fork

Handoff written after the session hit its limit, then updated by the continuation
session. The next agent should start at **Task 14** under "REMAINING tasks". Everything
listed under "Work completed" is committed and verified.

## Project

- Local-only fork of Pluely: Tauri 2 (Rust) + React 19 + TS 5.8 desktop app, stealth AI
  assistant overlay for meetings/interviews. Product name is **Aileron** (AGENTS.md updated).
- Path: `/Users/ghost/interview_copilot_new/better/assistant-dev`, git branch `dev`.
- Conventions (AGENTS.md): no comments in code unless requested; run `npx tsc --noEmit` and
  `npm run build` after changes; never commit secrets; follow existing style.
- The `code-review-graph` MCP tools mentioned in AGENTS.md were not connected in the
  first session. They ARE connected in the continuation session, but the graph was built
  at commit `1dad916` (many commits stale), so it still can't be trusted for this work —
  use Grep/Read, or rebuild the graph first.
- Vendored dirs to never touch/review: `Aileron/`, `FluidAudio/`, venvs, `node_modules/`.

## Verification baseline (must stay green)

- `npx tsc --noEmit` — clean
- `npm test` — 35 files / 268 tests (vitest)
- `cargo check --manifest-path src-tauri/Cargo.toml` — clean
- `cargo test --manifest-path src-tauri/Cargo.toml` — 75 tests
- `npm run build` — succeeds (~16s)
- pi-lens dispatch checks: empty `catch {}` and un-wrapped `JSON.parse` get flagged as
  blockers; formatter autofixes (prettier/rustfmt/markdownlint) get applied to edited files —
  commit those as a separate `chore:` commit when they appear. If an edit reports
  "RE-READ REQUIRED", re-read the file and rebuild oldText verbatim.

## Work completed (all committed on `dev`, working tree clean)

Pass 1 (review of full codebase + fixes for all verified "major" findings):

1. `b975928` — Template bugs: `$&`/`` $` ``/`$'` string-replacement corruption in
   `processUserMessageTemplate` (fixed with replacement function + regression test in
   `src/lib/functions/process-user-message-template.test.ts`); Mistral `image_url` now
   `{"url": ...}` object form in `src/config/ai-providers.constants.ts:61`; descriptive
   errors around template `JSON.parse` calls; deleted dead `setByPath` from
   `src/lib/functions/common.function.ts`.
2. `f3f68a7` — Persistence: `useSystemAudio` debounced DB save re-arms while a save is
   in flight and flushes the pending snapshot on unmount (refs
   `pendingSaveConversationRef`/`inFlightSaveRef`, serialize flush behind in-flight save —
   `updateConversation` is a non-transactional DELETE+re-INSERT, so concurrent saves of the
   same id must never interleave); `useChatCompletion` error branch now restores
   `setMessages(updatedMessages)` so a partially-streamed assistant message is not persisted
   as complete by the next submit.
3. `3b233e9` — Rust audio/STT: windows/linux `SpeakerInput::stream()` now return
   `Result<SpeakerStream>` (this also fixed a latent compile break — `mod.rs` already
   applied `?` to all three platforms); removed `.expect("No default render device")`;
   `stt get_status` uses `try_lock` + `last_status` snapshot cache on `SttState`
   (`init_asr_inner` holds the inner mutex across the whole model download); recording
   buffer prealloc capped at 10 s (was up to ~1.4 GB from user VAD config); screenshot
   overlay windows built with `.focused(false)` (primary still explicitly focused after
   show); `update_shortcuts` falls each failed action back to its previous binding.
4. `5f1dc42` — Fallback + capabilities: unsupported-platform STT fallback now targets
   `local-whisper` with `variables: { MODEL: "openai/whisper-large-v3-turbo" }` instead of
   clobbering the saved provider with cloud `groq` + empty variables
   (`src/contexts/app.context.tsx`, two sites ~line 592/600); inert updater plugin fully
   removed (Cargo dep, lib.rs registration, tauri.conf.json plugins.updater section, npm
   package, `updater:default` permission); `shell:default` JS ACL removed from both
   `src-tauri/capabilities/*.json` (Rust-side `app.shell()` usage in
   `speaker/commands.rs` still requires the plugin + registration — keep those); AGENTS.md
   product name fixed to Aileron.
5. `5d5574f` — chore: formatter autofixes.

Pass 2 (in flight):

1. `bc71b44` — Rust: `macos.rs` tap `uid()` errors propagated via `?` (it returns Result,
   not Option) + `poll_next` post-registration re-check of the ring buffer (mirrors
   windows.rs; closes missed-wakeup when producer pushed between first pop and waker
   registration — producer skips wake when `has_data` is stale-true); `lib.rs init()` uses
   let-else instead of unwrapping `get_webview_window("main")`/`to_panel()` (also removed
   the now-unused `WebviewWindow` import at lib.rs:8); `set_window_height` clamps to the
   current monitor's logical height; capture error paths (missing monitor, zero-dim
   selection, overlay build failure) now call new helper `destroy_overlay_windows(&app)` +
   reset `overlay_active`; `stt_transcribe_speech` caps input at 16_000×60×10 samples;
   removed dead IPC commands `window::move_window` and `speaker::get_audio_sample_rate`
   (zero callers anywhere — shortcut movement goes through
   `shortcuts.rs::handle_move_window` with hardcoded step=12); `tauri-nspanel` pinned to
   rev `18ffb9a201fbf6fedfaa382fd4b92315ea30ab1a` (the rev the lockfile already resolved);
   `whisper_server.py` transcribe endpoint is now a sync `def` (FastAPI threadpool) using
   `file.file.read(...)`, dead `model_name` Form param dropped, `Form` import removed,
   model lazy-load narrowed through local `active_model` (analyzer demanded it).

## Work completed — continuation session

6. `b07175e` — chore: finish the rustfmt pass the previous session left half-applied
   (`build.rs` trailing newline, `shortcuts.rs` over-wrapped statements).
7. `e075f0b` — chore: prettier autofixes for `src/lib/database/` (trailing commas only),
   split out so the fix below stays reviewable.
8. `24157ff` — **Task 13 "database integrity" — DONE.** All three findings were verified in
   source first, all three held. `getDatabase` now caches the in-flight `Database.load`
   promise (clears it on failure so a retry is still possible); `updateConversation` runs
   BEGIN/COMMIT with ROLLBACK on error, replacing the manual backup/restore loop whose
   `.catch(() => {})` could silently drop every message; the migration outer catch no
   longer sets `chat_history_migrated_to_sqlite`, so a transient DB failure stays
   retryable (the terminal cases — no data, unparseable payload, no valid conversations —
   still set it). Added `src/lib/database/chat-history-update.test.ts` (3 tests) plus 2
   migration tests; all 5 were confirmed to FAIL against the previous implementation.

   Note for later: `src/lib/database/chat-history.map.ts`, `chat-history.map.test.ts` and
   `system-prompt.action.ts` are still prettier-unclean. Pre-existing, left alone — the
   workflow only formats files a task actually edits.

## REMAINING tasks (in order, each = verify finding in source first, fix, then commit)

**Task 14 — lib function correctness** (`src/lib/functions/`):

- `redactProviderError` (common.function.ts ~line 266): only redacts variable values whose
  KEY matches `/(api_?key|token|secret|password|authorization|auth)/i`; a secret named
  `KEY` or `SESSION` can surface in error text. Fix: redact ALL variable values except
  `MODEL`. FIRST check `describe-error.test.ts` and any redact tests — update expectations.
- `extractVariables` regex `/\{\{([A-Z_]+)\}\}/g` misses digits (`{{API_KEY2}}`); change to
  `[A-Z0-9_]+`. Grep tests for existing expectations first.
- `ai-response.function.ts:265` non-streaming path: `const content = getByPath(json,
  provider?.responseContentPath || "") || ""; yield content;` — an empty/missing path
  yields the whole JSON object → rendered/persisted as "[object Object]". Fix: require
  `typeof content === "string"` before yielding; throw a descriptive error otherwise
  (mention the provider id and responseContentPath). Note: still yield empty-string
  content; only non-strings throw.

**Task 15 — hook races and leaks** (NOT yet personally verified — read each first):

- `src/hooks/useSttStatus.ts:151` — `setup()` registers three listeners async; if it
  resolves after unmount, cleanup already ran with undefined unlisteners → permanent leak.
  Fix pattern: disposed flag; unlisten on late resolution. The codebase has a
  `createAsyncListenerScope` helper (used in `src/hooks/useSystemAudio.ts` — find it, it's
  likely in `src/lib/` — and reuse if it fits; it has `scope.add(...)`, `scope.dispose()`,
  `scope.guard(...)`).
- `src/hooks/useWindow.ts:108` — `useWindowFocus` same async-register/sync-cleanup race.
- `src/hooks/useWindow.ts:65` — body-wide MutationObserver invokes `set_window_height` IPC
  on every DOM mutation; debounce or skip the invoke when height is already collapsed.
  (`set_window_height` now clamps in Rust — landed in bc71b44 — but the IPC spam remains.)
- `src/hooks/useMicDictation.ts:75` — `fetchSTT` in the dictation listener has no
  AbortSignal/timeout (system-audio path uses a 30 s AbortController — see
  useSystemAudio.ts ~line 360 for the pattern); a hung provider pins status at
  "transcribing" forever. Add timeout + per-utterance ordering.
- `src/hooks/useSystemAudio.ts:374/570` — concurrent STT completions are ordered by finish
  time, not capture time; a slower earlier utterance is prepended last and timestamped
  `Date.now()`, scrambling transcript order. Fix: order by payload `start_time` or
  serialize STT per session. Careful: the `speech-detected` listener flow is
  `payload.audio` → base64 gate at useSystemAudio.ts:~318 (`if (!base64Audio ||
  base64Audio.length < 100) return;`) BEFORE the provider branch; local macOS path uses
  `payload.utterance_id` + `stt_transcribe_utterance`, remote uses decoded blob +
  `fetchSTT`.
- `src/pages/dashboard/index.tsx:41-49` — unmount before `onFocusChanged` resolves leaves
  `unlisten` undefined at cleanup → leak; fix with the promise.then(f => f()) pattern used
  elsewhere in that file.

**Task 16 — UI defects + dead code** (NOT all verified — read each first):

- `src/pages/chats/index.tsx:54-79` — search filters date GROUPS via `.some(title match)`
  but the inner map renders every conversation in a matching group; non-matching chats
  still show. Fix: filter docs inside the inner map.
- `src/pages/app/components/completion/Input.tsx:176` and
  `src/pages/app/components/completion/MessageHistory.tsx:87` —
  `conversationHistory.sort(...)` mutates hook state in place during render →
  `[...conversationHistory].sort(...)`.
- `src/pages/app/components/speech/QuickActions.tsx:84-99` — `<button>` nested inside
  `<button>`: outer element → `div role="button"` or inner → non-interactive span.
- Icon-only buttons without `aria-label`: `src/layouts/ErrorLayout.tsx:37`,
  `src/components/Header/index.tsx:39`, `src/pages/app/components/speech/index.tsx:290`,
  `QuickActions.tsx:67`, `MessageHistory.tsx:71`.
- Dead code to delete: `src/components/ui/chart.tsx` (zero importers, only
  `dangerouslySetInnerHTML` in scope — check `src/components/index.ts` for a re-export to
  remove too); `src/pages/shortcuts/components/shortcuts/ShortcutRecorder.tsx:26`
  `const isRecording = true` + its dead branches.
- `src/components/Overlay.tsx:170-181` — Cancel fires on mousedown AND click →
  `close_overlay_window` twice; drop the onClick (keep mousedown) — verify which one the
  drag-selection flow needs first. `:147-167` two selection rects share a dead
  `selectionRef` — remove if truly unused.
- `src/pages/dev/components/ai-configs/Providers.tsx:130-146` — no-op "Submit API Key"
  button (onChange already persists) — remove or implement.
- `src/pages/app/components/completion/Audio.tsx:132-138` — nested redundant condition +
  unconfigured trigger toggling `enableVAD` pointlessly — simplify.
- `src/pages/shortcuts/components/shortcuts/ShortcutManager.tsx:170` — `key={i}` on dynamic
  conflict strings → use the conflict text.
- `src/components/Selection/index.tsx:40` — hardcoded "Custom AI Providers" group label
  also used for STT selection (reused by `stt-configs/Providers.tsx`) → accept a
  `customGroupLabel` prop (or similar), update both call sites.
- `src/components/Sidebar.tsx:107` — "Report a bug" is a raw `<a href>` relying on webview
  navigation and points at upstream repo `mmiller2890/Assistant-`; fix: preventDefault +
  `openUrl` (pattern used by footerLinks in the same file) and point at the fork's repo
  (ask user or leave a TODO if unknown — do NOT invent a URL). `:105-113` "Quit Aileron"
  rendered as `<a>` without href → use `<button>`.

**Task 17 — final verification + commits**

- `npx tsc --noEmit`, `npm test` (263), `cargo check`, `cargo test` (75), `npm run build`,
  `lens_diagnostics mode=all` (0 blocking errors expected; pre-existing style warnings —
  console-statements, high-complexity, let-chain candidates, AGENTS.md markdownlint — are
  out of scope).
- Commit per batch with terse `fix:` messages explaining why.

## Deferred / do NOT do (decided in review, with rationale)

- **`speech-detected` audio-field gating** (omit base64 WAV when `utterance_id` present):
  Rust can't know the selected STT provider; `UtteranceStore::take()` is destructive;
  mid-session provider switch would break remote STT. Too invasive for a minor IPC-bytes
  win.
- **`check_system_audio_access` heavy CoreAudio tap**: deliberate TCC permission-flow
  design (constructing the tap is what triggers the macOS prompt).
- **Mic dictation own VAD defaults** (speaker/commands.rs ~1856): behavioral tuning needing
  real-audio testing.
- **CSP tightening** (connect-src https:): BYO-key cloud providers need it; accepted.
- **Keychain-fallback UI warning + inline-secret rejection at save time**: feature work
  needing UX decisions.
- **Cohere domain change**: official Cohere docs use BOTH api.cohere.com and api.cohere.ai
  on different pages — no safe change. (Similarly: a claimed Gemini "stray brace" was
  proven FALSE — template parses cleanly.)
- Complexity/fan-out refactors, console-statement cleanups, Rust let-chain style, markdown
  lint on AGENTS.md: churn, out of scope.

## Reviewer-claims discipline

Two reviewer claims were already proven false (Gemini stray brace; partially Cohere
domain), and one needed correction (tap.uid() returns Result, not Option). VERIFY every
remaining finding in source before fixing; several task-15/16 items above are unverified.

## Review outputs (may be gone after reboot — key findings are embedded above)

Full reviewer outputs were at `/tmp/reviews-full.txt` (4 sections: fe-core, fe-ui, rust,
security). If it still exists it's useful context; do not depend on it.
