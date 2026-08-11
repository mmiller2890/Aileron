# FluidAudio Accuracy Pipeline Design

## Objective

Improve local macOS transcription fidelity and diagnosability without changing the live transcript and AI-response contract. The work will modernize the app-owned FluidAudio bridge, preserve recurrent VAD state, replace manual resampling, expose the English and multilingual models, and provide reproducible comparisons for preprocessing and long-form behavior.

## Scope

This design includes:

- an app-owned `fluidaudio-rs` bridge pinned to FluidAudio commit `00a9aa771900ea09c485659663be31019e293e47`;
- recurrent Silero VAD state with an explicit capture-session reset;
- FluidAudio `AudioConverter` resampling for raw mono sample arrays;
- a single preprocessing pass for the primary transcription path;
- synchronized VAD defaults and sample-rate-aware duration display;
- separate raw-ASR and ITN-normalized text in every local result;
- an opt-in same-utterance raw-versus-processed comparison;
- Parakeet TDT v2 and v3 model selection;
- structured diagnostics and a file-based comparison harness;
- deterministic unit tests plus opt-in CoreML integration coverage for short, quiet-onset, consecutive, and long audio.

The default user-visible transcript remains the ITN-normalized primary result. Diagnostic variants never create transcript rows, question-gate evaluations, or AI responses.

## Dependency and Bridge Ownership

The upstream Rust bridge will be vendored at `src-tauri/vendor/fluidaudio-rs`. `src-tauri/Cargo.toml` will use a macOS-only path dependency, so fixes are reproducible and do not depend on an unpublished upstream bridge commit.

The vendored Swift package will pin the exact included FluidAudio revision rather than a moving branch. The bridge will retain only the surfaces used by Assistant: batch ASR, VAD, sample conversion, diarization, ITN, and system capability checks. APIs removed from current FluidAudio, including the old Qwen bridge surface, will not be carried forward.

The bridge will expose these concepts to Rust:

- `AsrModelVersion::{V2, V3}`;
- initialization or model switching for a requested version;
- one-shot transcription with a fresh decoder state per utterance;
- stateful VAD probability processing;
- explicit VAD stream reset;
- stateless raw-sample conversion to 16 kHz mono through `AudioConverter`;
- raw ASR text and ITN normalization as separate operations.

## VAD State and Segmentation Authority

The Swift bridge will own a `VadStreamState`. Each 4096-sample VAD call will use FluidAudio's public `processStreamingChunk`, save the returned state, and return only its probability to Rust.

FluidAudio's stream event and triggered state will not make segmentation decisions. Rust remains the sole authority for 0.5/0.35 hysteresis, pre-roll, minimum speech, silence timeout, and utterance closure. This avoids stacking two independent segmentation state machines while still carrying Silero's hidden state, cell state, and 64-sample context.

System-audio streaming VAD and microphone batch VAD use separate FluidAudio bridge instances and separate Rust locks. A batch mic inference therefore cannot make the system-audio path fall back to RMS or alter its recurrent stream state.

`start_system_audio_capture` will reset the FluidAudio VAD stream before the capture task starts. Initialization also creates a fresh state. A reset failure will stop local capture with an actionable error instead of silently carrying state from an earlier session. Non-macOS and non-FluidAudio paths remain unchanged.

## Audio Conversion and Preprocessing

The manual `resample_linear` function will be removed from the local FluidAudio path. A bridge-level free function will convert mono Float32 samples from the device rate to 16 kHz using FluidAudio's `AudioConverter`. The converter does not require ASR or VAD models and therefore will not contend on the model-state mutex.

VAD will continue receiving ungated device audio. Each 256 ms device-rate VAD block will be converted through `AudioConverter` before stateful VAD inference.

Capture will retain one raw utterance buffer. Preprocessing occurs exactly once at finalization:

1. preserve the raw segmented waveform;
2. apply the existing soft-knee noise gate once;
3. apply the existing target-RMS normalization once;
4. convert the selected variant to 16 kHz with `AudioConverter`.

The primary live path continues using the gated and normalized variant. Incremental chunk emission will use the same single-pass helper, eliminating its current second gate. The WAV sent to remote providers remains the primary processed waveform at its source sample rate.

The capture-session WAV retained for end-of-session diarization contains the ungated source-rate waveform. This is intentionally separate from the processed utterance WAV used for transcription so gate and gain tuning cannot remove speaker cues from diarization input.

No default threshold, gate curve, 10x gain cap, or soft-saturation curve changes are included. Their effect will be measured through the comparison path before changing production defaults.

## Transcription Result Contract

Local transcription commands will return a backward-compatible `text` field plus explicit diagnostic fields:

```ts
interface LocalTranscriptionResult {
  text: string;
  confidence: number;
  duration: number;
  processing_time: number;
  raw_text: string;
  normalized_text: string;
  diagnostics: {
    model_version: "v2" | "v3";
    preprocessing: "processed" | "raw";
    source_path: "utterance-cache" | "sample-ipc" | "comparison-file";
    input_duration_ms: number;
    input_sample_rate: number;
    converted_sample_count: number;
    transcription_ms: number;
    itn_applied: boolean;
  };
  comparison?: {
    raw_text: string;
    normalized_text: string;
    diagnostics: LocalTranscriptionResult["diagnostics"];
  };
}
```

The existing `text`, `confidence`, `duration`, and `processing_time` keys remain unchanged. New JSON keys use snake case to match the current Rust command contract. `text` equals `normalized_text`. If native ITN is unavailable or normalization fails, `normalized_text` equals `raw_text` and `itn_applied` is false without failing transcription.

The frontend consumes only `text` for normal behavior. In development builds, it logs one structured diagnostic object. Diagnostic content remains local and no audio is written to disk by live comparison mode.

