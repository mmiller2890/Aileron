# Remove the Dead Streaming-STT Path — Design

**Date:** 2026-08-03
**Status:** Approved design (user verified all claims against the code)
**Branch:** dev
**Goal:** Delete the unreachable streaming-STT feature (socket hook, coordination flags, partial-transcript UI plumbing, and the misleading editor toggle) before the 0.1.9 RC tag, without touching AI streaming or the batch VAD→transcript flow.

## Background

The app has a fully built streaming-STT feature (WebSocket session mechanics, partial transcripts, final-transcript handoff) that is unreachable: `openStreamingSocket()` early-returns unless a provider declares `streaming: true`, and every STT preset force-sets `streaming: false` (all 11 in `src/config/stt.constants.ts`; custom STT providers are force-overridden in `useCustomSttProviders.ts` with the comment "it will be fixed in the future"). It has been dead since the fork's initial commit (`cc9a717`). Neither local backend (fluidaudio-rs batch CoreML, faster-whisper batch HTTP) supports true streaming.

**Decision:** Delete the dead path. Git history (`cc9a717`) preserves the code if streaming ever gets a real backend. A live-partials feature would require a cloud WebSocket provider (contradicts local-first) or whisper pseudo-streaming (heavy CPU, poor quality) — neither is worth shipping for this RC.

## Verified facts (driving the scope)

- **`streaming?: boolean` on `TYPE_PROVIDER` is shared with AI providers** — `src/lib/functions/ai-response.function.ts:170,255` reads it to select SSE vs. non-streaming; all AI presets set `streaming: true`. **KEEP.**
- **`streamingUrl?: string` (`src/types/provider.type.ts:13`) is only read by `useSttStreamSocket.ts:27-28`** — safe to delete from the type.
- **`LiveSessionSnapshot` carries two dead fields** — `partialTranscription: string` (live-session.ts:39) and `isStreaming: boolean` (live-session.ts:40), both fed only from the dead hook. **Both go**, or `isStreaming` ships as a permanent-false lie.
- **The STT editor streaming toggle is a lie** — `src/pages/dev/components/stt-configs/CreateEditProvider.tsx:176-191` writes `streaming: true/false` into provider config, but `useCustomSttProviders.ts` force-overrides it to `false` on load/save, and the socket hook gates on `streamingUrl` (never set), not `streaming`. Removing the toggle is correct.
- **Coordination flags are dead** — `streamingFinalizedRef` is only read when the streaming path fires (impossible); `batchProcessedForCurrentUtteranceRef` is only read inside the never-called `onFinalTranscriptRef` callback (`useSystemAudio.ts:773`).
- **No `captureStartedRef` exists** — the final trace came up empty; nothing else to remove.
- **Only `useSystemAudio.ts` imports the hook** — `isActiveStreamingSession`/`buildStreamingUrl` have no other consumers outside the socket hook's own test file.

## What survives

- AI SSE streaming (`streaming: true` on AI presets, `ai-response.function.ts` stream loop, `reasoning-effort.test.ts`)
- AI config editor streaming toggle (`src/pages/dev/components/ai-configs/CreateEditProvider.tsx` — unrelated to STT)
- `TranscriptFeed` `live` mode and `liveAnswerDraft` (AI answer streaming)
- Batch VAD→transcript flow and its duplicate-transcript prevention (`UtteranceStore`/claim, `recentSpeechEventsRef`)
- `src/hooks/useCustomProvider.ts` streaming handling (AI providers)

## Files to DELETE (2)

1. `src/hooks/system-audio/useSttStreamSocket.ts` — hook + `isActiveStreamingSession` + `buildStreamingUrl`
2. `src/hooks/system-audio/useSttStreamSocket.test.ts`

## Files to EDIT (13)

1. **`src/hooks/useSystemAudio.ts`** — remove:
   - import of `useSttStreamSocket` (line 26)
   - `onFinalTranscriptRef` ref (line 211) and its assignment block (lines ~761-800, the "streaming provider produced a final transcript" handler)
   - `useSttStreamSocket` destructure + call (lines 213-220)
   - `openStreamingSocket()`/`closeStreamingSocket()` calls (256, 266, 305, 480-484, 1128, 1193)
   - `sendAudioChunk(event.payload as string)` (313) — the whole branch it lives in goes with the socket
   - the `streamingFinalizedRef` check + `closeStreamingSocket()` + `batchProcessedForCurrentUtteranceRef.current = true` in the speech-detected handler (339-346)
   - flag resets (481-482, 1197-1198)
   - `partialTranscription`/`isStreaming` from all return sites (1253-1264, 1418-1419, 1448-1449, 1554-1555)
