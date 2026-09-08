# Seven-Bug Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. The parent owns delegation and review; do not spawn nested agents.

**Goal:** Fix the seven reviewed reliability/privacy defects without changing Aileron's local-first behavior.

**Architecture:** Preserve the React/Tauri split. Make conversation writes atomic in a connection-bound native transaction; invalidate asynchronous completion work when conversations change; associate utterances with message identity; give session audio an explicit bounded lifetime. Keep provider storage interfaces stable.

**Tech Stack:** React 19, TypeScript 5.8, Vitest, Tauri 2, Rust, SQLite through the existing SQL plugin.

**Spec:** The design and acceptance contract below, based on the read-only review of commit `e7e0e3de4d26dc65e32c6d5ce688181f837dbd7a`. User approved all seven bugs; worker transport confirmation and detailed design approval are required before implementation.

## Global Constraints

- Do not re-enable hosted APIs, licensing, telemetry, or auto-updates. Preserve optional user-configured providers.
- All UI copy uses Aileron. Do not add code comments unless requested.
- Do not rewrite unrelated modules, optimize bundles, upgrade unrelated dependencies, or modify vendor code.
- Preserve existing history, attachments, timestamps, titles, and public TypeScript call signatures unless explicitly noted below.
- Treat findings as hypotheses to reproduce before fixing. Recheck current HEAD and AGENTS.md first.
- One writer per working directory. Use an isolated implementation worktree; do not write to the user's `dev` checkout, merge, push, or publish.
- Never test against the user's live SQLite database, keychain, or recordings. Use temporary databases/files and mocked secrets.
- Do not weaken retention limits, expose private recordings, or replace a failed save with a successful-looking result.
- Before each commit run focused tests, `npx tsc --noEmit`, and `npm run build`; Rust changes also require relevant Rust tests and `cargo check --manifest-path src-tauri/Cargo.toml --locked`.
- Dependency or platform/toolchain blockers must be reported, not bypassed by disabling tests or changing models/runners.
- Worker requested by user: GLM 5.3 Flash via `ollama-code`. Registry currently exposes `ollama-cloud/glm-5.3-flash`, not an `ollama-code` route. Parent must confirm route before launch.

## Approved Scope and Design

Seven fixes, in order: history safety; platform compilation; completion cancellation; speaker identity; session recording coverage; recording cleanup; credential precedence. CI and targeted regression tests are part of these fixes. Performance work is deferred.

### History safety

Distinguish missing records from lookup failures. Remove destructive best-effort compensation after unsuccessful inserts. Persist a conversation and its message replacement on one database connection in one native transaction. Preserve create-only and update-only semantics for existing exported functions; the save operation uses atomic upsert semantics. Do not use separate JavaScript `BEGIN`/`COMMIT` calls through a connection pool as a transaction boundary.

### Completion isolation

A conversation generation changes on New Chat and conversation selection. Abort active inference, invalidate request ownership, and prevent queued token flushes or delayed persistence results from changing the newly selected conversation. An already-started save may safely finish against its original conversation ID; it may not restore old UI state.

### Audio correctness and privacy

Use a stable capture/utterance identity to bind accepted transcript messages to their timestamps. Positional matching is not permitted. VAD session audio must not be silently limited by the manual-take duration. Stream session audio to a private temporary WAV with bounded memory, retaining the existing one-hour ceiling as an explicit diarization cutoff rather than increasing retention indefinitely. On cutoff or write failure, continue transcription but disable incomplete speaker labeling for that session and report the limitation through existing status/error presentation. All stop paths finalize or discard the file they own; cleanup for an old session must not delete a new session's file.

### Credential precedence

A pending local fallback is the latest successfully retained value and takes precedence over an older keychain value. Remove that fallback only after a verified keychain write. Reject save when neither backend can retain the new value; do not claim it was saved. Do not log secret values.

## Task 1: Make conversation saves non-destructive and atomic

**Files:**

- Modify `src/lib/database/chat-history.action.ts` and its existing update/migration tests.
- Add `src/lib/database/chat-history-save.test.ts`.
- Add `src-tauri/src/db/conversations.rs`; register it through the existing db module and `src-tauri/src/lib.rs`.
- Modify `src-tauri/Cargo.toml` and lockfile only if an explicit direct dependency on the already-resolved SQLx version is required for transaction types. Reuse the SQL plugin's existing database/pool and initialization, not a second independently migrated database.

**Interfaces:** Preserve `createConversation`, `updateConversation`, and `saveConversation` returning `Promise<ChatConversation>`. New native command accepts a validated conversation and an operation discriminator (`create`, `update`, `upsert`); returns success or an error. Frontend retains the input conversation as the successful return value. Do not accept arbitrary SQL from this new command.