## Opt-In Same-Utterance Comparison

`VadConfig` will gain `compare_preprocessing`, defaulting to `false`. The speech settings panel will expose it as a developer-facing accuracy diagnostic.

The setting is snapshotted when capture starts, so a change applies to the next capture session. Because the two ASR passes are sequential, the UI will warn that enabling it roughly doubles local transcription latency.

When disabled, capture stores only the processed 16 kHz samples, preserving current memory and latency characteristics. When enabled, the utterance cache stores both variants derived from the same raw segment:

- primary: one noise-gate pass plus normalization;
- comparison: no gate and no normalization.

The local transcription command runs the primary result first, then the comparison result with the same loaded model. Only the primary result flows into transcript state and the question gate. The comparison is returned inside the primary result and logged for inspection. Failure of the comparison does not discard a successful primary transcription.

The comparison mode is local-FluidAudio-only. Remote providers receive one processed WAV and never receive a diagnostic duplicate request.

## ASR Model Selection

The Local FluidAudio provider settings will show a constrained selector:

- `v2 — English, highest recall`;
- `v3 — Multilingual, 25 European languages`.

The existing behavior remains compatible by defaulting missing or invalid saved values to `v3`. The selection is persisted with the local provider's variables as `MODEL`, but it is rendered as a selector rather than a free-form input.

Every local sample transcription request, including microphone dictation and recorded-audio fallback, carries the normalized selected model to Rust. Cold initialization must therefore load the selected model rather than silently defaulting those paths to v3.

`stt_init` will accept the requested model version. Status will report the loaded version. Requesting a different version replaces the ASR model set and manager while retaining independently initialized VAD and diarization state. Model changes are applied before capture begins; the settings UI will explain that the first use can download a separate model bundle.

One-shot transcription will continue creating a fresh decoder state for every utterance and every diagnostic comparison. This preserves isolation between consecutive utterances and between the primary and comparison variants.

## FluidAudio Upgrade and Long-Form Behavior

The vendored package will pin FluidAudio commit `00a9aa771900ea09c485659663be31019e293e47`, matching the included source. This brings in the post-0.14.1 long-form fixes for word-boundary splicing, duplicate collapse, seam-gap repair, final-window alignment, and authoritative merge order.

The application will retain its 30-second safety cap and 2.1-second conversational silence timeout. It will not force application-level 14-second segmentation because doing so could split one interviewer question into multiple transcript rows and AI requests. FluidAudio's upgraded sliding-window implementation will handle utterances that cross its model window.

Diagnostics will include input duration, making long-form failures identifiable without storing audio automatically.

## Repeatable File Comparison Harness

A macOS-only command-line example under `src-tauri/examples` will accept:

- an input audio file;
- `--model v2|v3`;
- `--preprocessing processed|raw|both`;
- optional ground-truth text.

It will decode the file, derive both variants from the same mono waveform, use the same bridge APIs as the application, and print JSON containing raw text, normalized text, timings, duration, and word error rate when ground truth is supplied. It will never modify the source audio.

The harness will make one-variable comparisons repeatable:

- v2 versus v3 on identical audio;
- processed versus raw on identical audio;
- short versus greater-than-15-second fixtures;
- raw ASR versus ITN output.

## Settings Corrections

The settings reset action will import or reuse the same defaults as `useVadConfig` rather than duplicating numeric values. Reset will restore `silence_chunks: 100`, `min_speech_chunks: 12`, `pre_speech_chunks: 30`, and `noise_gate_threshold: 0.0015` with the matching RMS and peak thresholds.

The backend-reported capture sample rate will be used for duration display. Before a rate is available, the UI will use the documented 48 kHz tuning rate rather than 44.1 kHz.

## Error Handling and Privacy

- Unsupported model strings fail validation before model loading.
- A requested model is reported as ready only after every required model loads.
- VAD reset failure prevents a stale-state local capture.
- Conversion failure reports the affected pipeline stage; local FluidAudio will not silently fall back to linear resampling.
- Comparison failure is diagnostic-only and cannot suppress the primary result.
- Live diagnostics do not persist audio.
- The file harness reads only the explicitly supplied path and writes results to stdout.
- Existing remote STT, Windows/Linux Whisper, microphone dictation, and diarization flows retain their current contracts unless they call the shared result parser.

## Test Strategy

All production behavior changes follow red-green TDD.

Deterministic tests will cover:

- model-version parsing and fallback;
- VAD reset on each capture start;
- probability consumption without using FluidAudio stream events;
- raw quiet onsets entering the VAD and pre-roll path before gating;
- one and only one gate application for final and incremental utterances;
- raw and processed variants sharing identical segment boundaries;
- comparison results never generating a second transcript or AI request;
- raw and normalized text preservation;
- consecutive one-shot calls receiving independent decoder states;
- settings reset matching canonical defaults;
- duration display at 48 kHz and another reported rate;
- long inputs remaining one application utterance while reaching FluidAudio's long-form path.

macOS CoreML integration tests will be opt-in because they require model bundles. Fixtures or harness scenarios will include:

- a short clear phrase;
- a quiet-onset phrase;
- two consecutive utterances;
- a sustained utterance longer than 15 seconds.

Verification will run focused Rust and TypeScript tests during each TDD cycle, followed by the complete Vitest suite, Rust tests, `npx tsc --noEmit`, `npm run build`, and `cargo check --manifest-path src-tauri/Cargo.toml`.

## Non-Goals

- Changing backchannel or question-gate behavior.
- Automatically selecting a model by detected language.
- Persisting live interview audio for diagnostics.
- Changing the default gate, normalization, VAD, or silence thresholds beyond fixing reset drift.
- Forcing application-level splits at the model window boundary.
- Sending comparison audio or text to a remote service.
