# Remove the Dead Streaming-STT Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the unreachable streaming-STT feature (socket hook, coordination flags, partial-transcript UI plumbing, misleading editor toggle) before the 0.1.9 RC tag.

**Architecture:** The streaming-STT feature is fully built and UI-wired but provably unreachable — every STT preset force-sets `streaming: false`, custom STT providers are force-overridden, and neither local backend supports true streaming. The deletion proceeds consumers-first so `npx tsc --noEmit` stays clean at every task boundary: strip UI props → drop snapshot fields → unwire `useSystemAudio` → delete the hook files → clean provider configs/editor → full verification.

**Tech Stack:** TypeScript 5.8, React 19, Vitest 4, Vite 7. No Rust changes.

**Spec:** `docs/superpowers/specs/2026-08-03-remove-dead-streaming-stt-design.md`

## Global Constraints

- Do NOT touch AI streaming: `src/lib/functions/ai-response.function.ts`, AI presets' `streaming: true` in `src/config/ai-providers.constants.ts`, `src/hooks/useCustomProvider.ts`, `src/pages/dev/components/ai-configs/*` (AI editor toggle stays).
- KEEP `streaming?: boolean` on `TYPE_PROVIDER` (`src/types/provider.type.ts:12`). DELETE only `streamingUrl?: string` (line 13).
- Do NOT touch `TranscriptFeed`'s `live` mode or `liveAnswerDraft` (AI answer streaming).
- Do NOT touch `CHUNK_POLL_INTERVAL_MS` in `src/lib/chat-constants.ts` (unrelated dead constant, out of scope).
- NEVER use `git add -A` or `git add .` — the working tree contains unrelated uncommitted fixes from the review pass. Always `git add` explicit paths (as written in each step).
- Do NOT launch the app or any dev server (a dev instance runs on port 1420 — never compete). `npx vitest run`, `npx tsc --noEmit`, `git diff --check` are safe.
- Do NOT commit anything beyond the files listed in each task's step.
- Baseline suite: 216 vitest tests / 25 files green, tsc clean. Expected after Task 4: 215 tests (the socket test file's single test is deleted).
- No comments in code unless necessary; follow existing style.

---

### Task 1: Strip streaming props from UI consumers

**Files:**
- Modify: `src/pages/app/components/speech/RecordingPanel.tsx` (props ~14-15, defaults ~28-29, render branch ~36-46)
- Modify: `src/pages/app/components/speech/ResultsSection.tsx` (props ~14-15, defaults ~27-28, branches ~35, 42, 87, 167)
- Modify: `src/pages/app/components/speech/index.tsx` (destructure ~42-43, prop passes ~414-415, ~426-427)
- Modify: `src/pages/dashboard/components/TranscriptFeed.tsx` (prop ~16, ~21, destructure ~54, condition ~60, render block ~99)
- Modify: `src/pages/dashboard/index.tsx` (line ~111)

**Interfaces:**
- Consumes: nothing (leaf components).
- Produces: `RecordingPanel` and `ResultsSection` no longer accept `partialTranscription`/`isStreaming`; `TranscriptFeed` no longer accepts `partialTranscription`; `speech/index.tsx` no longer destructures them from `useSystemAudio`; `dashboard/index.tsx` no longer passes `snapshot?.partialTranscription`.
- Later tasks rely on: `useSystemAudio` may still return `partialTranscription`/`isStreaming` (removed in Task 3) — nothing may reference them from UI after this task.

- [ ] **Step 1: Strip props from `RecordingPanel.tsx`**

Remove:
- `partialTranscription?: string;` and `isStreaming?: boolean;` from the props interface (lines ~14-15)
- `partialTranscription = "",` and `isStreaming = false,` from the destructure defaults (lines ~28-29)
- The render branch `{isStreaming && partialTranscription && !isWorking && (…)}` (lines ~36-46, including the closing `)}`)

Verify with `grep -n "partialTranscription\|isStreaming" src/pages/app/components/speech/RecordingPanel.tsx` — expect no matches.

- [ ] **Step 2: Strip props from `ResultsSection.tsx`**

Remove:
- `partialTranscription?: string;` and `isStreaming?: boolean;` from the props interface (lines ~14-15)
- `partialTranscription = "",` and `isStreaming = false,` from the destructure defaults (lines ~27-28)
- `partialTranscription` from the early-return condition `if (!hasResponse && !lastTranscription && !partialTranscription)` (line ~35) → `if (!hasResponse && !lastTranscription)`
- `const transcriptionText = lastTranscription || (isStreaming ? partialTranscription : "");` (line ~42) → `const transcriptionText = lastTranscription;`
- Both `isStreaming && !lastTranscription && "italic opacity-60"` class expressions (lines ~87, ~167) → remove the `isStreaming && … &&` guard, keep the class conditional if `lastTranscription` still gates it, or drop the expression entirely if nothing remains (read the surrounding `cn(...)` call and preserve the other classes)

Verify: `grep -n "partialTranscription\|isStreaming" src/pages/app/components/speech/ResultsSection.tsx` — no matches.

- [ ] **Step 3: Strip the destructure and prop passes in `speech/index.tsx`**

Remove:
- `partialTranscription,` and `isStreaming,` from the `useSystemAudio()` destructure (lines ~42-43)
- `partialTranscription={partialTranscription}` and `isStreaming={isStreaming}` from the `RecordingPanel` props (lines ~414-415)
- `partialTranscription={partialTranscription}` and `isStreaming={isStreaming}` from the `ResultsSection` props (lines ~426-427)

Verify: `grep -n "partialTranscription\|isStreaming" src/pages/app/components/speech/index.tsx` — no matches.

- [ ] **Step 4: Strip the prop from `TranscriptFeed.tsx`**

Remove:
- `partialTranscription = "",` from the destructure defaults (line ~16)
- `partialTranscription?: string;` from the props interface (line ~21)
- `partialTranscription,` from the destructure (line ~54)
- `!partialTranscription &&` from the condition at line ~60 (keep the rest of the condition)
- The block `{live && partialTranscription && ( … )}` (line ~99, including its closing `}`)

KEEP `live` and `liveAnswerDraft` entirely.

Verify: `grep -n "partialTranscription" src/pages/dashboard/components/TranscriptFeed.tsx` — no matches.

- [ ] **Step 5: Remove the prop pass in `dashboard/index.tsx`**

Remove line ~111: `partialTranscription={snapshot?.partialTranscription ?? ""}` from the `TranscriptFeed` props.

Verify: `grep -n "partialTranscription" src/pages/dashboard/index.tsx` — no matches.

- [ ] **Step 6: Typecheck and run the suite**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors (the `useSystemAudio` return values are not yet removed — that's Task 3; unused returns do not fail tsc).

Run: `npx vitest run`
Expected: 25 files / 216 tests pass (no test touched this task).

- [ ] **Step 7: Commit**

```bash
git add src/pages/app/components/speech/RecordingPanel.tsx src/pages/app/components/speech/ResultsSection.tsx src/pages/app/components/speech/index.tsx src/pages/dashboard/components/TranscriptFeed.tsx src/pages/dashboard/index.tsx
git commit -m "refactor: strip dead streaming-STT props from UI components"
```

---

### Task 2: Remove dead fields from `LiveSessionSnapshot`

**Files:**
- Modify: `src/lib/live-session.ts` (lines 39-40)
- Modify: `src/lib/live-session.test.ts` (lines 25-26)

**Interfaces:**
- Consumes: Task 1 removed the only consumer of `snapshot?.partialTranscription` (`dashboard/index.tsx:111`).
- Produces: `LiveSessionSnapshot` without `partialTranscription` and `isStreaming`. Nothing later depends on these fields.

- [ ] **Step 1: Remove the fields from the type**

In `src/lib/live-session.ts`, remove from `LiveSessionSnapshot`:
- `partialTranscription: string;` (line ~39)
- `isStreaming: boolean;` (line ~40)

Verify: `grep -n "partialTranscription\|isStreaming" src/lib/live-session.ts` — no matches.

- [ ] **Step 2: Update the test fixture**

In `src/lib/live-session.test.ts`, remove from the snapshot fixture (lines ~25-26):
- `partialTranscription: "",`
- `isStreaming: false,`

- [ ] **Step 3: Typecheck and run the suite**

Run: `npx tsc --noEmit` — expected exit 0.
Run: `npx vitest run` — expected 25 files / 216 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/live-session.ts src/lib/live-session.test.ts
git commit -m "refactor: remove dead partial-transcription fields from LiveSessionSnapshot"
```

---

### Task 3: Unwire the streaming socket from `useSystemAudio`

**Files:**
- Modify: `src/hooks/useSystemAudio.ts` (import line 26; ref line 211; destructure+call 213-220; calls at 256, 266, 305, 313, 480-484, 1128, 1193; speech-detected block 339-346; flag resets 481-482, 1197-1198; `onFinalTranscriptRef` callback ~761-800; return sites 1253-1264, 1418-1419, 1448-1449, 1554-1555)

**Interfaces:**
- Consumes: nothing — this is the last importer of the hook.
- Produces: `useSystemAudio` no longer returns `partialTranscription`/`isStreaming`; no reference to `useSttStreamSocket` remains. Task 4 deletes the hook files.

**This task is the core of the change. Work from the greps, not the line numbers (they shift as you edit).**

- [ ] **Step 1: Remove the import and the hook wiring**

Remove:
- `import { useSttStreamSocket } from "./system-audio/useSttStreamSocket";` (line ~26)
- `const onFinalTranscriptRef = useRef<(text: string) => void>(() => {});` (line ~211)
- The `useSttStreamSocket({…})` destructure block (lines ~213-220) — the `isStreaming, partialTranscription, openStreamingSocket, closeStreamingSocket, sendAudioChunk, streamingFinalizedRef, batchProcessedForCurrentUtteranceRef` variables and the call itself. Remove the entire destructure statement plus the closing `} = useSttStreamSocket({ … });` with all its argument refs (`selectedSttProviderRef`, `allSttProvidersRef`, `capturedSampleRateRef`, `onFinalTranscriptRef`, `captureGenerationRef`, `isCaptureGenerationCurrentRef`).

- [ ] **Step 2: Remove the socket calls in the capture lifecycle**

Use `grep -n "openStreamingSocket\|closeStreamingSocket\|sendAudioChunk" src/hooks/useSystemAudio.ts` to find each site, then:
- Remove `openStreamingSocket();` at the capture-start site (~256) and the speech-chunk site (~305)
- Remove `closeStreamingSocket();` at ~266, ~345, ~480, ~1128, ~1193
- Remove `sendAudioChunk(event.payload as string);` (~313) — if it sat inside a conditional or a listener callback, remove only that line (and the now-empty branch if it becomes empty — check the surrounding code)
- At the cleanup effect (~480-484): remove `closeStreamingSocket();` and fix the effect's dependency array (it currently includes `openStreamingSocket, closeStreamingSocket` — remove those entries; keep any remaining deps)

- [ ] **Step 3: Simplify the speech-detected handler**

The block at ~339-346 currently reads:

```ts
if (streamingFinalizedRef.current) {
  streamingFinalizedRef.current = false;
  closeStreamingSocket();
  return;
}

closeStreamingSocket();
batchProcessedForCurrentUtteranceRef.current = true;
```

Remove the whole thing (the `if` block AND the two lines after it). The handler then continues directly to the batch logic that follows (the `payload.start_time !== 0` timestamp push at ~348). Do NOT remove the timestamp push or anything after it.

- [ ] **Step 4: Remove the flag resets**

Remove `streamingFinalizedRef.current = false;` and `batchProcessedForCurrentUtteranceRef.current = false;` wherever they appear as standalone resets (grep `streamingFinalizedRef\|batchProcessedForCurrentUtteranceRef` — expect hits at ~481-482, ~773 (inside the callback being removed in Step 5), ~1197-1198; after Steps 1-3 the only remaining hits should be inside the Step 5 callback).

- [ ] **Step 5: Remove the `onFinalTranscriptRef` callback block**

Find the block starting at ~761 with the comment `// Streaming provider produced a final transcript for the current utterance.` and `onFinalTranscriptRef.current = (text: string) => {` — remove the entire assignment through its closing `};` (roughly lines 761-800). This is the handler that recorded a streaming final transcript and answered-if-question; it is unreachable and its dedupe flag (`batchProcessedForCurrentUtteranceRef`) is only read here.

Verify: `grep -n "streamingFinalizedRef\|batchProcessedForCurrentUtteranceRef\|onFinalTranscriptRef" src/hooks/useSystemAudio.ts` — expect no matches.

- [ ] **Step 6: Remove `partialTranscription`/`isStreaming` from all return sites**

Use `grep -n "partialTranscription\|isStreaming" src/hooks/useSystemAudio.ts` — remove every occurrence. Known sites:
- The `shouldOpenPopover` boolean (~1253): remove the `isStreaming ||` term from the expression AND `isStreaming,` from the effect's dependency array (~1260) that follows it
- The remaining hits (~1418-1419, ~1448-1449, ~1554-1555) are `partialTranscription,`/`isStreaming,` entries in returned objects — remove each pair

Verify: `grep -n "partialTranscription\|isStreaming\|useSttStreamSocket\|streamingFinalizedRef\|batchProcessedForCurrentUtteranceRef\|onFinalTranscriptRef\|openStreamingSocket\|closeStreamingSocket\|sendAudioChunk" src/hooks/useSystemAudio.ts` — no matches.

- [ ] **Step 7: Typecheck and run the suite**

Run: `npx tsc --noEmit` — expected exit 0. (If an error points at a UI consumer you missed in Task 1, fix the consumer — not `useSystemAudio`.)

Run: `npx vitest run` — expected 25 files / 216 tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useSystemAudio.ts
git commit -m "refactor: remove unreachable streaming-STT plumbing from useSystemAudio"
```

---

### Task 4: Delete the socket hook files and the `streamingUrl` type field

**Files:**
- Delete: `src/hooks/system-audio/useSttStreamSocket.ts`
- Delete: `src/hooks/system-audio/useSttStreamSocket.test.ts`
- Modify: `src/types/provider.type.ts` (line 13)

**Interfaces:**
- Consumes: Task 3 removed the only importer (`useSystemAudio.ts:26`).
- Produces: the hook files and `streamingUrl` no longer exist. The `streaming?: boolean` field remains on `TYPE_PROVIDER` (AI uses it).

- [ ] **Step 1: Confirm zero remaining importers**

Run: `grep -rn "useSttStreamSocket\|isActiveStreamingSession\|buildStreamingUrl" src/`
Expected: no matches. (If any match exists, stop and fix that consumer first.)

- [ ] **Step 2: Delete the files and remove the type field**

```bash
rm src/hooks/system-audio/useSttStreamSocket.ts src/hooks/system-audio/useSttStreamSocket.test.ts
```

In `src/types/provider.type.ts`, remove `streamingUrl?: string;` (line ~13). KEEP `streaming?: boolean;` (line ~12).

Verify: `grep -rn "streamingUrl" src/` — no matches. `grep -n "streaming" src/types/provider.type.ts` — shows only the `streaming?: boolean;` line.

- [ ] **Step 3: Typecheck and run the suite**

Run: `npx tsc --noEmit` — expected exit 0.
Run: `npx vitest run` — expected **25 files / 215 tests pass** (the deleted socket test was the 216th).

- [ ] **Step 4: Commit**

```bash
git add -u src/types/provider.type.ts src/hooks/system-audio/useSttStreamSocket.ts src/hooks/system-audio/useSttStreamSocket.test.ts
git commit -m "refactor: delete dead streaming-STT socket hook and streamingUrl type"
```

(Note: `git add -u` with explicit paths stages the deletion of the two files and the modification of the type file — it does NOT touch unrelated files. If the deletion is not staged, use `git rm` instead.)

---

### Task 5: Clean STT provider configs and the editor

**Files:**
- Modify: `src/config/stt.constants.ts` (remove `streaming: false` from all 11 presets: lines 7, 17, 28, 41, 51, 71, 81, 91, 101, 111, 121)
- Modify: `src/hooks/useCustomSttProviders.ts` (remove force-set `streaming: false` at 25, 120, 129, 140, 149; remove the comment at ~120)
- Modify: `src/pages/dev/components/stt-configs/CreateEditProvider.tsx` (remove toggle ~176-191)
- Modify: `src/pages/dev/components/stt-configs/CustomProvider.tsx` (remove readout line ~56)

**Interfaces:**
- Consumes: `streamingUrl` gone (Task 4); nothing reads STT `streaming` anymore.
- Produces: STT provider configs/editor carry no streaming field at all. AI configs untouched.

- [ ] **Step 1: Remove `streaming: false` from STT presets**

In `src/config/stt.constants.ts`, delete every `streaming: false,` line (all 11). If any preset also has a `streamingUrl`, delete that line too (verify first: `grep -n "streamingUrl" src/config/stt.constants.ts`).

Verify: `grep -n "streaming" src/config/stt.constants.ts` — no matches.

- [ ] **Step 2: Remove force-overrides from `useCustomSttProviders.ts`**

Delete every `streaming: false,` in the STT custom-provider hook (lines ~25, 120, 129, 140, 149) and the comment `// Streaming is not supported for STT providers. it will be fixed in the future.` (line ~120).

Verify: `grep -n "streaming" src/hooks/useCustomSttProviders.ts` — no matches.

**CRITICAL:** Do NOT touch `src/hooks/useCustomProvider.ts` — it is the AI hook and its `streaming` handling (lines 25, 115, 125, 137, 147) stays.

- [ ] **Step 3: Remove the toggle from the STT editor**

In `src/pages/dev/components/stt-configs/CreateEditProvider.tsx`, remove the entire "Streaming" block (~176-192): the wrapping `<div className="space-y-0">` containing the `Header` (`title="Streaming"`, description `"streaming is used to stream the response from the AI provider."`), the `Switch` (which is `checked={formData.streaming}`, `onCheckedChange` writing `streaming: checked`, and `disabled={true}` — permanently grayed out), and the red note `<span>` `"Streaming is not supported for STT providers. it will be fixed in the future."`. Delete the whole block, including its wrapper div.

After removal, check the `formData` type: if the local form state type requires `streaming`, the field is no longer set anywhere in this file — that's fine (it's optional in `TYPE_PROVIDER`); do not add a replacement. If the form state is a partial of `TYPE_PROVIDER`, no change needed.