- [ ] Read plugin 2.3.0's local source to establish pool access, migration readiness and the exact connection-bound transaction API before editing.
- [ ] Add a regression with an existing conversation: force lookup failure, attempt save, assert rejection and that no cleanup DELETE runs. Before native upsert replacement this exposes the original lookup-to-delete bug.
- [ ] Add a duplicate create regression: existing conversation/messages survive a rejected create.
- [ ] Run the focused tests and record the expected failure.
- [ ] Implement input validation and native create/update/upsert transaction boundaries. Missing update returns an error; insert/update or any message error rolls back all changes. Database errors are not converted to absence.
- [ ] Add native temporary-SQLite tests: seed old messages; fail an insert after deletion; assert old title/messages remain. Test two concurrent saves through a multi-connection pool; final content must equal one complete save, never a mixture. Test normal create/update/upsert and attachment/timestamp round trips.
- [ ] Replace mocked SQL-order assertions with native-command delegation/error tests; retain real database transaction tests as the isolation proof.
- [ ] Run `npx vitest run src/lib/database`, relevant Rust tests, and compilation gates. Commit only this fix after passing.

**Acceptance:** No save failure deletes previously committed history; all statements of each save share one transaction/connection; concurrent saves cannot interleave message replacement.

## Task 2: Restore platform compilation and enforce it in CI

**Files:** `src-tauri/src/stt.rs`, `src-tauri/src/speaker/commands.rs`, `.github/workflows/ci.yml`.

- [ ] Verify macOS-only `AsrModelVersion` import and unguarded `resolve_transcription_model` and tests; verify unconditional `set_session_wav_path` call.
- [ ] Add consistent `cfg` guards to macOS-only helpers/tests and diarization recording behavior. Preserve Windows/Linux external Whisper transcription rather than returning unsupported for the whole capture path.
- [ ] Add native macOS/Windows/Linux CI jobs with each platform's required system packages. Run `cargo check --locked` and non-hardware unit tests; model-download/accuracy tests remain explicitly separate.
- [ ] Run macOS checks locally. Run Windows/Linux jobs where available; without runner results label those platforms unverified rather than passed. Do not assume `--target` on macOS is equivalent to a native platform build.
- [ ] Verify CI still builds frontend assets before commands requiring `dist`.
- [ ] Commit platform fix and its CI guard separately from audio behavior changes.

**Acceptance:** No unguarded references to absent platform types/methods; all three native compilation jobs are defined. Full acceptance of cross-platform support requires their successful execution.

## Task 3: Isolate completions across conversation changes

**Files:** `src/hooks/useCompletion.ts`; add `src/hooks/useCompletion.test.tsx`; inspect `src/pages/app/components/completion/MessageHistory.tsx` for actual controls.

- [ ] Build hook tests using existing React/jsdom patterns and mocked Tauri/provider/persistence dependencies. No new testing dependency solely for mounting hooks.
- [ ] Use a deferred async generator: emit A, call New Chat, resolve B. Assert the new conversation remains empty and the previous signal is aborted.
- [ ] Repeat for selecting a different conversation. Test delayed save success and delayed save rejection after switching: neither changes ID, messages, loading, or error in the new conversation.
- [ ] Record failures, then centralize invalidation in the New Chat/load handlers. Clear queued token work and guard all post-await UI writes by request plus conversation ownership.
- [ ] Keep user-initiated stop semantics intact; test stopping a request without losing already accepted content.
- [ ] Run focused tests and full frontend gates; commit.

**Acceptance:** No tokens, completion errors, or save callbacks from a prior conversation mutate the active conversation.

## Task 4: Bind speaker labels to transcript identity

**Files:** `src/hooks/useSystemAudio.ts`, `src/hooks/system-audio/useSpeakerLabels.ts`, `src/hooks/system-audio/useSpeakerLabels.test.ts`; add a focused capture-to-message association test beside existing system-audio tests if needed.

**Interface:** Replace positional windows with records `{ messageId: string; start: number; end: number }` scoped to a capture generation. `labelMessagesWithSpeakers` receives these records and labels only matching message IDs in the current conversation. Keep `getSpeakerForUtterance` unchanged.

- [ ] Add two messages in chronological order and two non-overlapping speakers; assert each message gets the correct speaker. The current implementation reverses this mapping.
- [ ] Add failed-STT, dropped-backchannel, out-of-order STT completion, and interleaved typed-message scenarios. Typed/failed/dropped messages must not consume another utterance's timing.
- [ ] Allocate/carry an utterance identity when speech is received; bind timing to the actual accepted message ID, not to its array index or completion order. Retain chunk/deduplication and capture-generation rules.
- [ ] Ignore labeling results belonging to a prior capture/conversation. Do not overwrite messages unrelated to this session.
- [ ] Run focused tests and frontend gates; commit.

**Acceptance:** Speaker labels remain correct regardless of transcript drop, completion order, or typed messages.

## Task 5: Separate diarization coverage from manual recording duration

