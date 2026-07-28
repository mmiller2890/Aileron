# Live Session Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS system-audio → Fluidaudio → cloud/local AI workflow safe for a real live session.

**Architecture:** Normalize ASR samples and avoid capture-thread lock contention in Rust. Put asynchronous ownership rules into small TypeScript helpers for shortcut initialization, session work, provider hydration, cache errors, and completed streams, then wire those helpers into the existing hooks and context without launching the desktop app.

**Tech Stack:** Tauri 2, Rust, React 19, TypeScript 5.8, Vitest, Vite 7

## Global Constraints

- Do not launch Aileron or compete with port 1420.
- Keep the macOS 14 minimum and use one Fluidaudio instance.
- Keep original-rate WAV output unchanged.
- Use failing regression tests before production edits.
- Preserve unrelated changes in the dirty `dev` checkout.
- Do not commit implementation files automatically because several already contain unrelated uncommitted work.

---

### Task 1: Normalize Cached ASR Samples and Make VAD Nonblocking

**Files:**
- Modify: `src-tauri/src/speaker/commands.rs`
- Modify: `src-tauri/src/stt.rs`

**Interfaces:**
- Consumes: `resample_linear(input: &[f32], from_rate: usize, to_rate: usize) -> Vec<f32>`
- Produces: cached utterances containing 16 kHz mono samples and `try_lock_stt_inner(&Mutex<SttInner>) -> Result<MutexGuard<SttInner>, String>`

- [x] Add a Rust test proving 48,000 input frames produce 16,000 cached-ASR frames while 16 kHz input is unchanged.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml speaker::commands::tests::normalizes_cached_utterance_samples_to_16khz` and confirm it fails.
- [x] Extract `samples_for_local_asr(samples, sample_rate)` and use it only for `UtteranceStore::put`; continue passing original samples and sample rate to WAV encoding.
- [x] Run the focused test and confirm it passes.
- [x] Add a Rust test that holds the STT mutex and confirms the nonblocking lock helper returns a busy error immediately.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml stt::tests::busy_stt_lock_returns_without_waiting` and confirm it fails.
- [x] Use `try_lock` in `vad_process_samples`; map `WouldBlock` to a temporary unavailable error and poisoned locks to the existing lock error.
- [x] Run both focused Rust tests and `cargo test --manifest-path src-tauri/Cargo.toml`.

### Task 2: Register Global Shortcut Listeners Once

**Files:**
- Modify: `src/lib/async-listener-scope.ts`
- Modify: `src/lib/async-listener-scope.test.ts`
- Modify: `src/hooks/useGlobalShortcuts.ts`

**Interfaces:**
- Produces: `createSingleFlightInitializer(setup: () => Promise<void>): { run(): Promise<void> }`
- Guarantee: concurrent `run()` calls share one promise; a rejected setup can be retried.

- [x] Add Vitest cases that call `run()` concurrently and expect one setup call, then reject once and expect the next call to retry.
- [x] Run `npx vitest run src/lib/async-listener-scope.test.ts` and confirm the new cases fail.
- [x] Implement `createSingleFlightInitializer`.
- [x] Move global shortcut registration behind one module-level initializer. On retry, dispose any partially registered handles before registering a complete listener set.
- [x] Run the focused Vitest file and confirm it passes.

### Task 3: Enforce the Loopback-Only Empty-Key Boundary

**Files:**
- Modify: `src/lib/functions/provider-auth.test.ts`
- Modify: `src/lib/functions/provider-auth.ts`

**Interfaces:**
- Consumes: fully resolved request URL.
- Produces: `isApiKeyOptional(providerId, resolvedUrl)` returning true only for `localhost`, `127.0.0.0/8`, or `::1`.

- [x] Replace the built-in-ID exemption test with cases proving `ollama` and `lm-studio` still require a key at a non-loopback URL.
- [x] Run `npx vitest run src/lib/functions/provider-auth.test.ts` and confirm failure.
- [x] Remove the provider-ID bypass while retaining the existing malformed-URL fail-safe and empty-header removal.
- [x] Run the focused tests and confirm they pass.

### Task 4: Scope Provider Secrets and Announce Hydrated Switches

**Files:**
- Modify: `src/lib/provider-sync.ts`
- Modify: `src/lib/provider-sync.test.ts`
- Modify: `src/contexts/app.context.tsx`
- Modify: `src/hooks/useCustomProvider.ts`

**Interfaces:**
- Produces: exported `AI_PROVIDER_SECRET_KEY`, `STT_PROVIDER_SECRET_KEY`
- Produces: `readScopedProviderSecret(baseKey, provider, getSecret)` and `readInitialProviderSecret(baseKey, provider, secretStore)`
- Guarantee: legacy unscoped data migrates only during startup hydration; arbitrary switches read only scoped data.