- [ ] **Step 4: Remove the readout from the STT provider view**

In `src/pages/dev/components/stt-configs/CustomProvider.tsx`, remove the line `Streaming: {provider?.streaming ? "Yes" : "No"}` (line ~56) and its wrapper element if the line is the only content (read the surrounding JSX).

Verify: `grep -rn "streaming" src/pages/dev/components/stt-configs/` — no matches.

- [ ] **Step 5: Typecheck and run the suite**

Run: `npx tsc --noEmit` — expected exit 0.
Run: `npx vitest run` — expected 25 files / 215 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/stt.constants.ts src/hooks/useCustomSttProviders.ts src/pages/dev/components/stt-configs/CreateEditProvider.tsx src/pages/dev/components/stt-configs/CustomProvider.tsx
git commit -m "refactor: remove dead streaming field from STT provider configs and editor"
```

---

### Task 6: Full verification pass

**Files:**
- Read-only: whole `src/` (grep verification), plus `git diff` review.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: proof the deletion is complete and clean.

- [ ] **Step 1: Verify zero streaming-STT references remain**

Run:
```bash
grep -rn "useSttStreamSocket\|streamingUrl\|partialTranscription" src/ --include="*.ts" --include="*.tsx"
```
Expected: no matches.

Run:
```bash
grep -rn "isStreaming" src/ --include="*.ts" --include="*.tsx" | grep -v "ai-"
```
Expected: no matches (AI `isStreaming`-adjacent names, if any, are in `ai-*` files and are AI-related — inspect any hit before concluding).

- [ ] **Step 2: Confirm AI streaming is intact**

Run:
```bash
grep -n "streaming: true" src/config/ai-providers.constants.ts
```
Expected: the AI presets still set `streaming: true` (5+ hits).

Run:
```bash
git diff --stat -- src/lib/functions/ai-response.function.ts
```
Expected: empty (file untouched).

- [ ] **Step 3: Run the full gate**

Run: `npx tsc --noEmit` — expected exit 0.
Run: `npx vitest run` — expected 25 files / 215 tests pass.
Run: `git diff --check` — expected exit 0.

- [ ] **Step 4: Review the cumulative diff**

Run: `git diff --stat`
Expected: only the 15 files from Tasks 1-5 changed, plus the two deletions. Any other file in the diff is a pre-existing uncommitted fix-pass change — confirm each listed file is one of: `src/pages/app/components/speech/RecordingPanel.tsx`, `ResultsSection.tsx`, `speech/index.tsx`, `src/pages/dashboard/components/TranscriptFeed.tsx`, `src/pages/dashboard/index.tsx`, `src/lib/live-session.ts`, `src/lib/live-session.test.ts`, `src/hooks/useSystemAudio.ts`, `src/types/provider.type.ts`, `src/config/stt.constants.ts`, `src/hooks/useCustomSttProviders.ts`, `src/pages/dev/components/stt-configs/CreateEditProvider.tsx`, `src/pages/dev/components/stt-configs/CustomProvider.tsx`, `src/hooks/system-audio/useSttStreamSocket.ts` (deleted), `src/hooks/system-audio/useSttStreamSocket.test.ts` (deleted). Pre-existing fix-pass files (e.g. `stt.function.ts`, `useChatCompletion.ts`, `src-tauri/**`) appearing in the diff is expected and fine — they were already uncommitted before this plan started.

- [ ] **Step 5: Report**

Report: exact vitest count (expect 215), tsc status, the grep verification results, and the list of files touched by this plan. Note the RC plan's stale gate expectations (test counts now 215, plus the earlier 32 cargo tests) for a later plan-doc revision.

**Acceptance criteria (from spec):**
1. `npx tsc --noEmit` clean
2. `npx vitest run` green at 25 files / 215 tests; socket test file deleted
3. `git diff --check` clean
4. Zero references to `useSttStreamSocket`, `streamingUrl`, `partialTranscription`, or STT-side `isStreaming` in `src/`
5. AI streaming paths unchanged (`streaming: true` presets intact, `ai-response.function.ts` untouched)