**Files:** `src-tauri/src/speaker/commands.rs`; add `src-tauri/src/speaker/session_recording.rs` if needed for testable owned-WAV lifecycle; register in existing speaker module. Inspect `src/hooks/system-audio/useVadConfig.ts` and status presentation in `src/hooks/useSystemAudio.ts`.

- [ ] Add a synthetic-sample test with manual duration 180 seconds and VAD audio extending beyond 180 seconds; assert late samples remain available for diarization.
- [ ] Implement incremental owner-only WAV writing for macOS diarization, keeping memory bounded. Finalize the WAV before returning its path. Preserve existing file naming and stale-file cleanup compatibility.
- [ ] Separate VAD retention from manual duration; keep the one-hour ceiling explicit. At the ceiling or a write failure, mark recording incomplete, remove its file, suppress partial diarization, and show a bounded status/error without stopping transcription.
- [ ] Test late-sample inclusion, valid finalized WAV, permissions, disk failure cleanup, and ceiling behavior using synthetic inputs and a short injected sample limit rather than real-time waits.
- [ ] Run Rust tests and frontend/Rust gates; commit.

**Acceptance:** Ordinary sessions beyond three minutes retain speaker evidence; retention/memory remain bounded; incomplete recordings never produce misleading partial labels.

## Task 6: Finalize recordings on every stop path

**Files:** `src/hooks/useSystemAudio.ts`, `src/lib/capture-session-work.ts`, `src/lib/capture-session-work.test.ts`, `src-tauri/src/stt.rs`, `src-tauri/src/speaker/commands.rs`; add caller-level tests beside existing system-audio tests.

- [ ] Enumerate normal stop, VAD/manual switch, restart/reconnect, error recovery and unmount paths. Add a test where mode-change stop returns a WAV path and assert it is discarded.
- [ ] Add unmount cleanup and stale-generation tests. Cleanup for capture A must leave capture B's file untouched.
- [ ] Route stops through common finalization using the existing capture-session decision helper. Explicitly discard paths when no diarization will occur; do not discard a file while active diarization reads it.
- [ ] Make backend shutdown ownership safe during start/stop overlap: hold the stop reservation until join/finalization completes; do not make the task slot appear vacant early. Reuse existing TaskSlot reservation mechanisms.
- [ ] Ensure cleanup failures remain visible/retryable and retain the existing startup stale-file sweep as crash recovery, not normal cleanup.
- [ ] Run helper and caller tests, relevant native lifecycle tests, and compilation gates; commit.

**Acceptance:** Mode changes and unmount do not orphan session WAVs; old stops cannot delete or reset a newer capture; normal diarization still works.

## Task 7: Preserve the newest retained credentials

**Files:** `src/lib/storage/secure-secrets.ts`, `src/lib/storage/secure-secrets.test.ts`; verify callers in `src/contexts/app.context.tsx` propagate save failures.

- [ ] Add this regression to the existing test file:

```ts
it("prefers a pending update over an older keychain value", async () => {
  await saveSecret("api", "old-value");
  keychainMode = "lies";
  await saveSecret("api", "new-value");
  expect(await getSecret("api")).toBe("new-value");
});
```

- [ ] Run `npx vitest run src/lib/storage/secure-secrets.test.ts`; record expected failure.
- [ ] Read the pending fallback before keychain data. Clear it only after a verified successful write. Preserve legitimate empty values by checking null, not truthiness.
- [ ] Test failed write then recovered readable keychain, subsequent successful update clearing fallback, empty values, and both stores failing. Both-store failure must reject `saveSecret`; callers must not broadcast success.
- [ ] Keep fixtures fake; never access real keychain or print secret values.
- [ ] Run focused and full frontend gates; commit.

**Acceptance:** A saved pending update cannot revert to an older keychain value; failure to retain a value is reported.

## Final Validation and Handoff

- [ ] Run `npm test`, `npx tsc --noEmit`, `npm run build`, `cargo check --manifest-path src-tauri/Cargo.toml --locked`, and relevant `cargo test --manifest-path src-tauri/Cargo.toml --lib` tests.
- [ ] Verify native Windows/Linux CI or explicitly list them as pending external validation.
- [ ] Independent reviewer inspects the complete diff for all seven acceptance contracts, data preservation, stale asynchronous callbacks and unintended platform/retention changes.
- [ ] Parent validates review findings before authorizing any follow-up fixes. Do not automatically act on speculative reviewer suggestions.
- [ ] Return worktree path, branch, base/head commits, changed files, exact test commands/results, remaining risks and a per-task acceptance checklist. Do not merge/push; integration belongs to the parent/user.

## Baseline Evidence

At the reviewed base: 280 Vitest tests in 36 files passed; TypeScript, frontend build, and macOS offline locked cargo check passed. Windows/Linux builds and real audio/UI flows were not exercised. Existing tests do not prove the defective edge cases above. No source files were changed during the review.