2. **`src/types/provider.type.ts`** — remove `streamingUrl?: string` (line 13). **Keep `streaming?: boolean`** (line 12).
3. **`src/config/stt.constants.ts`** — remove `streaming: false` from all 11 presets (lines 7, 17, 28, 41, 51, 71, 81, 91, 101, 111, 121) and any `streamingUrl` if present (none verified).
4. **`src/hooks/useCustomSttProviders.ts`** — remove force-set `streaming: false` (lines 25, 120, 129, 140, 149) and the "it will be fixed in the future" comment (120).
5. **`src/pages/dev/components/stt-configs/CreateEditProvider.tsx`** — remove the streaming toggle + its description (lines ~176-191).
6. **`src/pages/dev/components/stt-configs/CustomProvider.tsx`** — remove the "Streaming: Yes/No" readout (line 56).
7. **`src/lib/live-session.ts`** — remove `partialTranscription: string` (line 39) and `isStreaming: boolean` (line 40) from `LiveSessionSnapshot`.
8. **`src/lib/live-session.test.ts`** — remove `partialTranscription: ""` (line 25) and `isStreaming: false` (line 26) from the snapshot fixture.
9. **`src/pages/app/components/speech/index.tsx`** — remove the destructure of `partialTranscription`/`isStreaming` from `useSystemAudio` (lines 42-43) and the two prop passes (414-415 to `RecordingPanel`, 426-427 to `ResultsSection`).
10. **`src/pages/app/components/speech/RecordingPanel.tsx`** — remove the props from the interface (14-15), defaults (28-29), and the `isStreaming && partialTranscription && !isWorking && (…)` render branch (36-46).
11. **`src/pages/app/components/speech/ResultsSection.tsx`** — remove the props from the interface (14-15), defaults (27-28), and all three branches using them: early-return condition (35), `transcriptionText` selection (42), and the two `isStreaming && !lastTranscription` italic classes (87, 167).
12. **`src/pages/dashboard/components/TranscriptFeed.tsx`** — remove the `partialTranscription` prop from the interface (16, 21), destructure (54), the `!partialTranscription &&` condition (60), and the `live && partialTranscription && (…)` render block (99). **Keep `live` and `liveAnswerDraft`.**
13. **`src/pages/dashboard/index.tsx`** — remove `partialTranscription={snapshot?.partialTranscription ?? ""}` (line 111).

## Data flow after removal

- Capture start: no socket open; the speech-chunk listener feeds only the batch path.
- Speech-detected → UtteranceStore claim → batch STT (`fetchSTT`) → final transcript → answer-if-question. Unchanged.
- UI: `RecordingPanel`/`ResultsSection`/`TranscriptFeed` render from `lastTranscription`/`lastAIResponse`/`liveAnswerDraft` only. `LiveSessionSnapshot` no longer carries partial state.

## Error handling / edge cases

- `sendAudioChunk`'s base64→binary conversion and its caller branch are removed together — no half-state where a chunk handler references a deleted sender.
- `onFinalTranscriptRef` removal: the batch path's duplicate-prevention never depended on it (it was the *streaming* path's dedupe against batch).
- `RecordingPanel`/`ResultsSection` prop removal is safe because the only caller (`speech/index.tsx`) is edited in the same change; no other callers exist (verified by grep).

## Testing

- Delete `useSttStreamSocket.test.ts` (tests deleted code).
- Regression net: `speech-event-dedupe.test.ts`, `capture-session-work.test.ts`, `stt.function.test.ts`, `provider-sync.test.ts`, `live-session.test.ts` — none exercise the socket path; all must stay green.
- `npx tsc --noEmit` must be clean (catches any missed prop/field consumer).
- `npx vitest run` — expect 216 tests minus the 1 socket test (215); report exact counts.
- `git diff --check` clean. No cargo changes — Rust untouched.

## Out of scope

- AI SSE streaming, live answer drafts, batch STT — untouched.
- The `streaming` type field (AI uses it) — untouched.
- `CHUNK_POLL_INTERVAL_MS` dead constant in `chat-constants.ts` — unrelated, not in scope.

## Acceptance criteria

1. `npx tsc --noEmit` clean.
2. `npx vitest run` green; socket test file deleted; exact counts reported.
3. `git diff --check` clean.
4. No reference to `useSttStreamSocket`, `streamingUrl`, `partialTranscription`, or STT-side `isStreaming` remains in `src/` (grep-verified, excluding AI-provider `streaming` usage).
5. AI streaming paths unchanged (`streaming: true` presets intact, `ai-response.function.ts` untouched).
