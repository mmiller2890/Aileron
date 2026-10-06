# Live Text (Streaming Transcription) — Design

**Date:** 2026-10-06
**Status:** Design approved in conversation; spec awaiting user review
**Branch:** dev
**Goal:** Show the words of the turn in progress while the person is still speaking, and start the AI response after a shorter pause, without changing where saved transcripts and AI input come from.

This is the first of two streaming projects. Live speaker labels are a separate spec and build cycle.

## Decisions already made

- **Approach:** a dedicated streaming model produces live text for display only. The current Parakeet TDT v3 batch pass still transcribes the whole utterance at the end of the turn; that text replaces the live text, is saved, and goes to the AI.
- **Language:** English only. The streaming model is an English model.
- **AI timing:** the turn ends after about 1 second of silence (was about 2.1). No speculative AI calls on partial text.
- **Order:** live text first, live speaker labels second.

## Principle

Live text is best-effort. It can never delay or block capture, the end-of-turn decision, the final transcription, or stop. If any part of it fails, the app behaves exactly as it does today.

## Scope

In scope: macOS, local speech provider, voice-detection (VAD) capture mode.

Not in scope:

- live speaker labels (second project);
- the streaming model's own end-of-utterance signal — Silero VAD stays the single authority for when a turn ends;
- remote speech providers, and manual or continuous recording;
- languages other than English;
- microphone dictation.

## Model

Parakeet EOU 120M (`FluidInference/parakeet-realtime-eou-120m-coreml`) through FluidAudio's `StreamingEouAsrManager`, **320 ms chunk variant**.

FluidAudio's published benchmark (Apple M2, LibriSpeech test-clean): 320 ms is 4.88% WER at 19x real time; 160 ms is 8.23% WER at 5.8x. The 320 ms variant gives fewer wrong words on screen for a third of the processing. Neither figure has been measured on this app's audio or the user's machine; the first implementation task is that measurement.

The worker reaches the model only through a small trait (`feed`, `reset`), so the model can be replaced — for example by Nemotron Speech Streaming 0.6B, which is more accurate and about 560 MB — without touching capture or the frontend.

## Architecture

### 1. Swift bridge (`src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`)

New functions, following the bridge's existing semaphore-wrapped pattern:

- `initializeStreamingAsr(progress)` — create the manager with `.ms320`, download and load models, report progress.
- `isStreamingAsrAvailable()`.
- `streamingAsrFeed(samples) -> String` — wrap 16 kHz mono samples in an `AVAudioPCMBuffer`, call `process`, then return the accumulated partial transcript read from the manager (`process` itself returns an empty string; the text comes from `getPartialTranscript` / the partial callback).
- `streamingAsrReset()`.

Matching C entry points, Rust FFI declarations, and safe wrappers on `FluidAudio` in `src/lib.rs`. The vendored crate version metadata is bumped.

### 2. Rust state (`src-tauri/src/stt.rs`)

`SttState` gains a `live_text` slot with its own lock, like `streaming_vad` and `mic_vad`, so live text never contends with batch ASR, VAD, or diarization for a Rust lock. New commands: `stt_init_live_text` (runs on a blocking thread, emits progress like `stt_init`) and a `live_text_ready` flag in `stt_get_status`. A failed load is reported by the command's error; finer-grained states are not needed.

### 3. Live-text worker (new module `src-tauri/src/speaker/live_text.rs`)

A dedicated OS thread, started with a capture and joined when it stops. It owns the model for the session.

- **Input:** a bounded `sync_channel` of messages: `Audio { turn, samples }` (16 kHz) and `End`. Audio carries its turn number, and the worker resets the model whenever the turn changes, so a dropped message can never attach one turn's audio to another turn's text.
- **Capture side never waits:** it uses `try_send`. When the queue is full the message is dropped and counted.
- **Queue size:** about 2 seconds of audio.
- **Output:** when the partial text changes, emit `speech-partial` with `{ turn, text }`.
- **Errors:** the first model error is emitted once as `stt-error`; the worker then discards input for the rest of the session.
- **Stop:** dropping the sender ends the worker's loop. Capture waits for it up to a deadline; on timeout the worker is left to finish on its own and is muted, so it cannot emit after the capture has stopped.

### 4. Capture loop (`run_vad_capture` in `src-tauri/src/speaker/commands.rs`)

