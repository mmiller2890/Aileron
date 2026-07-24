# Provider, Listener, and Attachment Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix custom loopback-provider authentication, StrictMode listener leaks and duplicate transcripts, and six-file attachment-cap bypasses.

**Architecture:** Add three focused, framework-independent utilities: an async listener lifecycle scope, a bounded recent speech-event fingerprint set, and shared provider/attachment policy helpers. Integrate them into the existing hooks without changing UI behavior or launching Aileron.

**Tech Stack:** React 19, TypeScript 5.8, Vitest 4, Tauri 2 event APIs.

## Global Constraints

- Work directly on `dev`; `main` remains frozen.
- Do not launch `npm run tauri dev`.
- Keep React StrictMode enabled.
- Preserve a hard maximum of six image attachments.
- Do not add code comments.
- Preserve user-owned `artdeco-example.html` and exclude it from commits.
- Commit implementation separately from `02cc5e7` and `129dcb0`.

---

### Task 1: Cancellation-safe listener lifecycle and speech-event deduplication

**Files:**
- Create: `src/lib/async-listener-scope.ts`
- Create: `src/lib/async-listener-scope.test.ts`
- Create: `src/lib/speech-event-dedupe.ts`
- Create: `src/lib/speech-event-dedupe.test.ts`
- Modify: `src/hooks/useSystemAudio.ts`
- Modify: `src/hooks/useCompletion.ts`
- Modify: `src/hooks/useChatCompletion.ts`

**Interfaces:**
- Produces: `createAsyncListenerScope(): { add(registration: Promise<() => void>): Promise<void>; guard<T extends (...args: any[]) => any>(handler: T): T; dispose(): void }`
- Produces: `RecentSpeechEventFingerprints` with `claim(payload, now?): boolean`
- Consumes: Tauri `listen()` promises and `speech-detected` payloads.

- [ ] **Step 1: Write failing listener-scope tests**

Cover resolved listeners, listeners resolving after disposal, idempotent disposal, and guarded callbacks that receive no events after disposal. Include two StrictMode-style scopes where the first is disposed before registration resolves and confirm one emitted event reaches only the second handler.

- [ ] **Step 2: Run listener-scope tests and verify RED**

Run:

```bash
npx vitest run src/lib/async-listener-scope.test.ts
```

Expected: failure because `createAsyncListenerScope` does not exist.

- [ ] **Step 3: Implement the minimal listener scope**

The implementation keeps an `active` flag and a `Set` of resolved unlisten functions. `guard()` checks `active`; `add()` unregisters immediately if its promise resolves after disposal; `dispose()` flips `active`, invokes the set, and clears it.

- [ ] **Step 4: Run listener-scope tests and verify GREEN**

Run:

```bash
npx vitest run src/lib/async-listener-scope.test.ts
```

Expected: all listener-scope tests pass.

- [ ] **Step 5: Write failing recent-fingerprint tests**

Use payloads shaped as:

```ts
{
  audio: "base64-audio",
  start_time: 1.25,
  end_time: 2.5,
}
```

Verify immediate duplicates are rejected, A-B-A rejects the second A, the same payload is accepted after 60 seconds, timestamp changes remain distinct, and the set never retains more than 32 entries.

- [ ] **Step 6: Run fingerprint tests and verify RED**

Run:

```bash
npx vitest run src/lib/speech-event-dedupe.test.ts
```

Expected: failure because `RecentSpeechEventFingerprints` does not exist.

- [ ] **Step 7: Implement the bounded fingerprint set**

Create a compact deterministic hash from the audio base64 plus exact start/end timestamps. Store expiry timestamps in insertion order, prune expired entries on `claim()`, and evict oldest entries above 32.

- [ ] **Step 8: Run fingerprint tests and verify GREEN**

Run:

```bash
npx vitest run src/lib/speech-event-dedupe.test.ts
```

Expected: all fingerprint tests pass.

- [ ] **Step 9: Integrate the listener scope and deduplication**

Replace mutable `unlisten` variables in the asynchronous effects in `useSystemAudio`, `useCompletion`, and `useChatCompletion` with one scope per effect. Wrap every callback with `scope.guard()`, register promises with `scope.add()`, and call `scope.dispose()` during cleanup.

In the `speech-detected` callback, validate and claim the payload before checking streaming-finalized state or starting STT. Return immediately when `claim()` rejects it.

- [ ] **Step 10: Run focused and full frontend tests**

Run:

```bash
npx vitest run src/lib/async-listener-scope.test.ts src/lib/speech-event-dedupe.test.ts
npx tsc --noEmit
```

Expected: focused tests and typecheck pass.

---

### Task 2: URL-aware optional API keys and empty-header omission

**Files:**
- Create: `src/lib/functions/provider-auth.ts`
- Create: `src/lib/functions/provider-auth.test.ts`
- Modify: `src/lib/functions/ai-response.function.ts`

