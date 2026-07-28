# Review Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the eight verified request-streaming, provider-persistence, transport, warmup, and local-STT defects without launching Aileron.

**Architecture:** Put race-sensitive behavior behind small tested helpers, then make each hook or context consume those helpers. Provider behavior is declared as capabilities instead of inferred from endpoint names, and blocking local transcription is moved to Tokio's blocking pool.

**Tech Stack:** React 19, TypeScript 5.8, Vitest 4, Tauri 2, Rust, Tokio

## Global Constraints

- Preserve all pre-existing working-tree changes.
- Do not launch `npm run dev` or `npm run tauri dev`.
- Do not add code comments.
- Keep every fix independently testable and provide file-level rollback guidance.

---

### Task 1: Cancellation-safe streaming

**Files:**
- Modify: `src/lib/token-batcher.ts`
- Modify: `src/lib/token-batcher.test.ts`
- Modify: `src/hooks/useChatCompletion.ts`
- Modify: `src/hooks/useCompletion.ts`
- Modify: `src/hooks/useSystemAudio.ts`

**Interfaces:**
- Consumes: `createTokenBatcher(onFlush, intervalMs, isActive)`
- Produces: a batcher whose `cancel()` is permanent and whose flush callback is gated by request identity.

- [ ] Write tests proving a cancelled batcher cannot restart and an inactive batcher drops buffered tokens.
- [ ] Run `npx vitest run src/lib/token-batcher.test.ts` and confirm the new tests fail.
- [ ] Add the active predicate and permanent cancellation behavior.
- [ ] Store active batchers in refs and cancel them before abort/supersession/unmount.
- [ ] Run the focused test and inspect all stream-finalization paths.

### Task 2: Provider-scoped, ordered persistence

**Files:**
- Modify: `src/lib/provider-sync.ts`
- Modify: `src/lib/provider-sync.test.ts`
- Modify: `src/contexts/app.context.tsx`

**Interfaces:**
- Produces: `providerSecretKey(baseKey, providerId)`, a generation guard, and a serialized async writer.
- Consumes: `saveSecret`, `getSecret`, and `removeSecret`.

- [ ] Write tests proving provider keys are distinct, A-B-A stale loads are rejected, and writes complete in enqueue order.
- [ ] Run `npx vitest run src/lib/provider-sync.test.ts` and confirm failure.
- [ ] Implement the helpers.
- [ ] Migrate the legacy shared secret to the selected provider's scoped key.
- [ ] Guard async reads and serialize writes for both AI and STT selections.
- [ ] Run the focused tests.

### Task 3: Bounded chat history

**Files:**
- Modify: `src/hooks/useChatCompletion.ts`
- Modify: `src/lib/functions/ai-history.test.ts`

**Interfaces:**
- Consumes: `buildAIHistory(messages)`.
- Produces: chat requests capped at `MAX_AI_HISTORY_MESSAGES`, oldest-first.

- [ ] Add a regression case using the overlay chat's oldest-first ordering.
- [ ] Run the focused history test.
- [ ] Replace the raw message mapping with `buildAIHistory`.
- [ ] Run the focused history test again.

### Task 4: Explicit capabilities and complete URL reconstruction

**Files:**
- Modify: `src/types/provider.type.ts`
- Modify: `src/config/ai-providers.constants.ts`
- Modify: `src/hooks/useCustomProvider.ts`
- Modify: `src/pages/dev/components/ai-configs/CreateEditProvider.tsx`
- Modify: `src/lib/functions/common.function.ts`
- Modify: `src/lib/functions/ai-response.function.ts`
- Modify: `src/lib/functions/stt.function.ts`
- Modify: `src/lib/functions/reasoning-effort.test.ts`
- Modify: `src/lib/functions/url-placeholders.test.ts`

**Interfaces:**
- Produces: provider-declared thinking-off/warmup capabilities and `resolveCurlUrl(parsedCurl, variables)`.
- Consumes: provider model variables and curl parser output.

- [ ] Write failing tests for query-auth preservation and capability-gated reasoning control.
- [ ] Implement shared query reconstruction and use it in AI and STT.
- [ ] Replace endpoint-path reasoning detection with provider capabilities.
- [ ] Allow custom providers to opt into `reasoning_effort: none`.
- [ ] Run both focused test files.

### Task 5: Credential-safe errors

**Files:**
- Modify: `src/lib/functions/common.function.ts`
- Modify: `src/lib/functions/describe-error.test.ts`
- Modify: `src/lib/functions/ai-response.function.ts`

**Interfaces:**
- Produces: redacted endpoint labels and error details.

- [ ] Write failing tests for URL userinfo, query strings, and configured variable values.
- [ ] Implement redaction using origin-only endpoint display and exact secret replacement.
- [ ] Apply redaction to transport and non-2xx response errors.
- [ ] Run the focused tests.

### Task 6: Single-owner warmup

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/routes/index.tsx`
- Modify: `src/hooks/useModelWarmup.ts`
- Modify: `src/lib/functions/model-warmup.ts`
- Modify: `src/lib/functions/model-warmup.test.ts`

**Interfaces:**
- Consumes: `enableModelWarmup` from the main-window label.
- Produces: one heartbeat owner and structured `{url, model}` effect dependencies.

- [ ] Add tests for explicit warmup capability and IPv6 targets.
- [ ] Run the focused tests and confirm capability tests fail.
- [ ] Remove `url::model` serialization and make in-flight state effect-local.
- [ ] Enable warmup only for the main window.
- [ ] Run the focused tests.

### Task 7: Local STT cache lifetime and blocking isolation

**Files:**
- Modify: `src-tauri/src/stt.rs`
- Modify: `src-tauri/src/speaker/commands.rs`

**Interfaces:**
- Produces: bounded, expiring utterance entries that survive capture stop.
- Consumes: cloned `Arc<Mutex<SttInner>>` inside `tokio::task::spawn_blocking`.

- [ ] Add Rust unit tests for bounded storage and expiry.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml stt::tests`.
- [ ] Stop clearing the utterance store during capture shutdown.
- [ ] Move both transcription commands onto the blocking pool.
- [ ] Re-run the focused Rust tests.

### Task 8: Full verification and rollback map

**Files:**
- Review: all files above

- [ ] Run `git diff --check`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npx vitest run`.
- [ ] Run `npm run build`.
- [ ] Run `cargo check --manifest-path src-tauri/Cargo.toml` only if it will not interfere with the user's running Aileron process.
- [ ] Review the final diff for unrelated changes and report each reversible file group.
