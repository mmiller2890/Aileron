# Live Speaker Labels — Design

**Date:** 2026-10-06
**Status:** Design approved in conversation; spec awaiting user review
**Branch:** dev
**Goal:** Label each transcript line with its speaker as the line lands, show who is speaking on the provisional line, and remove the post-stop offline labelling run and the session recording it needs.

This is the second of two streaming projects. It builds on live text (`2026-10-06-live-text-streaming-design.md`), which is implemented.

## Decisions already made

- **Model:** Sortformer streaming diarizer (FluidAudio 0.17.4), `SortformerConfig.default`. Sessions have 1 to 3 speakers, so its 4-speaker limit is acceptable and its identity stability is the priority.
- **Approach:** feed the model during each turn; label the line when the turn ends.
- **Offline pass:** removed. Live labels are final. There is no offline fallback.
- **Names:** "Speaker 1" to "Speaker 4" in order of first appearance, reset at each capture start. Real names and cross-session identity are out of scope.

## Principle

Same as live text: speaker labels are best-effort. They can never delay or block capture, the end-of-turn decision, live text, the final transcription, or stop.

## Scope

In scope: macOS, VAD capture mode, any speech provider (labels do not depend on which model transcribes).

Not in scope: naming speakers, recognising a person across sessions, more than four speakers, labels in manual or continuous recording, microphone dictation.

## Architecture

### 1. Swift bridge

`SortformerDiarizer` is synchronous apart from model loading. New bridge functions:

- `initializeLiveDiarizer(progress)` — `SortformerModels.loadFromHuggingFace(config: .default)` with progress, then `initialize(models:)`.
- `isLiveDiarizerAvailable()`.
- `liveDiarizerReset()` — `reset()`; clears the bridge's per-turn counters.
- `liveDiarizerFeed(samples, outCounts[4])` — `addAudio` + `process()`. For every finalized frame in the update, each speaker slot whose probability is at least 0.5 gets one count in the bridge's finalized per-turn counters. The latest tentative frames are counted separately and replaced on every call. Writes finalized + tentative counts for the turn so far.
- `liveDiarizerEndTurn(outCounts[4])` — feeds 0.56 s of silence (the model's right context: 7 frames of 80 ms) so the turn's remaining frames finalize, writes the finalized counts for the turn, and zeroes the counters.

Counts are in model frames (80 ms each). Matching C entry points, Rust FFI and safe wrappers; vendored crate version bumped.

### 2. Rust state (`stt.rs`)

A `live_speakers` slot with its own lock, like `live_text`. Command `stt_init_live_speakers` (blocking thread, progress events). `stt_get_status` gains `live_speakers_ready`. An adapter implements the worker's model trait.

### 3. Speaker worker (new module `src-tauri/src/speaker/live_speakers.rs`)

Structured like the live-text worker: dedicated thread, bounded `sync_channel`, `try_send`, muted on stop, join with a deadline.

- **Model trait:** `reset()`, `feed(samples_16k) -> [u32; 4]`, `end_turn() -> [u32; 4]`.
- **Messages:** `Audio { turn, samples }`, `End { turn }`.
- **During a turn:** after each feed, the leading slot is computed; when it changes, emit `speech-speaker { turn, speaker, final: false }`.
- **At `End`:** call `end_turn`, compute the dominant slot, emit `speech-speaker { turn, speaker, final: true }`. `speaker` is `null` when no slot reaches the minimum.
- **Dominant slot rule:** the slot with the most frames, provided it has at least 3 (0.24 s); ties go to the lower slot.
- **A dropped `End`:** when audio for a new turn arrives while another is open, the worker ends the open turn itself first, so its label is still emitted and its frames cannot bleed into the next turn.
- **Reset:** once at worker start. Speaker slots persist across turns within a capture.
- **Errors:** first model error emitted once; input discarded for the rest of the session.

### 4. Capture loop

`LiveTextTurns` becomes `TurnFeeds`: one turn counter feeding both workers. `VadConfig` gains `live_speakers: bool` (default true). `start_system_audio_capture` spawns the speaker worker when the flag is on and the model is ready.

### 5. Frontend

- `src/lib/live-speakers.ts` (pure): a per-capture map from turn to `{ speaker, final }`, with `applySpeakerEvent`, `speakerForTurn`.
- `useSystemAudio`:
  - listens for `speech-speaker`; non-final events update the provisional speaker shown with live text; final events are stored by turn;
  - when a turn's message is created after transcription, it takes the stored speaker if the final has arrived;
  - when a final arrives after the message exists, the message is updated. This needs a turn → message id map, kept alongside the existing utterance records;
  - state is reset at capture start and stop.
- The provisional line in `TranscriptFeed` and `ResultsSection` shows the provisional speaker in place of "hearing" when known.
- A "Live speaker labels" toggle in `SettingsPanel`.

## Removal of the offline pass

Done as the last tasks, after live labels work:

- Frontend: the `stt_diarize_file` call at stop, `isLabelingSpeakers`, the session-audio stop action, `discardSessionAudio` and its call sites, `speakerSegments` and segment-overlap labelling (`applySpeakerLabels`, `getSpeakerForUtterance`) where nothing else uses them, the `stt_init_diarization` call.
- Rust: session recording in `run_vad_capture`, `session_recording.rs`, the session path returned from the capture task and from `stop_system_audio_capture`, `orphaned_session_path`, the stale-WAV sweep, `stt_diarize_file`, `stt_discard_session_audio`, `stt_init_diarization`, and the bridge's offline diarization functions if nothing else calls them.
- Tests for the deleted code are deleted with it.
- `stop_system_audio_capture` returns `()`.

Each removal task must leave all gates passing. Anything found to have another consumer stays, and the plan records it.

## Failure behaviour

| Situation | Behaviour |
| --- | --- |
| Model not downloaded or fails to load | Capture works with no speaker labels; lines show "heard". |
| Worker slower than real time | Queue drops audio; a turn may get a weaker or no label. |
| Model error mid-session | One `stt-error`; no labels for the rest of the session. |
| Fifth speaker | Merged into an existing slot or missed. |
| Quiet or distant speech | May get no label (the model's documented weakness). |
| Final label arrives before or after the final text | Attached by turn number either way. |

## Go/no-go measurement (first implementation task)

A probe feeds a recording of two distinct synthetic voices alternating over at least six turns, the way the app will: each turn's speech, then `end_turn`. It passes when:

- every turn of voice A gets one label and every turn of voice B gets a different one;
- steady-state processing is at least 5x real time and the worst feed step after warm-up is under 480 ms.

If it fails, implementation stops and the result is reported. Synthetic voices are an easier case than call audio; passing is necessary, not proof of quality.

## Testing

- **Rust unit tests** (worker against a fake model): dominant-slot rule including the minimum and ties; provisional events only on change; final event on `End`; an unclosed turn is ended when the next begins; reset once per worker; queue drops never block; stop within the deadline when the model blocks; error reported once.
- **Frontend tests:** label attaches when the final arrives before the message and after it; provisional speaker shows and clears; a null final leaves no label; state resets per capture.
- **Gates:** `cargo check`, `cargo test --lib`, `npx tsc --noEmit`, `npm run build`, `npx vitest run`.
- **Live validation by the user:** labels on a real two- or three-person call; stop is immediate; no `System-audio drain stall` line.

## Risks

- **Silence-cut audio.** The model was designed for a continuous timeline. Feeding speech with silences removed (plus 0.56 s of silence per turn) should work because identity is carried in its speaker cache, but it is unverified until the probe runs.
- **Three models during speech** (VAD, live text, speakers). Each worker is isolated; contention degrades live features only. The drain-stall diagnostic will show if the capture loop is affected.
- **No fallback.** With the offline pass gone, a session where the live model underperforms has poor labels and no way to recompute them.
- **Removal breadth.** The deleted code touches stop, start, and unmount paths. Staging it after the feature works, one consumer at a time, limits the blast radius.