- A per-capture turn counter. Speech start increments it.
- On speech start: send the pre-speech audio resampled to 16 kHz under the new turn number.
- On each hop while in speech: send the hop's 16 kHz samples. The loop already resamples every hop for VAD; that result is reused, not recomputed.
- On turn end, discard, or the 30-second safety cap: send `End`.
- The `speech-detected` payload gains the `turn` number. `speech-discarded` is unchanged: only one turn is in progress at a time, so a discard clears whatever provisional text is showing.
- `VadConfig` gains `live_text: bool` (default true), following the existing `compare_preprocessing` toggle. The worker starts only when it is true and the model is ready.

### 5. Frontend

- `useSystemAudio` listens for `speech-partial`, ignores events when not capturing, and holds `{ turn, text }` as provisional text. It is reset when a capture starts and stops; the muted worker guarantees nothing arrives from a previous capture.
- Provisional text is cleared when the matching `speech-detected` transcription lands, on `speech-discarded`, when a transcription is dropped as a backchannel, and on stop.
- Provisional text is shown, visually distinct from final text, in `ResultsSection` and the dashboard `TranscriptFeed` (via a `partialTranscription` field restored to `LiveSessionSnapshot`). `RecordingPanel` renders only manual-mode controls today, and live text is VAD-mode only, so it is not a surface.
- A "Live text" toggle in `SettingsPanel`, default on, stored in the VAD config.
- When the toggle is on, speech setup calls `stt_init_live_text` after `stt_init`; the speech-setup overlay shows its download progress. A failed or skipped live-text download does not block setup from completing.

## Turn flow

1. VAD detects speech. The loop sends `Start` and the lead-in audio.
2. The worker feeds 320 ms chunks to the model and emits `speech-partial` as text changes. The screen fills in.
3. After about 1 second of silence the turn ends. The loop sends `End` and emits `speech-detected` as today.
4. The batch model transcribes the utterance. Its text replaces the provisional text, is saved, and goes to the AI.

## Pause default

`silence_chunks` default changes from 100 (about 2.1 s at 48 kHz) to 45 (0.96 s; 45 sits on the settings slider's step of 5) in both `VadConfig::default()` and `DEFAULT_VAD_CONFIG`. The storage key moves from `vad_config_v2` to `vad_config_v3`, which is how this code already handles default changes. Side effect: customised voice-detection settings reset to defaults once. The setting stays adjustable in `SettingsPanel`. Microphone dictation reads the same setting, so dictated utterances also end after about 1 second of silence.

Known cost: a thinking pause longer than a second now splits one answer into two turns.

## Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Model not downloaded or fails to load | Capture starts without live text; status reports why. |
| Worker slower than real time | Queue drops audio; live text skips; finals unaffected. |
| Model error mid-session | One `stt-error`; no live text for the rest of the session. |
| Partial arrives after its turn or capture ended | Older turns are ignored by turn number; a stopped capture's worker is muted. |
| Worker blocked at stop | Join deadline, then detach; stop is not delayed further. |
| Non-English speech with live text on | Provisional text is wrong until the final replaces it; the toggle turns it off. |

## Testing

- **Rust unit tests** (worker against a fake model): partials emitted in order; reset on every `Start`; drop-on-full never blocks the sender; a dropped `End` does not leak text into the next turn; stop returns within the deadline when the model blocks; error reported once.
- **Rust unit tests** (capture loop helpers): turn numbering; `End` sent on turn end, discard, and safety cap.
- **Bridge test:** a known English recording through the real streaming model, asserting the text is close to the expected transcript. Requires the model, so it sits with the existing accuracy tests and is not in the default suite.
- **Frontend tests:** provisional text appears; is replaced by the final; is cleared on discard, backchannel, and stop; a stale turn is ignored.
- **Gates:** `cargo check`, `cargo test --lib`, `npx tsc --noEmit`, `npm run build`, `npx vitest run`.
- **Live validation by the user:** live text quality, the 1-second pause, and the `System-audio drain stall` log line, since this adds continuous inference during speech.

## Risks

- **Throughput is unmeasured here.** The 19x figure is from an M2 on clean read speech. Measuring a feed loop on the user's machine is the first task; if it is not comfortably faster than real time, stop and revisit the model choice.
- **Contention with the batch pass and diarization.** The streaming model runs through the same Swift concurrency pool as batch ASR and offline diarization. The worker's isolation means contention degrades live text only.
- **Live text quality.** About 1 word in 20 wrong on clean speech, likely worse on compressed call audio. It is replaced by the final each turn; the trait boundary allows a model swap.
- **Shorter pause.** More split turns. Adjustable, and reversible by changing one default.