**Interfaces:**
- Produces: `isApiKeyOptional(providerId: string | undefined, resolvedUrl: string): boolean`
- Produces: `omitEmptyApiKeyHeaders(resolvedHeaders, templateHeaders, apiKey): Record<string, string>`
- Consumes: parsed cURL URL/header objects and selected provider variables.

- [ ] **Step 1: Write failing provider-auth tests**

Cover `localhost`, mixed-case localhost, `127.0.0.1`, another `127/8` address, `[::1]`, built-in Ollama/LM Studio IDs, remote HTTPS, deceptive hosts such as `localhost.example.com`, and malformed URLs. Verify only headers templated with `{{API_KEY}}` are removed when the key is empty.

- [ ] **Step 2: Run provider-auth tests and verify RED**

Run:

```bash
npx vitest run src/lib/functions/provider-auth.test.ts
```

Expected: failure because the provider-auth helpers do not exist.

- [ ] **Step 3: Implement provider-auth helpers**

Parse with `new URL()`, normalize the hostname, recognize only exact localhost/IPv6 loopback or IPv4 addresses beginning with `127.`, and fail closed on parsing errors. Header omission must compare the original template values and preserve unrelated headers.

- [ ] **Step 4: Run provider-auth tests and verify GREEN**

Run:

```bash
npx vitest run src/lib/functions/provider-auth.test.ts
```

Expected: all provider-auth tests pass.

- [ ] **Step 5: Integrate policy into `fetchAIResponse`**

Build the normalized variable map before required-variable validation, resolve the parsed cURL URL with that map, and pass it to `isApiKeyOptional`. After replacing header variables, remove empty API-key-templated headers. Keep remote providers' existing early missing-variable error.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run src/lib/functions/provider-auth.test.ts
npx tsc --noEmit
```

Expected: tests and typecheck pass.

---

### Task 3: Shared six-file attachment policy

**Files:**
- Create: `src/lib/attachments.ts`
- Create: `src/lib/attachments.test.ts`
- Modify: `src/hooks/useCompletion.ts`
- Modify: `src/hooks/useChatCompletion.ts`

**Interfaces:**
- Produces: `selectImageFilesWithinLimit<T extends { type: string }>(files: readonly T[], currentCount: number, maxFiles?: number): T[]`
- Produces: `appendWithinLimit<T>(current: readonly T[], incoming: readonly T[], maxFiles?: number): T[]`
- Consumes: `MAX_FILES` from `src/config/constants.ts`.

- [ ] **Step 1: Write failing attachment-policy tests**

Verify ten images from zero returns six, four existing files leaves two slots, non-images are filtered, counts at/above the cap return none, and appending overlapping async results never exceeds six.

- [ ] **Step 2: Run attachment tests and verify RED**

Run:

```bash
npx vitest run src/lib/attachments.test.ts
```

Expected: failure because the attachment helpers do not exist.

- [ ] **Step 3: Implement the pure attachment helpers**

Clamp remaining capacity at zero, filter image MIME types before slicing, and return a new capped array from `appendWithinLimit`.

- [ ] **Step 4: Run attachment tests and verify GREEN**

Run:

```bash
npx vitest run src/lib/attachments.test.ts
```

Expected: all attachment tests pass.

- [ ] **Step 5: Integrate both completion hooks**

Use `selectImageFilesWithinLimit` for picker and paste candidates. In `addFile`, use `appendWithinLimit(prev.attachedFiles, [attachedFile])` inside the functional state update so overlapping asynchronous conversions cannot exceed the cap.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npx vitest run src/lib/attachments.test.ts
npx tsc --noEmit
```

Expected: tests and typecheck pass.

---

### Task 4: Full verification and reversible implementation commit

**Files:**
- Modify: `docs/superpowers/specs/2026-07-23-provider-listener-attachment-stability-design.md`
- Create: `docs/superpowers/plans/2026-07-23-provider-listener-attachment-stability.md`

- [ ] **Step 1: Inspect the complete diff**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; `artdeco-example.html` remains untracked.

- [ ] **Step 2: Run all required gates**

Run:

```bash
npx tsc --noEmit
npm run build
npx vitest run
cd src-tauri && cargo check
```

Expected: every command exits zero. The five known Cocoa deprecation warnings may remain.

- [ ] **Step 3: Commit only the stability implementation**

Stage the reviewed source, tests, amended design, and plan; explicitly exclude `artdeco-example.html`.

```bash
git commit -m "fix: prevent duplicate transcripts and provider edge cases"
```

- [ ] **Step 4: Verify rollback boundaries**

Run:

```bash
git log --oneline -4
git status --short
```

Expected: separate commits for `02cc5e7`, `129dcb0`, the plan amendment, and the implementation; only `artdeco-example.html` remains untracked.
