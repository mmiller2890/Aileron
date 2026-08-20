# Current FluidAudio Integration Design

## Objective

Bring Assistant's app-owned FluidAudio bridge into behavioral and API alignment with the current upstream project while retaining the tested Parakeet TDT v3 batch-transcription workflow.

## Supported surface

Assistant supports these FluidAudio capabilities on macOS Apple Silicon:

- Parakeet TDT v3 one-shot ASR;
- recurrent Silero VAD for system audio and microphone dictation;
- FluidAudio sample conversion to 16 kHz mono;
- inverse text normalization for English transcripts;
- offline speaker diarization;
- model initialization status, progress, and actionable errors;
- ASR token timing and diarization quality metadata.

Parakeet v2, Qwen, TTS, experimental VAD/diarization backends, and the old Swift streaming-ASR bridge are not supported. Live partial transcription remains a separately designed future feature.

## Upstream dependency

The Swift package pins exact FluidAudio commit `8a2bf2c074a227b25baef2185a00faa3f6865d10`. A moving branch is not allowed. The vendored Rust crate version metadata must identify the actual app-owned bridge rather than imply that its Swift dependency is FluidAudio 0.14.1.

## VAD behavior

System audio and microphone dictation use distinct FluidAudio instances and distinct recurrent `VadStreamState` values. Both paths feed exactly 4096 samples at 16 kHz to `processStreamingChunk`. Rust remains the segmentation authority and applies the existing 0.5/0.35 hysteresis, pre-roll, minimum-speech, and silence rules.

Each capture or dictation start resets only its own VAD stream. A short device-rate hop is resampled and appended to a 16 kHz accumulator; no short hop is passed to FluidAudio's stateless batch `process(_:)` API.

## ASR and language behavior

All app paths request v3. Missing, stale v2, or invalid frontend settings normalize to v3. Backend commands reject unsupported model identifiers rather than downloading another model set.

One-shot transcription creates a fresh decoder state for each utterance. English is the default language hint because the app's ITN surface is English-oriented. The result retains raw text, normalized text, confidence, duration, processing time, and token timings. ITN failure never suppresses a successful transcript.

## Diarization behavior

Offline diarization runs on the ungated full-session WAV. The response retains `speaker_id`, start/end time, and `quality_score`. Transcript labeling selects the greatest-overlap speaker only when the winning segment has usable quality; otherwise it leaves the utterance unlabeled. The bridge may accept optional speaker-count constraints in a future UI, but no fixed speaker count is forced by default.

## Bridge safety and diagnostics

The Rust bridge is `Send` but not `Sync` unless it owns real serialization. Swift error details cross the FFI boundary and replace generic `-1` messages. Model initialization reports download and compilation progress to Tauri without persisting audio or contacting any service other than FluidAudio's configured model host.

The Swift bridge contains only active batch ASR, VAD, conversion, diarization, ITN, and system-information symbols. Unused streaming and disabled Qwen surfaces are removed.

## Verification

Every behavior change follows red-green TDD. Required automated gates are focused Rust/TypeScript tests, the complete Vitest suite, `npx tsc --noEmit`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `cargo check --manifest-path src-tauri/Cargo.toml`. Current upstream compatibility is additionally checked by building the vendored wrapper against the pinned commit. Model-backed runtime testing is handed to the user only after automated gates pass.