- [x] Add tests proving a scoped switch never reads the legacy key, startup migration saves before removing legacy data, and stale loads cannot announce.
- [x] Run `npx vitest run src/lib/provider-sync.test.ts` and confirm failure.
- [x] Implement the secret helpers and use startup-only migration in `loadData`.
- [x] Update AI and STT switch setters to read scoped secrets only, apply only through the existing generation guard, mark the final value persisted, and emit once after hydration, including an empty secret.
- [x] Delete a custom provider's scoped secret when its metadata is deleted.
- [x] Run the focused provider tests and `npx tsc --noEmit`.

### Task 5: Retry WAV Decode Only for a Typed Cache Miss

**Files:**
- Modify: `src-tauri/src/stt.rs`
- Modify: `src/lib/functions/stt.function.ts`
- Create: `src/lib/functions/stt.function.test.ts`

**Interfaces:**
- Produces: Rust errors prefixed with `UTTERANCE_CACHE_MISS:`.
- Produces: `isUtteranceCacheMiss(error: unknown): boolean`.

- [x] Mock Tauri `invoke` and add one test where the typed cache miss invokes `stt_transcribe_speech`, plus one where an inference error rejects after the first invocation.
- [x] Run `npx vitest run src/lib/functions/stt.function.test.ts` and confirm failure.
- [x] Prefix only missing/expired utterance errors in Rust and restrict the TypeScript fallback to that prefix.
- [x] Run the focused Vitest file and the Rust STT tests.

### Task 6: Bind STT Work to a Capture Session

**Files:**
- Create: `src/lib/capture-session-work.ts`
- Create: `src/lib/capture-session-work.test.ts`
- Modify: `src/hooks/useSystemAudio.ts`

**Interfaces:**
- Produces: `createCaptureSessionWork()` with `begin(): number`, `isCurrent(generation): boolean`, `track<T>(generation, work): Promise<T>`, `drain(generation, timeoutMs): Promise<boolean>`, and `invalidate(generation): void`.
- Guarantee: STT draining does not wait for AI streaming work.

- [x] Add tests proving invalidated generations reject updates, drain waits for tracked STT, and drain returns false at its timeout.
- [x] Run `npx vitest run src/lib/capture-session-work.test.ts` and confirm failure.
- [x] Implement the tracker with a per-generation `Set<Promise<unknown>>`.
- [x] Begin a generation at capture start. Capture it in each speech event, track only `fetchSTT`, and re-check it before every transcript/error/conversation/AI mutation.
- [x] Start AI processing after the transcript is accepted without keeping the tracked STT promise open for the AI stream.
- [x] After the backend stop resolves, yield one event-loop turn, drain current STT with a bounded timeout, then invalidate before diarization/summary state is finalized.
- [x] Use refs for the selected STT provider and callbacks read by the stable stop/listener closures.
- [x] Run the focused tests and `npx tsc --noEmit`.

### Task 7: Never Persist a Failed Partial AI Stream

**Files:**
- Create: `src/lib/completed-stream.ts`
- Create: `src/lib/completed-stream.test.ts`
- Modify: `src/hooks/useSystemAudio.ts`

**Interfaces:**
- Produces: `completedStreamValue(value: string, completed: boolean): string | null`.

- [x] Add tests proving a completed response returns its value while a failed response returns null.
- [x] Run `npx vitest run src/lib/completed-stream.test.ts` and confirm failure.
- [x] Track stream completion in `processWithAI`; keep partial text visible on failure but return before conversation persistence unless the helper returns a completed value.
- [x] Run the focused tests and `npx tsc --noEmit`.

### Task 8: Close Ollama Warmup Responses

**Files:**
- Modify: `src/lib/functions/model-warmup.test.ts`
- Modify: `src/lib/functions/model-warmup.ts`

**Interfaces:**
- Guarantee: warmup request JSON includes `{ stream: false }` and `response.text()` is awaited before returning.

- [x] Mock the Tauri HTTP fetch and add a test asserting `stream: false` plus exactly one body-consumption call.
- [x] Run `npx vitest run src/lib/functions/model-warmup.test.ts` and confirm failure.
- [x] Add non-streaming mode and consume the response body for success and HTTP failure responses.
- [x] Run the focused test and confirm it passes.

### Task 9: Verify the Release Candidate

**Files:**
- Review: all files changed by Tasks 1-8

**Interfaces:**
- Produces: automated gate evidence and a manual live-session checklist.

- [x] Run `git diff --check`.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx vitest run`.
- [x] Run `npm run build`.
- [x] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [x] Run `cargo check --manifest-path src-tauri/Cargo.toml`.
- [x] Run `npm run tauri build` without launching the app.
- [x] Review the final diff for stale-code assumptions, secrets, unrelated edits, and revert boundaries.
- [x] Report residual manual checks: macOS permissions, real audio level, Fluidaudio transcription quality, provider credentials, shortcut conflicts, provider switching latency, and overlay visibility.
