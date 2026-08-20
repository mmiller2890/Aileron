# Current FluidAudio Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every currently supported FluidAudio path behaviorally correct against exact upstream commit `8a2bf2c` and expose the diagnostics and metadata needed for reliable user testing.

**Architecture:** Keep Rust as capture/segmentation authority and Swift as the thin async FluidAudio adapter. Use one recurrent VAD stream per simultaneous audio source, a v3-only ASR contract, typed FFI error/progress channels, and backward-compatible JSON payload extensions.

**Tech Stack:** Rust 2021, Swift 6 package compiled in Swift 5 language mode, FluidAudio current main, Tauri 2, React 19, TypeScript 5.8, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-20-fluidaudio-current-integration-design.md`

## Global Constraints

- macOS 14+ and Apple Silicon remain the local FluidAudio platform floor.
- FluidAudio must be pinned to exact commit `8a2bf2c074a227b25baef2185a00faa3f6865d10`.
- Parakeet TDT v3 is the only app-supported ASR model.
- Existing remote STT and Windows/Linux behavior must remain unchanged.
- No audio is persisted except the existing managed session WAV used for offline diarization.
- Existing uncommitted user changes must be preserved; commits require a clean, explicitly reviewed staging set.

---

### Task 1: Stateful microphone VAD

**Files:**
- Modify: `src-tauri/src/speaker/commands.rs`
- Modify: `src-tauri/src/stt.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Test: `src-tauri/src/speaker/commands.rs`

**Interfaces:**
- Consumes: `FluidAudio::vad_process_streaming_samples(&[f32])` and `FluidAudio::vad_reset_stream()`.
- Produces: `SttState::mic_vad_process_streaming_samples(&[f32]) -> Result<f32, String>` and `SttState::reset_mic_vad_stream() -> Result<(), String>`.

- [x] **Step 1: Write the failing accumulator tests**

Add table-driven Rust tests proving that three short resampled hops produce no frame, the fourth produces exactly one 4096-sample frame, surplus samples remain queued, and reset clears queued samples.

- [x] **Step 2: Run the tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml speaker::commands::tests::mic_vad`

Expected: compilation fails because `VadFrameAccumulator` is not defined.

- [x] **Step 3: Implement the accumulator and dedicated mic stream**

Add `VadFrameAccumulator { samples: Vec<f32> }` with `push(&[f32]) -> Vec<[f32; 4096]>` and `clear()`. Rename the second VAD state from batch to microphone, route it through the streaming bridge API, reset it in `start_mic_dictation`, and keep the current probability until the next complete frame arrives.

- [x] **Step 4: Verify GREEN and related Rust tests**

Run the focused test, then `cargo test --manifest-path src-tauri/Cargo.toml speaker::commands::tests`.

---

### Task 2: Current upstream pin and v3-only contract

**Files:**
- Modify: `src-tauri/vendor/fluidaudio-rs/Package.swift`
- Modify: `src-tauri/vendor/fluidaudio-rs/Cargo.toml`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Modify: `src-tauri/src/stt.rs`
- Modify: `src/lib/fluidaudio-model.ts`
- Modify: `src/pages/dev/components/stt-configs/Providers.tsx`
- Test: `src-tauri/src/stt.rs`
- Test: `src/lib/fluidaudio-model.test.ts`

**Interfaces:**
- Produces: frontend `FluidAudioModel = "v3"`; backend accepts only absent or `"v3"` model input.

- [x] **Step 1: Write failing frontend and Rust tests**

Assert that missing, `v2`, and arbitrary persisted values normalize to `v3`; assert that Rust accepts `v3` and rejects explicit `v2`.

- [x] **Step 2: Verify RED**

Run the focused Vitest file and `cargo test --manifest-path src-tauri/Cargo.toml stt::tests::model`.

- [x] **Step 3: Implement v3-only behavior and exact pin**

Remove the v2 selector option, normalize stale frontend values to v3, reject v2 at the Tauri boundary, remove unused v2 bridge initialization, pin `8a2bf2c074a227b25baef2185a00faa3f6865d10`, and update vendored bridge version metadata.

- [x] **Step 4: Build the bridge against the exact pin**

Run: `cargo check --manifest-path src-tauri/vendor/fluidaudio-rs/Cargo.toml`.

---

### Task 3: Bridge safety, errors, and dead surfaces

**Files:**
- Modify: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Test: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`

**Interfaces:**
- Produces: `FluidAudioBridge: Send` without `Sync`; `last_error_message(fallback: &str) -> String` used after every failed active FFI call.

- [x] **Step 1: Write failing Rust tests for error selection**

