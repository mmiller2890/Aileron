# FluidAudio Accuracy Pipeline Implementation Plan

**Status:** Implemented and review-hardened in the uncommitted worktree on 2026-08-10. The eventual commit must include `src-tauri/vendor/fluidaudio-rs`; the separate `FluidAudio/` reference checkout is intentionally ignored. Frontend, Rust, runtime ITN, binary-symbol, and all-target compile checks pass. The opt-in CoreML acoustic cases compile but were not run because fixture WAVs were not supplied.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Modernize Assistant's local FluidAudio integration so transcription uses recurrent VAD state, high-quality resampling, selectable v2/v3 ASR, observable preprocessing, and current long-form decoding fixes.

**Architecture:** Vendor a focused Rust/Swift bridge pinned to FluidAudio commit `00a9aa771900ea09c485659663be31019e293e47`. Keep segmentation authority in Rust while Swift carries Silero model state, centralize capture preprocessing around one raw utterance buffer, and return structured local-only diagnostics without creating duplicate transcript or AI events.

**Tech Stack:** Rust 2021, Swift 6/SwiftPM, FluidAudio/CoreML/AVFoundation, Tauri 2, React 19, TypeScript 5.8, Vitest.

## Global Constraints

- macOS 14+ on Apple Silicon remains the support floor for local FluidAudio.
- FluidAudio must be pinned to exact commit `00a9aa771900ea09c485659663be31019e293e47`.
- Rust remains the only segmentation and hysteresis authority.
- Live comparison mode never persists audio or creates a second transcript/AI request.
- Missing or invalid saved model values default to `v3` for backward compatibility.
- Existing remote STT and Windows/Linux local Whisper behavior must not change.
- Preserve all pre-existing working-tree changes. Do not stage or commit during this plan because overlapping files already contain user-authored modifications.
- Production code contains no new comments unless an existing comment must be corrected for changed behavior.

---

### Task 1: Vendor and Compile the Focused Bridge

**Files:**

- Create: `src-tauri/vendor/fluidaudio-rs/Cargo.toml`
- Create: `src-tauri/vendor/fluidaudio-rs/build.rs`
- Create: `src-tauri/vendor/fluidaudio-rs/Package.swift`
- Create: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Create: `src-tauri/vendor/fluidaudio-rs/src/ffi/mod.rs`
- Create: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Create: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Create: `src-tauri/vendor/fluidaudio-rs/THIRD_PARTY_NOTICE.md`
- Modify: `src-tauri/Cargo.toml:59-71`
- Modify: `src-tauri/Cargo.lock`

**Interfaces:**

- Consumes: FluidAudio Swift package at exact revision `00a9aa771900ea09c485659663be31019e293e47`.
- Produces: the existing `fluidaudio_rs::FluidAudio` surface needed by `src-tauri/src/stt.rs`, with obsolete Qwen/TTS bridge code removed.

- [x] **Step 1: Record the clean compile expectation**

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: the current external bridge configuration passes or exposes only pre-existing warnings; save the exit status as the baseline.

- [x] **Step 2: Mechanically vendor only build and library sources**

Copy the pinned Cargo checkout's `Cargo.toml`, `build.rs`, `Package.swift`, `src/`, and `swift/` into `src-tauri/vendor/fluidaudio-rs`. Do not copy `.git`, examples, target artifacts, or fixtures. Add a notice naming the MIT upstream project and pinned upstream bridge commit `2d1083314104c812944b5150866d1e334db8eed7`.

- [x] **Step 3: Pin the current FluidAudio revision and remove obsolete Swift surfaces**

Set the Swift dependency to:

```swift
.package(
    url: "https://github.com/FluidInference/FluidAudio.git",
    revision: "00a9aa771900ea09c485659663be31019e293e47"
)
```

Retain batch ASR, VAD, diarization, ITN, conversion, and system-info exports. Remove bridge declarations that reference FluidAudio APIs absent at the pinned revision.

- [x] **Step 4: Point Assistant at the path dependency**

Use:

```toml
fluidaudio-rs = { path = "vendor/fluidaudio-rs" }
```

Regenerate the lockfile through Cargo rather than editing dependency checksums manually.

- [x] **Step 5: Verify the vendored baseline compiles**

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS. Resolve only API drift required by the exact FluidAudio pin.

### Task 2: Add Model-Version Selection and Independent One-Shot Results

**Files:**

- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Modify: `src-tauri/src/stt.rs`
- Test: `src-tauri/src/stt.rs`

**Interfaces:**

- Produces: `AsrModelVersion::{V2, V3}`, `AsrModelVersion::parse(&str)`, `FluidAudio::init_asr_version(version)`, status field `model_version`, and raw/normalized result fields.
- Preserves: `FluidAudio::init_asr()` as a v3-compatible convenience method and a fresh `TdtDecoderState` per transcription.

- [x] **Step 1: Write failing Rust tests for version parsing**

Add these tests:

```rust
#[test]
fn parses_supported_asr_model_versions() {
    assert_eq!(AsrModelVersion::parse("v2"), Ok(AsrModelVersion::V2));
    assert_eq!(AsrModelVersion::parse("v3"), Ok(AsrModelVersion::V3));
}

#[test]
fn rejects_unknown_asr_model_versions() {
    assert!(AsrModelVersion::parse("turbo").is_err());
}
```

- [x] **Step 2: Run the tests and verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml stt:: --lib
```

Expected: FAIL because the model-version API is missing.

- [x] **Step 3: Implement the bridge model enum and initializer**

Map Rust `V2/V3` to Swift `AsrModelVersion.v2/.v3`, call `AsrModels.downloadAndLoad(version:)`, and replace only the ASR manager/models. Preserve VAD and diarization managers. Record the loaded version only after loading succeeds.

- [x] **Step 4: Make `stt_init` version-aware**

Change the command contract to accept `model_version: Option<String>`. Missing input resolves to `v3`. Initialization is a no-op only when the same version is already ready; selecting another version reloads ASR.

- [x] **Step 5: Preserve raw and normalized text**

Build local result JSON with existing keys plus:

```rust
"raw_text": result.text,
"normalized_text": normalized_text,
"diagnostics": {
    "model_version": model_version,
    "itn_applied": normalized_text != result.text,
}
```

Keep `text == normalized_text`, `confidence`, `duration`, and `processing_time`.

- [x] **Step 6: Verify GREEN**

Run the focused Rust tests and `cargo check`. Expected: PASS.

### Task 3: Carry and Reset Recurrent VAD State

**Files:**

- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Modify: `src-tauri/src/stt.rs`
- Modify: `src-tauri/src/speaker/commands.rs`
- Test: `src-tauri/src/stt.rs`
- Test: `src-tauri/src/speaker/commands.rs`

**Interfaces:**

- Produces: `FluidAudio::vad_process_streaming_samples(&[f32]) -> Result<VadFrame, _>` and `FluidAudio::vad_reset_stream()`.
- Consumes: exactly one 4096-sample 16 kHz chunk per call.

- [x] **Step 1: Write failing orchestration tests**

Extract a small capture-start reset boundary that accepts a fake VAD controller. Test that reset occurs before the capture task begins and that reset errors are returned rather than ignored.

- [x] **Step 2: Verify RED**

Run the named reset tests. Expected: FAIL because no reset boundary exists.

- [x] **Step 3: Implement stateful Swift VAD processing**

Store `VadStreamState?` beside `VadManager`. Initialization and reset assign `manager.makeStreamState()`. Processing calls:

```swift
let result = try await manager.processStreamingChunk(samples, state: state)
self.vadStreamState = result.state
return result.probability
```

Do not export or consume FluidAudio's stream event.

- [x] **Step 4: Add Rust FFI and session reset**

Expose one probability frame and a reset function. Call reset from `start_system_audio_capture` before constructing/spawning the VAD capture task whenever local FluidAudio VAD is initialized.

- [x] **Step 5: Keep Rust hysteresis authoritative**

Replace the old vector/max call with the stateful probability call. Leave `silero_is_speech` unchanged.

- [x] **Step 6: Verify GREEN**

Run the focused tests and `cargo check`. Expected: PASS.

### Task 4: Replace Manual Resampling and Centralize Preprocessing

**Files:**

- Create: `src-tauri/src/speaker/preprocessing.rs`
- Modify: `src-tauri/src/speaker/mod.rs`
- Modify: `src-tauri/src/speaker/commands.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Test: `src-tauri/src/speaker/preprocessing.rs`
- Test: `src-tauri/src/speaker/commands.rs`

**Interfaces:**

- Produces: `fluidaudio_rs::resample_samples(samples, input_rate) -> Result<Vec<f32>, _>` and `prepare_utterance(raw, threshold) -> PreparedUtterance`.
- `PreparedUtterance` contains source-rate `raw` and `processed` waveforms. Conversion to 16 kHz occurs after variant selection.

- [x] **Step 1: Write failing preprocessing tests**

Cover identity of the raw variant, exact existing gate/normalization math for the processed variant, empty input, and a sub-threshold sample proving only one gate application:

```rust
#[test]
fn processed_variant_applies_the_gate_once() {
    let raw = vec![0.00075];
    let prepared = prepare_utterance(&raw, 0.0015);
    let once = apply_noise_gate(&raw, 0.0015);
    let twice = apply_noise_gate(&once, 0.0015);
    assert_ne!(prepared.processed, twice);
}
```

Use a multi-sample fixture with sufficient RMS so normalization expectations are stable.

- [x] **Step 2: Verify RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml preprocessing --lib
```

Expected: FAIL because the module/helper does not exist.

- [x] **Step 3: Expose FluidAudio `AudioConverter.resample` as a free bridge function**

The function creates its own converter, accepts mono Float32 plus source rate, returns an owned Float32 array, and does not acquire ASR/VAD state.

- [x] **Step 4: Move gate and normalization into the preprocessing module**

Use one helper for finalized utterances and incremental chunks. Keep the existing threshold, target RMS `0.1`, gain cap `10.0`, and soft-saturation formula.

- [x] **Step 5: Retain raw capture buffers and preprocess only at emission**

VAD and pre-roll operate on raw samples. At each emission boundary derive processed samples once. Remove `resample_linear` and all second gate calls from the local path. Conversion errors emit an actionable pipeline error and do not fall back to manual resampling.

- [x] **Step 6: Verify GREEN**

Run preprocessing tests, all speaker command tests, and `cargo check`. Expected: PASS.

### Task 5: Add Same-Utterance Comparison and Structured Diagnostics

**Files:**

- Modify: `src-tauri/src/stt.rs`
- Modify: `src-tauri/src/speaker/commands.rs`
- Modify: `src/lib/functions/stt.function.ts`
- Modify: `src/hooks/useSystemAudio.ts`
- Modify: `src/hooks/system-audio/useVadConfig.ts`
- Test: `src-tauri/src/stt.rs`
- Test: `src/lib/functions/stt.function.test.ts`
- Test: `src/hooks/useSystemAudio.test.ts` or closest existing system-audio test file

**Interfaces:**

- `CachedUtterance` stores primary samples plus optional comparison samples and capture metadata.
- `VadConfig.compare_preprocessing` defaults to false.
- `LocalTranscriptionResult` follows the approved design's snake-case JSON contract.

- [x] **Step 1: Write failing cache/result tests**

Test that comparison samples are claimed with the same utterance, the primary result succeeds when comparison fails, and diagnostics identify `utterance-cache`, duration, sample rate, model, preprocessing, converted count, and timing.

- [x] **Step 2: Write failing frontend routing test**

Given one result containing a comparison, assert that `fetchSTT` returns only `text` to its caller while emitting/logging one diagnostic object and never invokes STT a second time from JavaScript.

- [x] **Step 3: Verify RED**

Run the named Rust and Vitest cases. Expected: FAIL because comparison metadata is absent.

- [x] **Step 4: Extend capture/cache metadata**

When comparison is disabled, convert/cache only processed samples. When enabled, convert/cache processed and raw variants from the same segment boundaries. Store source sample rate and source duration.

- [x] **Step 5: Transcribe primary then optional comparison**

Use fresh decoder state for each call. Return the primary result immediately if no comparison exists. If comparison fails, attach a diagnostic error without replacing primary text.

- [x] **Step 6: Integrate frontend diagnostics**

Keep the normal `fetchSTT` return type as text for compatibility. In development, log one structured diagnostic object. Do not route comparison text to `setLastTranscription`, transcript append, backchannel filtering, or question detection.

- [x] **Step 7: Verify GREEN**

Run focused Rust/Vitest tests, then the full Vitest suite. Expected: PASS.

### Task 6: Correct Settings and Add Local Model/Comparison Controls

**Files:**

- Modify: `src/hooks/system-audio/useVadConfig.ts`
- Modify: `src/hooks/useSystemAudio.ts`
- Modify: `src/pages/app/components/speech/index.tsx`
- Modify: `src/pages/app/components/speech/SettingsPanel.tsx`
- Modify: `src/pages/dev/components/stt-configs/Providers.tsx`
- Modify: `src/contexts/app.context.tsx`
- Modify: `src/hooks/useSttStatus.ts`
- Test: `src/hooks/system-audio/useVadConfig.test.ts`
- Test: `src/pages/app/components/speech/SettingsPanel.test.tsx`
- Test: `src/pages/dev/components/stt-configs/Providers.test.tsx`

**Interfaces:**

- Exports: `DEFAULT_VAD_CONFIG` and `vadDurationSeconds(config, sampleRate)`.
- Local provider variable: `MODEL: "v2" | "v3"`.
- `useSttStatus.init(modelVersion)` initializes or switches the requested model.

- [x] **Step 1: Write failing defaults/duration tests**

Assert reset uses the exported defaults and:

```ts
expect(vadDurationSeconds(config, 48_000)).toBeCloseTo(2.133, 3);
expect(vadDurationSeconds(config, 44_100)).toBeCloseTo(2.322, 3);
```

- [x] **Step 2: Write failing model selector tests**

Assert Local FluidAudio renders only v2/v3 choices, missing values display v3, and selecting v2 persists `MODEL: "v2"` without affecting other providers.

- [x] **Step 3: Verify RED**

Run the named Vitest files. Expected: FAIL on duplicated defaults, fixed 44.1 kHz math, and missing selector.

- [x] **Step 4: Export and reuse canonical defaults**

Delete the SettingsPanel numeric reset copy. Add `compare_preprocessing: false`. Track capture sample rate from the `capture-started` event payload and pass it to SettingsPanel; use 48 kHz before capture supplies a rate.

- [x] **Step 5: Add constrained model selection**

Render the selector only for `local-fluidaudio`. Preserve v3 for missing/invalid saved values. Pass the selected model to `stt_init`; if status reports another loaded model, switch before capture begins.

- [x] **Step 6: Add comparison control**

Expose an advanced switch explaining that it doubles local transcription work, remains local, and does not add transcript rows.

- [x] **Step 7: Verify GREEN**

Run focused Vitest, full Vitest, and `npx tsc --noEmit`. Expected: PASS.

### Task 7: Build the Repeatable Comparison Harness

**Files:**

- Create: `src-tauri/examples/compare_fluidaudio.rs`
- Create: `src-tauri/src/stt_diagnostics.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/stt_diagnostics.rs`

**Interfaces:**

- CLI: `cargo run --manifest-path src-tauri/Cargo.toml --example compare_fluidaudio -- <audio> --model v2|v3 --preprocessing processed|raw|both [--ground-truth <text>]`.
- Output: one JSON document on stdout; progress and download messages remain on stderr.

- [x] **Step 1: Write failing WER/argument tests**

Test zero WER for equal normalized strings, insertions/deletions/substitutions, empty reference handling, accepted model/preprocessing values, and rejection of unsupported values.

- [x] **Step 2: Verify RED**

Run the focused Rust tests. Expected: FAIL because the harness support does not exist.

- [x] **Step 3: Implement shared WER and argument parsing**

Implement public `word_error_rate(reference, hypothesis)` and private argument parsing in `stt_diagnostics.rs`. Use whitespace tokenization and Levenshtein distance. Report `null` WER when ground truth is omitted, `0.0` when both strings are empty, and `1.0` when the reference is empty but the hypothesis is not.

- [x] **Step 4: Implement read-only comparison execution**

Decode the explicit input file, derive variants through the same preprocessing and bridge APIs as live capture, transcribe with the requested model, and serialize raw/normalized results plus diagnostics. Never rewrite the input file.

- [x] **Step 5: Verify GREEN without forcing model downloads**

Run unit tests and `cargo check --examples`. Run an actual CoreML fixture only if required models are already present; otherwise document the exact opt-in command.

### Task 8: Add Accuracy Regression Scenarios and Complete Verification

**Files:**

- Modify: focused Rust/TypeScript tests created above
- Create: `src-tauri/tests/fluidaudio_accuracy.rs`

**Interfaces:**

- Produces: deterministic regression coverage for orchestration and opt-in CoreML scenarios for acoustic quality.

- [x] **Step 1: Add deterministic scenario tests**

Cover:

- short utterances survive minimum-length and conversion boundaries;
- quiet raw onsets reach VAD/pre-roll before gating;
- two consecutive utterances reset decoder state and do not share comparison results;
- greater-than-15-second input remains one application utterance and reports its full duration.

- [x] **Step 2: Add ignored CoreML integration cases**

Create four explicit `#[ignore]` integration tests in `src-tauri/tests/fluidaudio_accuracy.rs`: short clear speech, quiet onset, consecutive audio, and a greater-than-15-second fixture. Each test checks its required fixture path and preinstalled model cache before invoking CoreML; it must fail with an actionable prerequisite message when run explicitly and must not download during the normal unit suite.

- [x] **Step 3: Run complete verification**

Run:

```bash
npm test
npx tsc --noEmit
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --examples
```

Expected: every command exits 0. Report any environment-only ignored CoreML scenarios separately; do not claim they ran.

- [x] **Step 4: Audit the final diff and privacy constraints**

Confirm no audio fixtures, model binaries, credentials, `.build`, `target`, or nested `.git` directories were added. Confirm comparison output has only one frontend transcript/AI path and live comparison writes no audio files.