Test that a non-empty Swift detail wins over the fallback and that missing/empty details use the operation-specific fallback.

- [x] **Step 2: Verify RED**

Run: `cargo test --manifest-path src-tauri/vendor/fluidaudio-rs/Cargo.toml ffi::bridge::tests`.

- [x] **Step 3: Implement the FFI error channel**

Store the last error on the Swift bridge, expose an allocated C string getter, consume/free it in Rust, replace generic failures on all active ASR/VAD/diarization/ITN/conversion operations, and remove `unsafe impl Sync`.

- [x] **Step 4: Remove inactive Swift surfaces**

Delete the unused decoder-state property, obsolete streaming-ASR manager/methods/C exports, and disabled Qwen implementation while retaining active public symbols.

- [x] **Step 5: Verify bridge tests and compile**

Run the vendored crate tests and `cargo check --manifest-path src-tauri/Cargo.toml`.

---

### Task 4: Preserve FluidAudio result metadata

**Files:**
- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Modify: `src-tauri/src/stt.rs`
- Modify: `src/lib/functions/stt.function.ts`
- Modify: `src/hooks/system-audio/useSpeakerLabels.ts`
- Modify: `src/hooks/useSystemAudio.ts`
- Test: `src/lib/functions/stt.function.test.ts`
- Test: `src/hooks/system-audio/useSpeakerLabels.test.ts`

**Interfaces:**
- Produces: token timings `{ token, token_id, start_time, end_time, confidence }[]` and diarization `quality_score` in Tauri JSON.

- [x] **Step 1: Write failing parser and speaker-selection tests**

Assert token-timing preservation and prove that a zero-quality diarization segment cannot label an utterance while the highest-overlap usable segment can.

- [x] **Step 2: Verify RED**

Run the two focused Vitest files.

- [x] **Step 3: Extend the active FFI result contract**

Return token timing data with each one-shot ASR result, free every allocated timing array/string, serialize it from Rust, retain diarization quality, and update TypeScript types/parsers.

- [x] **Step 4: Verify GREEN**

Run focused tests, `npx tsc --noEmit`, and the complete Vitest suite.

---

### Task 5: Model initialization progress and final verification

**Files:**
- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Modify: `src-tauri/src/stt.rs`
- Modify: `src/components/SttInitOverlay.tsx`
- Modify: `src/hooks/useSttStatus.ts`
- Test: `src/hooks/useSttStatus.test.ts`

**Interfaces:**
- Produces: Tauri `stt-model-progress` payload `{ fraction_completed, phase, model_name? }` and actionable initialization errors.

- [x] **Step 1: Write failing frontend progress-state tests**

Assert monotonic progress rendering, phase text for download/compile, and reset on ready/error.

- [x] **Step 2: Verify RED**

Run the focused Vitest file.

- [x] **Step 3: Wire FluidAudio `ProgressHandler` through FFI to Tauri**

Pass a synchronous-lifetime Rust callback/context into v3 initialization, translate FluidAudio download phases, emit Tauri progress events, and render them in the existing initialization overlay.

- [x] **Step 4: Run complete automated verification**

Run `npm test`, `npx tsc --noEmit`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `cargo check --manifest-path src-tauri/Cargo.toml`.

- [x] **Step 5: Prepare the user testing checklist**

Report exact automated results and request model-backed checks for quiet-onset microphone speech, simultaneous mic/system capture, 30-second v3 speech, two-speaker diarization, ITN, and a clean-cache model download.

## Completion Record

Completed against exact upstream revision `8a2bf2c074a227b25baef2185a00faa3f6865d10` on 2026-08-20.

- Vendored bridge: 3 unit/native tests and 3 doc tests passed, including real bridge creation and system-information calls.
- Tauri Rust: 75 tests passed; 6 model-backed acceptance tests compiled and remain intentionally ignored until fixtures and local CoreML models are supplied.
- TypeScript: `npx tsc --noEmit` passed.
- Frontend: 34 files and 262 tests passed.
- Production: `npm run build` passed with only the existing Node deprecation and chunk-size notices.
- Rust compile: `cargo check --manifest-path src-tauri/Cargo.toml` passed without code warnings.
- Source hygiene: changed Rust files are rustfmt-clean, `git diff --check HEAD` passed, Swift/Rust active FFI symbol sets match, and the bridge is `Send` without `Sync`.

Model-backed user acceptance should cover quiet-onset microphone speech, simultaneous microphone/system capture, speech longer than 15 seconds, consecutive utterances, streaming VAD reset determinism, two-speaker diarization quality, English ITN, device-change session boundaries, and a clean-cache v3 model download with visible progress.
