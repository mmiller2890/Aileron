# Live Text (Streaming Transcription) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show provisional text for the turn in progress during macOS system-audio capture, and end turns after about 1 second of silence, while the existing batch pass stays the only source of saved text and AI input.

**Architecture:** A dedicated worker thread owns FluidAudio's Parakeet EOU streaming model and receives 16 kHz audio from the capture loop through a bounded, never-blocking queue. It emits `speech-partial` events that the frontend shows as provisional text and clears when the batch transcription for that turn lands.

**Tech Stack:** Swift (FluidAudio 0.17.4 `StreamingEouAsrManager`), Rust (Tauri 2, `std::sync::mpsc`), React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-live-text-streaming-design.md`

## Global Constraints

- Live text is best-effort: it must never delay or block capture, the end-of-turn decision, the final transcription, or stop.
- Scope: macOS, local speech provider, VAD capture mode only. English only.
- Model: Parakeet EOU 120M, `.ms320` chunk variant.
- Silero VAD stays the single authority for end of turn. The streaming model's EOU signal is not used.
- `silence_chunks` default becomes 47; storage key becomes `vad_config_v3`.
- All work lands on `dev`. Do not start a dev server (`npm run tauri dev` is the user's).
- Gates before every commit that touches code: `cargo check --locked --manifest-path src-tauri/Cargo.toml`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`, `npx tsc --noEmit`, `npm run build`, `npx vitest run`.
- Match surrounding code style; no new dependencies.

## File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift` | Streaming ASR init/feed/reset and C entry points |
| `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs` | FFI declarations and unsafe wrappers |
| `src-tauri/vendor/fluidaudio-rs/src/lib.rs` | Safe `FluidAudio` methods |
| `src-tauri/examples/live_text_probe.rs` (new) | Throughput/quality probe for the streaming model |
| `src-tauri/src/speaker/live_text.rs` (new) | Model trait, worker thread, queue handle, turn tracker |
| `src-tauri/src/stt.rs` | `live_text` state slot, init command, status flag, model adapter |
| `src-tauri/src/speaker/commands.rs` | `VadConfig.live_text`, capture-loop wiring, `turn` in `speech-detected` |
| `src/lib/live-text.ts` (new) | Pure provisional-text state transitions |
| `src/hooks/system-audio/useVadConfig.ts` | `live_text` field, new pause default, storage key |
| `src/hooks/useSttStatus.ts` | `liveTextReady`, `initLiveText` |
| `src/hooks/useSystemAudio.ts` | `speech-partial` listener, clearing, init call, exported value |
| `src/lib/live-session.ts`, `src/hooks/system-audio/useLiveStatePublisher.ts` | `partialTranscription` in the snapshot |
| `src/pages/app/components/speech/ResultsSection.tsx`, `src/pages/dashboard/components/TranscriptFeed.tsx` | Show provisional text |
| `src/pages/app/components/speech/SettingsPanel.tsx` | "Live text" toggle |

---

### Task 1: Streaming ASR in the bridge, and the throughput gate

**Files:**
- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/ffi/bridge.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/src/lib.rs`
- Modify: `src-tauri/vendor/fluidaudio-rs/Cargo.toml` (version `0.17.4-assistant.2`), `src-tauri/Cargo.lock`
- Create: `src-tauri/examples/live_text_probe.rs`

**Interfaces:**
- Produces (on `fluidaudio_rs::FluidAudio`):
  - `pub fn init_streaming_asr_with_progress<F: Fn(ModelProgress) + Send + Sync>(&self, progress_callback: F) -> Result<(), FluidAudioError>`
  - `pub fn is_streaming_asr_available(&self) -> bool`
  - `pub fn streaming_asr_feed(&self, samples_16k: &[f32]) -> Result<String, FluidAudioError>` — returns the accumulated partial transcript for everything fed since the last reset
  - `pub fn streaming_asr_reset(&self) -> Result<(), FluidAudioError>`

- [ ] **Step 1: Add the Swift implementation**

In `FluidAudioBridgeInternal`, add the property `private var streamingAsrManager: StreamingEouAsrManager?` and set it to `nil` in `cleanup()`.

Extract the progress mapping that `initializeAsr` builds inline into a helper so both initialisers share it, and use it in `initializeAsr`:

```swift
    private static func makeProgressHandler(
        _ progressCallback: FluidAudioProgressCallback?,
        _ progressContext: UnsafeMutableRawPointer?
    ) -> ProgressHandler? {
        progressCallback.map { callback in
            { progress in
                let phaseCode: Int32
                let modelName: String?
                switch progress.phase {
                case .listing:
                    phaseCode = 0
                    modelName = nil
                case .downloading:
                    phaseCode = 1
                    modelName = nil
                case .compiling(let name):
                    phaseCode = 2
                    modelName = name
                }
                if let modelName {
                    modelName.withCString {
                        callback(progressContext, progress.fractionCompleted, phaseCode, $0)
                    }
                } else {
                    callback(progressContext, progress.fractionCompleted, phaseCode, nil)
                }
            }
        }
    }
```

Add after the VAD methods:

```swift
    // MARK: - Streaming ASR (live text)

    func initializeStreamingAsr(
        progressCallback: FluidAudioProgressCallback? = nil,
        progressContext: UnsafeMutableRawPointer? = nil
    ) throws {
        let semaphore = DispatchSemaphore(value: 0)
        var initError: Error?

        Task {
            do {
                let manager = StreamingEouAsrManager(chunkSize: .ms320)
                try await manager.loadModels(
                    to: nil,
                    configuration: nil,
                    progressHandler: Self.makeProgressHandler(progressCallback, progressContext)
                )
                self.streamingAsrManager = manager
            } catch {
                initError = error
            }
            semaphore.signal()
        }

        semaphore.wait()
        if let error = initError {
            throw error
        }
    }

    func isStreamingAsrAvailable() -> Bool {
        return streamingAsrManager != nil
    }

    /// Feed 16 kHz mono samples and return the transcript accumulated since
    /// the last reset.
    func streamingAsrFeed(_ samples: [Float]) throws -> String {
        guard let manager = streamingAsrManager else {
            throw BridgeError.notInitialized
        }

        let semaphore = DispatchSemaphore(value: 0)
        var text = ""
        var feedError: Error?

        Task {
            do {
                if !samples.isEmpty {
                    guard
                        let format = AVAudioFormat(
                            commonFormat: .pcmFormatFloat32,
                            sampleRate: 16_000,
                            channels: 1,
                            interleaved: false
                        ),
                        let buffer = AVAudioPCMBuffer(
                            pcmFormat: format,
                            frameCapacity: AVAudioFrameCount(samples.count)
                        ),
                        let channel = buffer.floatChannelData
                    else {
                        throw BridgeError.noResult
                    }
                    buffer.frameLength = AVAudioFrameCount(samples.count)
                    samples.withUnsafeBufferPointer { source in
                        if let base = source.baseAddress {
                            channel[0].update(from: base, count: samples.count)
                        }
                    }
                    try await manager.appendAudio(buffer)
                    try await manager.processBufferedAudio()
                }
                text = await manager.getPartialTranscript()
            } catch {
                feedError = error
            }
            semaphore.signal()
        }

        semaphore.wait()
        if let error = feedError {
            throw error
        }
        return text
    }

    func resetStreamingAsr() throws {
        guard let manager = streamingAsrManager else {
            throw BridgeError.notInitialized
        }
        let semaphore = DispatchSemaphore(value: 0)
        Task {
            await manager.reset()
            semaphore.signal()
        }
        semaphore.wait()
    }
```

Add the C entry points next to the VAD ones:

```swift
// MARK: - Streaming ASR FFI

@_cdecl("fluidaudio_initialize_streaming_asr")
public func fluidaudio_initialize_streaming_asr(
    _ ptr: UnsafeMutableRawPointer?,
    _ progressCallback: FluidAudioProgressCallback?,
    _ progressContext: UnsafeMutableRawPointer?
) -> Int32 {
    guard let ptr = ptr else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    do {
        try bridge.initializeStreamingAsr(
            progressCallback: progressCallback,
            progressContext: progressContext
        )
        return 0
    } catch {
        bridge.recordError(error)
        print("Streaming ASR init error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_is_streaming_asr_available")
public func fluidaudio_is_streaming_asr_available(_ ptr: UnsafeMutableRawPointer?) -> Int32 {
    guard let ptr = ptr else { return 0 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    return bridge.isStreamingAsrAvailable() ? 1 : 0
}

@_cdecl("fluidaudio_streaming_asr_feed")
public func fluidaudio_streaming_asr_feed(
    _ ptr: UnsafeMutableRawPointer?,
    _ samples: UnsafePointer<Float>?,
    _ count: UInt32,
    _ outText: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
    guard let ptr = ptr, let outText = outText else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    let input: [Float]
    if let samples = samples, count > 0 {
        input = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
    } else {
        input = []
    }
    do {
        let text = try bridge.streamingAsrFeed(input)
        outText.pointee = strdup(text)
        return 0
    } catch {
        bridge.recordError(error)
        return -1
    }
}

@_cdecl("fluidaudio_streaming_asr_reset")
public func fluidaudio_streaming_asr_reset(_ ptr: UnsafeMutableRawPointer?) -> Int32 {
    guard let ptr = ptr else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    do {
        try bridge.resetStreamingAsr()
        return 0
    } catch {
        bridge.recordError(error)
        return -1
    }
}
```

If the compiler rejects `try await manager.appendAudio(buffer)` because `AVAudioPCMBuffer` is not `Sendable`, build the buffer inside the actor call by adding `@preconcurrency import AVFoundation` at the top of the file (replacing the plain import). Do not change FluidAudio.

- [ ] **Step 2: Add the FFI declarations and wrappers**

In `src/ffi/bridge.rs`, inside the existing `extern "C"` block:

```rust
    fn fluidaudio_initialize_streaming_asr(
        bridge: *mut std::ffi::c_void,
        progress_callback: Option<ProgressCallback>,
        progress_context: *mut std::ffi::c_void,
    ) -> i32;
    fn fluidaudio_is_streaming_asr_available(bridge: *mut std::ffi::c_void) -> i32;
    fn fluidaudio_streaming_asr_feed(
        bridge: *mut std::ffi::c_void,
        samples: *const f32,
        count: u32,
        out_text: *mut *mut i8,
    ) -> i32;
    fn fluidaudio_streaming_asr_reset(bridge: *mut std::ffi::c_void) -> i32;
```

Move the `trampoline<F>` function out of `initialize_asr_version_with_progress` to module level as `unsafe extern "C" fn progress_trampoline<F>(...) where F: Fn(ModelProgress) + Send + Sync` (body unchanged), use it in the ASR initialiser, and add on `impl FluidAudioBridge`:

```rust
    pub fn initialize_streaming_asr_with_progress<F>(
        &self,
        progress_callback: F,
    ) -> Result<(), String>
    where
        F: Fn(ModelProgress) + Send + Sync,
    {
        let context = &progress_callback as *const F as *mut std::ffi::c_void;
        let result = unsafe {
            fluidaudio_initialize_streaming_asr(
                self.ptr,
                Some(progress_trampoline::<F>),
                context,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to initialize streaming ASR"))
        }
    }

    pub fn is_streaming_asr_available(&self) -> bool {
        unsafe { fluidaudio_is_streaming_asr_available(self.ptr) != 0 }
    }

    pub fn streaming_asr_feed(&self, samples: &[f32]) -> Result<String, String> {
        let mut out: *mut i8 = std::ptr::null_mut();
        let result = unsafe {
            fluidaudio_streaming_asr_feed(
                self.ptr,
                samples.as_ptr(),
                samples.len() as u32,
                &mut out,
            )
        };
        if result != 0 || out.is_null() {
            return Err(self.last_error_message("Failed to process streaming ASR audio"));
        }
        let text = unsafe { CStr::from_ptr(out) }.to_string_lossy().into_owned();
        unsafe { fluidaudio_free_string(out) };
        Ok(text)
    }

    pub fn streaming_asr_reset(&self) -> Result<(), String> {
        let result = unsafe { fluidaudio_streaming_asr_reset(self.ptr) };
        if result == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to reset streaming ASR"))
        }
    }
```

`fluidaudio_free_string` is already declared in this file; match its existing pointer type if it is not `*mut i8`.

In `src/lib.rs`, after the VAD methods:

```rust
    // ========== Streaming ASR (live text) ==========

    /// Download and load the Parakeet EOU streaming model (320 ms chunks).
    pub fn init_streaming_asr_with_progress<F>(
        &self,
        progress_callback: F,
    ) -> Result<(), FluidAudioError>
    where
        F: Fn(ModelProgress) + Send + Sync,
    {
        self.bridge
            .initialize_streaming_asr_with_progress(progress_callback)
            .map_err(FluidAudioError::from)
    }

    pub fn is_streaming_asr_available(&self) -> bool {
        self.bridge.is_streaming_asr_available()
    }

    /// Feed 16 kHz mono samples; returns the transcript accumulated since the
    /// last reset.
    pub fn streaming_asr_feed(&self, samples_16k: &[f32]) -> Result<String, FluidAudioError> {
        self.bridge
            .streaming_asr_feed(samples_16k)
            .map_err(FluidAudioError::from)
    }

    pub fn streaming_asr_reset(&self) -> Result<(), FluidAudioError> {
        self.bridge
            .streaming_asr_reset()
            .map_err(FluidAudioError::from)
    }
```

Set `version = "0.17.4-assistant.2"` in `src-tauri/vendor/fluidaudio-rs/Cargo.toml`.

- [ ] **Step 3: Build**

Run: `cargo check --manifest-path src-tauri/Cargo.toml` (without `--locked`, once, so `src-tauri/Cargo.lock` picks up the version bump)
Expected: finishes with only the two existing dead-code warnings. Then `git diff --stat src-tauri/Cargo.lock` shows one changed line.

- [ ] **Step 4: Write the probe**

Create `src-tauri/examples/live_text_probe.rs`:

```rust
//! Feeds a WAV through the streaming model in 320 ms steps and reports how
//! fast it runs. Usage: cargo run --release --example live_text_probe -- speech.wav

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use fluidaudio_rs::{resample_samples, FluidAudio};
    use std::time::Instant;

    let path = std::env::args().nth(1).ok_or("usage: live_text_probe <wav>")?;
    let mut reader = hound::WavReader::open(&path)?;
    let spec = reader.spec();
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()?
        }
    };
    let channels = spec.channels.max(1) as usize;
    let mono: Vec<f32> = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    let samples = resample_samples(&mono, spec.sample_rate as f64)?;

    let audio = FluidAudio::new()?;
    let load_started = Instant::now();
    audio.init_streaming_asr_with_progress(|_| {})?;
    println!("model load: {:.1}s", load_started.elapsed().as_secs_f64());
    audio.streaming_asr_reset()?;

    const STEP: usize = 5_120; // 320 ms at 16 kHz
    let mut worst_ms = 0.0_f64;
    let mut text = String::new();
    let started = Instant::now();
    for (index, chunk) in samples.chunks(STEP).enumerate() {
        let feed_started = Instant::now();
        text = audio.streaming_asr_feed(chunk)?;
        let ms = feed_started.elapsed().as_secs_f64() * 1000.0;
        // The first feeds include one-off warm-up.
        if index >= 3 {
            worst_ms = worst_ms.max(ms);
        }
    }
    let elapsed = started.elapsed().as_secs_f64();
    let audio_secs = samples.len() as f64 / 16_000.0;
    println!("audio: {audio_secs:.1}s  processing: {elapsed:.2}s  speed: {:.1}x real time", audio_secs / elapsed);
    println!("worst 320 ms step after warm-up: {worst_ms:.0} ms");
    println!("text: {text}");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("live_text_probe requires macOS");
}
```

- [ ] **Step 5: Run the probe — this is the go/no-go gate**

Make an English test recording (not committed):

```bash
say -o /tmp/live-text-probe.wav --data-format=LEI16@16000 "Thanks for joining today. Could you walk me through a project where you had to make a difficult technical trade off, and tell me how you decided between the options you were considering at the time?"
cargo run --release --manifest-path src-tauri/Cargo.toml --example live_text_probe -- /tmp/live-text-probe.wav
```

Expected: the model downloads on first run, the text is recognisably the sentence, speed is at least **5x real time**, and the worst step after warm-up is under **320 ms**.

**If either number fails, stop here.** Report the figures to the user and revisit the model choice; do not continue to Task 2.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/vendor/fluidaudio-rs src-tauri/Cargo.lock src-tauri/examples/live_text_probe.rs
git commit -m "feat: expose FluidAudio streaming ASR through the bridge"
```

---

### Task 2: Live-text worker

**Files:**
- Create: `src-tauri/src/speaker/live_text.rs`
- Modify: `src-tauri/src/speaker/mod.rs` (add `pub(crate) mod live_text;` next to `session_recording`)

**Interfaces:**
- Produces:
  - `pub(crate) trait LiveTextModel: Send { fn reset(&mut self) -> Result<(), String>; fn feed(&mut self, samples_16k: &[f32]) -> Result<String, String>; }`
  - `#[derive(Debug, Clone, PartialEq, serde::Serialize)] pub(crate) struct LiveTextPartial { pub turn: u64, pub text: String }`
  - `#[derive(Debug, Clone, PartialEq)] pub(crate) enum LiveTextEvent { Partial(LiveTextPartial), Error(String) }`
  - `pub(crate) struct LiveTextHandle` with `fn spawn(model: Box<dyn LiveTextModel>, emit: impl FnMut(LiveTextEvent) + Send + 'static) -> Self`, `fn audio(&self, turn: u64, samples: Vec<f32>)`, `fn end_turn(&self)`, `fn dropped(&self) -> u64`, `fn stop(self, deadline: Duration) -> bool`
  - `pub(crate) struct LiveTextTurns` with `fn new(handle: Option<LiveTextHandle>) -> Self`, `fn begin(&mut self, lead_in_16k: Vec<f32>) -> u64`, `fn audio(&self, samples_16k: Vec<f32>)`, `fn end(&mut self)`, `fn current(&self) -> u64`, `fn stop(self, deadline: Duration)`

- [ ] **Step 1: Write the module with failing tests**

Create `src-tauri/src/speaker/live_text.rs` with the tests first and the types stubbed just enough to compile (`unimplemented!()` bodies):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Script {
        calls: Vec<String>,
        fail_on_feed: Option<usize>,
        feeds: usize,
    }

    /// Returns "t<n>" where n counts feeds since the last reset.
    struct FakeModel {
        script: Arc<Mutex<Script>>,
        since_reset: usize,
        gate: Option<mpsc::Receiver<()>>,
    }

    impl LiveTextModel for FakeModel {
        fn reset(&mut self) -> Result<(), String> {
            self.since_reset = 0;
            self.script.lock().unwrap().calls.push("reset".into());
            Ok(())
        }

        fn feed(&mut self, samples: &[f32]) -> Result<String, String> {
            if let Some(gate) = &self.gate {
                let _ = gate.recv();
            }
            let mut script = self.script.lock().unwrap();
            script.feeds += 1;
            if script.fail_on_feed == Some(script.feeds) {
                return Err("model exploded".into());
            }
            script.calls.push(format!("feed:{}", samples.len()));
            self.since_reset += 1;
            Ok(format!("t{}", self.since_reset))
        }
    }

    fn spawn_with(
        script: Arc<Mutex<Script>>,
        gate: Option<mpsc::Receiver<()>>,
    ) -> (LiveTextHandle, mpsc::Receiver<LiveTextEvent>) {
        let (tx, rx) = mpsc::channel();
        let handle = LiveTextHandle::spawn(
            Box::new(FakeModel { script, since_reset: 0, gate }),
            move |event| {
                let _ = tx.send(event);
            },
        );
        (handle, rx)
    }

    fn next(rx: &mpsc::Receiver<LiveTextEvent>) -> LiveTextEvent {
        rx.recv_timeout(Duration::from_secs(2)).expect("expected an event")
    }

    fn partial(turn: u64, text: &str) -> LiveTextEvent {
        LiveTextEvent::Partial(LiveTextPartial { turn, text: text.into() })
    }

    #[test]
    fn partials_carry_the_turn_and_follow_the_model_text() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (handle, rx) = spawn_with(script.clone(), None);

        handle.audio(1, vec![0.0; 4]);
        handle.audio(1, vec![0.0; 4]);
        assert_eq!(next(&rx), partial(1, "t1"));
        assert_eq!(next(&rx), partial(1, "t2"));
        assert!(handle.stop(Duration::from_secs(2)));
        assert_eq!(script.lock().unwrap().calls[0], "reset");
    }

    #[test]
    fn a_new_turn_resets_the_model_even_when_the_end_was_never_seen() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (handle, rx) = spawn_with(script.clone(), None);

        handle.audio(1, vec![0.0; 4]);
        assert_eq!(next(&rx), partial(1, "t1"));
        // No end_turn(): a dropped End must not leak turn 1 into turn 2.
        handle.audio(2, vec![0.0; 4]);
        assert_eq!(next(&rx), partial(2, "t1"));
        assert!(handle.stop(Duration::from_secs(2)));
        let calls = script.lock().unwrap().calls.clone();
        assert_eq!(calls, vec!["reset", "feed:4", "reset", "feed:4"]);
    }

    #[test]
    fn a_full_queue_drops_audio_without_blocking_the_sender() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (gate_tx, gate_rx) = mpsc::channel();
        let (handle, _rx) = spawn_with(script, Some(gate_rx));

        let started = Instant::now();
        for _ in 0..(LIVE_TEXT_QUEUE_MESSAGES * 3) {
            handle.audio(1, vec![0.0; 4]);
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(handle.dropped() > 0);

        drop(gate_tx); // unblock the model so the worker can exit
        assert!(handle.stop(Duration::from_secs(2)));
    }

    #[test]
    fn a_model_error_is_reported_once_and_later_audio_is_ignored() {
        let script = Arc::new(Mutex::new(Script { fail_on_feed: Some(1), ..Script::default() }));
        let (handle, rx) = spawn_with(script.clone(), None);

        handle.audio(1, vec![0.0; 4]);
        assert_eq!(next(&rx), LiveTextEvent::Error("model exploded".into()));
        handle.audio(1, vec![0.0; 4]);
        handle.audio(2, vec![0.0; 4]);
        assert!(handle.stop(Duration::from_secs(2)));
        assert!(rx.try_recv().is_err());
        assert_eq!(script.lock().unwrap().feeds, 1);
    }

    #[test]
    fn stop_gives_up_at_the_deadline_and_a_detached_worker_stays_silent() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (gate_tx, gate_rx) = mpsc::channel();
        let (handle, rx) = spawn_with(script, Some(gate_rx));

        handle.audio(1, vec![0.0; 4]);
        std::thread::sleep(Duration::from_millis(50)); // worker is now blocked in feed
        let started = Instant::now();
        assert!(!handle.stop(Duration::from_millis(100)));
        assert!(started.elapsed() < Duration::from_secs(1));

        drop(gate_tx); // the model returns after stop
        std::thread::sleep(Duration::from_millis(100));
        assert!(rx.try_recv().is_err(), "a stopped worker must not emit");
    }

    #[test]
    fn turns_number_from_one_and_only_send_audio_inside_a_turn() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (handle, rx) = spawn_with(script.clone(), None);
        let mut turns = LiveTextTurns::new(Some(handle));

        assert_eq!(turns.current(), 0);
        turns.audio(vec![0.0; 9]); // before any turn: ignored
        assert_eq!(turns.begin(vec![0.0; 8]), 1);
        assert_eq!(next(&rx), partial(1, "t1"));
        turns.audio(vec![0.0; 4]);
        assert_eq!(next(&rx), partial(1, "t2"));
        turns.end();
        turns.end(); // idempotent
        turns.audio(vec![0.0; 9]); // between turns: ignored
        assert_eq!(turns.begin(Vec::new()), 2);
        turns.audio(vec![0.0; 4]);
        assert_eq!(next(&rx), partial(2, "t1"));
        turns.stop(Duration::from_secs(2));

        let calls = script.lock().unwrap().calls.clone();
        assert_eq!(calls, vec!["reset", "feed:8", "feed:4", "reset", "feed:4"]);
    }

    #[test]
    fn turns_still_count_without_a_worker() {
        let mut turns = LiveTextTurns::new(None);
        assert_eq!(turns.begin(vec![0.0; 8]), 1);
        turns.audio(vec![0.0; 4]);
        turns.end();
        assert_eq!(turns.begin(Vec::new()), 2);
        turns.stop(Duration::from_millis(10));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib speaker::live_text`
Expected: FAIL (panics from `unimplemented!()`).

- [ ] **Step 3: Implement**

Above the tests in the same file:

```rust
//! Best-effort live text for the turn in progress.
//!
//! The capture loop hands 16 kHz audio to a dedicated thread that owns the
//! streaming model. Nothing here may slow capture down: the queue is bounded,
//! sends never wait, and a worker that will not stop is left behind.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::Duration;

/// About two seconds of capture hops (one message per ~21 ms hop).
pub(crate) const LIVE_TEXT_QUEUE_MESSAGES: usize = 96;

pub(crate) trait LiveTextModel: Send {
    fn reset(&mut self) -> Result<(), String>;
    /// Feed 16 kHz mono samples; returns the text accumulated since `reset`.
    fn feed(&mut self, samples_16k: &[f32]) -> Result<String, String>;
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct LiveTextPartial {
    pub turn: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LiveTextEvent {
    Partial(LiveTextPartial),
    Error(String),
}

enum Message {
    /// Audio carries its turn so a dropped `End` or a dropped first message
    /// can never attach one turn's audio to another turn's text.
    Audio { turn: u64, samples: Vec<f32> },
    End,
}

pub(crate) struct LiveTextHandle {
    tx: SyncSender<Message>,
    done: Receiver<()>,
    active: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
}

impl LiveTextHandle {
    pub(crate) fn spawn(
        model: Box<dyn LiveTextModel>,
        emit: impl FnMut(LiveTextEvent) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel(LIVE_TEXT_QUEUE_MESSAGES);
        let (done_tx, done) = mpsc::channel();
        let active = Arc::new(AtomicBool::new(true));
        let worker_active = active.clone();
        std::thread::Builder::new()
            .name("live-text".into())
            .spawn(move || {
                run_worker(model, rx, worker_active, emit);
                let _ = done_tx.send(());
            })
            .expect("failed to spawn the live-text thread");
        Self {
            tx,
            done,
            active,
            dropped: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) fn audio(&self, turn: u64, samples: Vec<f32>) {
        self.send(Message::Audio { turn, samples });
    }

    pub(crate) fn end_turn(&self) {
        self.send(Message::End);
    }

    /// Messages dropped because the worker was behind.
    pub(crate) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    fn send(&self, message: Message) {
        if self.tx.try_send(message).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Stop the worker. Returns false if it had not exited by the deadline,
    /// in which case it is left to finish on its own and can no longer emit.
    pub(crate) fn stop(self, deadline: Duration) -> bool {
        self.active.store(false, Ordering::Release);
        let Self { tx, done, .. } = self;
        drop(tx);
        done.recv_timeout(deadline).is_ok()
    }
}

fn run_worker(
    mut model: Box<dyn LiveTextModel>,
    rx: Receiver<Message>,
    active: Arc<AtomicBool>,
    mut emit: impl FnMut(LiveTextEvent),
) {
    let mut current_turn: Option<u64> = None;
    let mut last_text = String::new();
    let mut failed = false;

    while let Ok(message) = rx.recv() {
        if failed || !active.load(Ordering::Acquire) {
            continue;
        }
        let (turn, samples) = match message {
            Message::End => {
                current_turn = None;
                continue;
            }
            Message::Audio { turn, samples } => (turn, samples),
        };

        let result = if current_turn != Some(turn) {
            current_turn = Some(turn);
            last_text.clear();
            model.reset().and_then(|()| model.feed(&samples))
        } else {
            model.feed(&samples)
        };

        if !active.load(Ordering::Acquire) {
            continue;
        }
        match result {
            Ok(text) => {
                if !text.is_empty() && text != last_text {
                    last_text = text.clone();
                    emit(LiveTextEvent::Partial(LiveTextPartial { turn, text }));
                }
            }
            Err(error) => {
                failed = true;
                emit(LiveTextEvent::Error(error));
            }
        }
    }
}

/// Turn bookkeeping for the capture loop. Turns are numbered whether or not a
/// worker exists, so `speech-detected` always carries a turn.
pub(crate) struct LiveTextTurns {
    handle: Option<LiveTextHandle>,
    turn: u64,
    in_turn: bool,
}

impl LiveTextTurns {
    pub(crate) fn new(handle: Option<LiveTextHandle>) -> Self {
        Self {
            handle,
            turn: 0,
            in_turn: false,
        }
    }

    /// Start the next turn with the audio that preceded the detection.
    pub(crate) fn begin(&mut self, lead_in_16k: Vec<f32>) -> u64 {
        self.turn += 1;
        self.in_turn = true;
        if !lead_in_16k.is_empty() {
            self.audio(lead_in_16k);
        }
        self.turn
    }

    pub(crate) fn audio(&self, samples_16k: Vec<f32>) {
        if !self.in_turn || samples_16k.is_empty() {
            return;
        }
        if let Some(handle) = &self.handle {
            handle.audio(self.turn, samples_16k);
        }
    }

    pub(crate) fn end(&mut self) {
        if !self.in_turn {
            return;
        }
        self.in_turn = false;
        if let Some(handle) = &self.handle {
            handle.end_turn();
        }
    }

    pub(crate) fn current(&self) -> u64 {
        self.turn
    }

    pub(crate) fn stop(self, deadline: Duration) {
        if let Some(handle) = self.handle {
            handle.stop(deadline);
        }
    }
}
```

Note for `stop_gives_up_at_the_deadline...`: the worker re-checks `active` after `feed` returns, which is what keeps a detached worker silent.

- [ ] **Step 4: Run the tests**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib speaker::live_text`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/speaker/live_text.rs src-tauri/src/speaker/mod.rs
git commit -m "feat: add the live-text worker and turn tracker"
```

(`cargo check` will warn that the new items are unused until Task 4; that is expected for this commit.)

---

### Task 3: Live-text model state, init command, status

**Files:**
- Modify: `src-tauri/src/stt.rs`
- Modify: `src-tauri/src/lib.rs` (register `stt::stt_init_live_text` after `stt::stt_init_vad`)

**Interfaces:**
- Consumes: `FluidAudio::{init_streaming_asr_with_progress, streaming_asr_feed, streaming_asr_reset}` (Task 1); `crate::speaker::live_text::LiveTextModel` (Task 2).
- Produces:
  - `SttState::live_text_model(&self) -> Option<Box<dyn LiveTextModel>>` (macOS only) — `Some` only when the model is loaded
  - Tauri command `stt_init_live_text() -> Result<(), String>`
  - `stt_get_status` JSON gains `"live_text_ready": bool`

- [ ] **Step 1: Write the failing tests**

In `stt.rs`'s `utterance_store_tests` module, next to `vad_lock_remains_available_while_asr_is_busy`:

```rust
    #[test]
    fn live_text_lock_is_independent_of_asr_and_vad() {
        let state = SttState::default();
        let _asr = state.inner.lock().unwrap();
        let _vad = state.streaming_vad.lock().unwrap();
        assert!(state.live_text.try_lock().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_text_model_is_absent_until_initialised() {
        let state = SttState::default();
        assert!(state.live_text_model().is_none());
    }

    #[test]
    fn status_reports_live_text_as_not_ready_by_default() {
        let state = SttState::default();
        let status = state.get_status().unwrap();
        assert_eq!(status["live_text_ready"], serde_json::json!(false));
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib live_text_`
Expected: compile error — no field `live_text`.

- [ ] **Step 3: Implement**

Add the slot (reusing `VadInner`'s shape under a neutral name is not worth a rename; add a sibling struct):

```rust
#[derive(Default)]
struct LiveTextInner {
    #[cfg(target_os = "macos")]
    audio: Option<FluidAudio>,
    ready: bool,
}
```

Add `live_text: Arc<Mutex<LiveTextInner>>,` to `SttState` after `mic_vad`. `stt_diarize_file` builds an `SttState` literal by hand (around the `last_status: Mutex::default(),` line); add `live_text: Arc::default(),` there, or switch that literal to `..SttState::default()` if the borrow rules allow.

In `impl SttState`:

```rust
    #[cfg(target_os = "macos")]
    fn init_live_text_inner(inner: Arc<Mutex<LiveTextInner>>, app: AppHandle) -> Result<(), String> {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        if guard.ready {
            return Ok(());
        }
        if guard.audio.is_none() {
            let audio = FluidAudio::new().map_err(|e| e.to_string())?;
            if audio.is_intel_mac() {
                return Err(not_supported());
            }
            guard.audio = Some(audio);
        }
        let progress_app = app.clone();
        guard
            .audio
            .as_ref()
            .ok_or("Live text not initialized")?
            .init_streaming_asr_with_progress(move |progress| {
                let _ = progress_app.emit(
                    "stt-model-progress",
                    serde_json::json!({
                        "fraction_completed": progress.fraction_completed,
                        "phase": progress.phase,
                        "model_name": progress.model_name,
                    }),
                );
            })
            .map_err(|e| e.to_string())?;
        guard.ready = true;
        Ok(())
    }

    /// The streaming model for one capture session, if it is loaded.
    #[cfg(target_os = "macos")]
    pub(crate) fn live_text_model(
        &self,
    ) -> Option<Box<dyn crate::speaker::live_text::LiveTextModel>> {
        let ready = self.live_text.lock().map(|guard| guard.ready).unwrap_or(false);
        ready.then(|| {
            Box::new(FluidLiveTextModel {
                inner: self.live_text.clone(),
            }) as Box<dyn crate::speaker::live_text::LiveTextModel>
        })
    }
```

After the `impl SttState` block:

```rust
/// Adapter that lets the live-text worker drive the streaming model. It locks
/// per call; nothing else holds this lock for longer than a status read.
#[cfg(target_os = "macos")]
struct FluidLiveTextModel {
    inner: Arc<Mutex<LiveTextInner>>,
}

#[cfg(target_os = "macos")]
impl crate::speaker::live_text::LiveTextModel for FluidLiveTextModel {
    fn reset(&mut self) -> Result<(), String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        guard
            .audio
            .as_ref()
            .ok_or("Live text not initialized")?
            .streaming_asr_reset()
            .map_err(|e| e.to_string())
    }

    fn feed(&mut self, samples_16k: &[f32]) -> Result<String, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        guard
            .audio
            .as_ref()
            .ok_or("Live text not initialized")?
            .streaming_asr_feed(samples_16k)
            .map_err(|e| e.to_string())
    }
}
```

In `get_status`: add `"live_text_ready": false,` to the non-macOS JSON; on macOS take `let live_text_guard = match self.live_text.try_lock() { Ok(guard) => guard, Err(_) => return self.cached_status(), };` with the other guards and add `"live_text_ready": live_text_guard.ready,` to the JSON. If `cached_status()` builds a default JSON when no snapshot exists, add `"live_text_ready": false` there too.

Add the command after `stt_init_vad`:

```rust
#[tauri::command]
pub async fn stt_init_live_text(state: State<'_, SttState>, app: AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, app);
        return Err(not_supported());
    }

    #[cfg(target_os = "macos")]
    {
        let inner = state.live_text.clone();
        tokio::task::spawn_blocking(move || SttState::init_live_text_inner(inner, app))
            .await
            .map_err(|e| e.to_string())?
    }
}
```

Register `stt::stt_init_live_text,` in `src-tauri/src/lib.rs`'s `invoke_handler` list after `stt::stt_init_vad,`.

- [ ] **Step 4: Run the tests**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`
Expected: all pass, 3 more than before.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stt.rs src-tauri/src/lib.rs
git commit -m "feat: load the live-text model and report its status"
```

---

### Task 4: Capture-loop wiring

**Files:**
- Modify: `src-tauri/src/speaker/commands.rs`

**Interfaces:**
- Consumes: `LiveTextHandle`, `LiveTextTurns`, `LiveTextEvent` (Task 2); `SttState::live_text_model` (Task 3).
- Produces:
  - `VadConfig.live_text: bool` (serde default `true`)
  - event `speech-partial` with payload `{ "turn": number, "text": string }`
  - `speech-detected` payload gains `"turn": number`

- [ ] **Step 1: Write the failing test**

In the `tests` module of `commands.rs`:

```rust
    #[test]
    fn live_text_defaults_on_and_survives_configs_saved_without_it() {
        assert!(VadConfig::default().live_text);
        let mut saved = serde_json::to_value(VadConfig::default()).unwrap();
        saved.as_object_mut().unwrap().remove("live_text");
        let parsed: VadConfig = serde_json::from_value(saved).unwrap();
        assert!(parsed.live_text);
    }

    #[test]
    fn vad_resampling_also_returns_the_16k_samples() {
        let mut accumulator = VadFrameAccumulator::default();
        let (samples_16k, frames) =
            resampled_vad_frames(&mut accumulator, &[0.0; 1024], 16_000).unwrap();
        assert_eq!(samples_16k.len(), 1024);
        assert!(frames.is_empty());
    }
```

(If `samples_for_local_asr` is macOS-only, gate the second test with `#[cfg(target_os = "macos")]` to match.)

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib live_text_defaults_on vad_resampling_also`
Expected: compile errors — no field `live_text`; `resampled_vad_frames` returns a `Vec`, not a tuple.

- [ ] **Step 3: Implement the config field and the resampler change**

In `VadConfig`, after `compare_preprocessing`:

```rust
    /// Show provisional text for the turn in progress (macOS, local model).
    #[serde(default = "default_live_text")]
    pub live_text: bool,
```

with `fn default_live_text() -> bool { true }` beside `default_chunk_interval`, and `live_text: true,` in `Default`.

Change `resampled_vad_frames` to hand back the 16 kHz samples it already computes:

```rust
fn resampled_vad_frames(
    accumulator: &mut VadFrameAccumulator,
    samples: &[f32],
    sample_rate: u32,
) -> Result<(Vec<f32>, Vec<[f32; SILERO_CHUNK_SAMPLES]>), String> {
    let samples_16k = samples_for_local_asr(samples, sample_rate)?;
    let frames = accumulator.push(&samples_16k);
    Ok((samples_16k, frames))
}
```

Update every caller (the capture loop, the mic dictation loop if it calls it, and existing tests) to destructure the tuple.

- [ ] **Step 4: Wire the capture loop**

In `start_system_audio_capture`, after `vad_config` is cloned and before `tokio::spawn`:

```rust
    #[cfg(target_os = "macos")]
    let live_text = if vad_config.enabled && vad_config.live_text {
        app.try_state::<crate::stt::SttState>()
            .and_then(|stt_state| stt_state.live_text_model())
            .map(|model| {
                let emit_app = app.clone();
                live_text::LiveTextHandle::spawn(model, move |event| match event {
                    live_text::LiveTextEvent::Partial(partial) => {
                        let _ = emit_app.emit("speech-partial", partial);
                    }
                    live_text::LiveTextEvent::Error(error) => {
                        let _ = emit_app.emit("stt-error", format!("Live text stopped: {error}"));
                    }
                })
            })
    } else {
        None
    };
    #[cfg(not(target_os = "macos"))]
    let live_text: Option<live_text::LiveTextHandle> = None;
```

Add `use super::live_text;` with the file's other `super::` imports. Pass `live_text` as a new last argument to `run_vad_capture`.

In `run_vad_capture`:

1. Add the parameter `live_text: Option<live_text::LiveTextHandle>,` and, with the other loop state, `let mut live_turns = live_text::LiveTextTurns::new(live_text);`.
2. In the macOS VAD block, keep the hop's 16 kHz samples. The block becomes a three-value tuple, and the non-macOS build gets an empty `Vec`:

```rust
            #[cfg(target_os = "macos")]
            let (resample_duration, vad_duration, hop_16k) = {
                let resample_started = Instant::now();
                let resampled = resampled_vad_frames(&mut vad_accumulator, &raw_mono, sr);
                let resample_duration = resample_started.elapsed();
                let vad_started = Instant::now();
                let hop_16k = match resampled {
                    Ok((samples_16k, frames)) => {
                        // existing `for frame in frames { ... }` body, unchanged
                        samples_16k
                    }
                    Err(error) => {
                        // existing error arm body, unchanged
                        Vec::new()
                    }
                };
                (resample_duration, vad_started.elapsed(), hop_16k)
            };
            #[cfg(not(target_os = "macos"))]
            let hop_16k: Vec<f32> = Vec::new();
```

3. Speech start (`if !in_speech { ... }`): resample the lead-in before it is drained into `speech_buffer`, then begin the turn:

```rust
                    // Live text starts from the same lead-in the utterance
                    // gets, so its first word is not clipped.
                    let lead_in_16k = if hop_16k.is_empty() {
                        Vec::new()
                    } else {
                        let lead_in: Vec<f32> = pre_speech.iter().copied().collect();
                        samples_for_local_asr(&lead_in, sr).unwrap_or_default()
                    };
                    live_turns.begin(lead_in_16k);
```

   placed before `speech_buffer.extend(pre_speech.drain(..));`. If `samples_for_local_asr` is macOS-only, wrap the resample in `#[cfg(target_os = "macos")]` and use `Vec::new()` elsewhere.
4. Every hop inside a turn sends its audio. Add `live_turns.audio(hop_16k.clone());` right after `speech_buffer.extend_from_slice(&raw_mono);` in the speech branch, and `live_turns.audio(hop_16k.clone());` right after the `speech_buffer.extend_from_slice(&raw_mono);` in the silence-within-speech branch. (`audio` ignores calls outside a turn and empty input.)
5. End the turn wherever the loop resets for the next utterance: in the 30-second safety-cap block and in the `silence_chunks >= config.silence_chunks` block (which covers both the emit and the discard paths), add `live_turns.end();` before `speech_buffer.clear();`.
6. Pass the turn to all three `emit_speech_detected` calls as a new last argument `live_turns.current()`.
7. After the final "Emit any remaining audio" block and before the session WAV is finalised:

```rust
    // Bounded: a worker that will not stop is left behind and muted.
    live_turns.stop(Duration::from_millis(500));
```

In `emit_speech_detected`, add the parameter `turn: u64` and `"turn": turn,` to the `speech-detected` JSON. `run_continuous_capture`'s call passes `0`.

- [ ] **Step 5: Run the tests and check**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib && cargo check --locked --manifest-path src-tauri/Cargo.toml`
Expected: all tests pass; check shows only the two pre-existing dead-code warnings (the Task 2 unused warnings are gone).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/speaker/commands.rs
git commit -m "feat: feed live text from the VAD capture loop"
```

---

### Task 5: One-second pause default

**Files:**
- Modify: `src-tauri/src/speaker/commands.rs` (`VadConfig::default`)
- Modify: `src/hooks/system-audio/useVadConfig.ts`
- Modify: `src/hooks/system-audio/useVadConfig.test.ts` and any Rust test asserting the old default

- [ ] **Step 1: Update the expectations first**

In `useVadConfig.test.ts`, change any expectation of `silence_chunks: 100` / about 2.1 s to 47 / about 1.0 s, and add:

```ts
it("ends a turn after about one second of silence by default", () => {
  expect(DEFAULT_VAD_CONFIG.silence_chunks).toBe(47);
  expect(
    silenceSeconds(DEFAULT_VAD_CONFIG, 48_000),
  ).toBeCloseTo(1.0, 1);
});
```

Use the file's existing name for the helper at `useVadConfig.ts:39-43` (the function that returns `(silence_chunks * hop_size) / sampleRate`); export `DEFAULT_VAD_CONFIG` if it is not already exported.

In the Rust `tests` module:

```rust
    #[test]
    fn default_silence_ends_a_turn_after_about_one_second() {
        let config = VadConfig::default();
        let seconds = (config.silence_chunks * config.hop_size) as f32 / 48_000.0;
        assert!((0.95..=1.05).contains(&seconds), "{seconds}");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/hooks/system-audio/useVadConfig.test.ts` and `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib default_silence_ends`
Expected: both FAIL (100 hops is about 2.1 s).

- [ ] **Step 3: Change the defaults**

Rust:

```rust
            silence_chunks: 47, // ~1.0s of silence ends the turn; live text covers the wait
```

TypeScript `DEFAULT_VAD_CONFIG`: `silence_chunks: 47,` with its comment updated to "~1.0s", plus `live_text: true,` and `live_text: boolean;` on the `VadConfig` interface. Change the key:

```ts
const VAD_CONFIG_STORAGE_KEY = "vad_config_v3";
```

Check the silence slider in `SettingsPanel.tsx` (around line 327): if its `min` is above 47, lower it to 24 (about 0.5 s).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && cargo test --locked --manifest-path src-tauri/Cargo.toml --lib && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/speaker/commands.rs src/hooks/system-audio src/pages/app/components/speech/SettingsPanel.tsx
git commit -m "feat: end turns after about one second of silence"
```

---

### Task 6: Frontend provisional-text state

**Files:**
- Create: `src/lib/live-text.ts`, `src/lib/live-text.test.ts`
- Modify: `src/lib/speech-event-dedupe.ts` (`SpeechEventPayload`)
- Modify: `src/hooks/useSttStatus.ts`
- Modify: `src/hooks/useSystemAudio.ts`

**Interfaces:**
- Consumes: events `speech-partial` `{ turn, text }` and `speech-detected` `{ ..., turn }` (Task 4); command `stt_init_live_text`; status field `live_text_ready` (Task 3).
- Produces:
  - `export interface LiveTextPartial { turn: number; text: string }`
  - `export type LiveTextState = LiveTextPartial | null`
  - `export function applyPartial(state: LiveTextState, partial: LiveTextPartial): LiveTextState`
  - `export function clearThroughTurn(state: LiveTextState, turn: number | null | undefined): LiveTextState`
  - `useSystemAudio()` returns `partialTranscription: string`
  - `useSttStatus()` returns `status.liveTextReady: boolean` and `initLiveText: () => Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

`src/lib/live-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyPartial, clearThroughTurn } from "./live-text";

describe("live text state", () => {
  it("shows the newest text for the turn in progress", () => {
    let state = applyPartial(null, { turn: 1, text: "could you" });
    state = applyPartial(state, { turn: 1, text: "could you walk me" });
    expect(state).toEqual({ turn: 1, text: "could you walk me" });
  });

  it("moves on to a newer turn and ignores a late partial from an older one", () => {
    let state = applyPartial(null, { turn: 2, text: "next question" });
    state = applyPartial(state, { turn: 1, text: "stale" });
    expect(state).toEqual({ turn: 2, text: "next question" });
  });

  it("ignores empty text", () => {
    const state = applyPartial({ turn: 1, text: "hello" }, { turn: 1, text: "  " });
    expect(state).toEqual({ turn: 1, text: "hello" });
  });

  it("clears when the final for that turn lands", () => {
    expect(clearThroughTurn({ turn: 3, text: "abc" }, 3)).toBeNull();
  });

  it("keeps a newer turn's text when an older turn's final lands", () => {
    const state = { turn: 4, text: "already talking again" };
    expect(clearThroughTurn(state, 3)).toBe(state);
  });

  it("clears unconditionally when no turn is given", () => {
    expect(clearThroughTurn({ turn: 4, text: "abc" }, null)).toBeNull();
    expect(clearThroughTurn({ turn: 4, text: "abc" }, undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/live-text.test.ts`
Expected: FAIL — cannot resolve `./live-text`.

- [ ] **Step 3: Implement the pure module**

`src/lib/live-text.ts`:

```ts
/**
 * Provisional text for the turn in progress. It is display-only: the batch
 * transcription of the finished turn replaces it and is what gets saved.
 */
export interface LiveTextPartial {
  turn: number;
  text: string;
}

export type LiveTextState = LiveTextPartial | null;

export function applyPartial(
  state: LiveTextState,
  partial: LiveTextPartial,
): LiveTextState {
  if (!partial.text.trim()) return state;
  if (state && partial.turn < state.turn) return state;
  return { turn: partial.turn, text: partial.text };
}

/**
 * Drop provisional text once the turn it belongs to is settled. With no turn
 * (discard, stop) everything goes. A newer turn's text survives an older
 * turn's final, which can land after the speaker has started again.
 */
export function clearThroughTurn(
  state: LiveTextState,
  turn: number | null | undefined,
): LiveTextState {
  if (!state) return null;
  if (turn === null || turn === undefined) return null;
  return state.turn <= turn ? null : state;
}
```

Run: `npx vitest run src/lib/live-text.test.ts` — Expected: 6 passed.

- [ ] **Step 4: Wire the hook**

`src/lib/speech-event-dedupe.ts` — add to `SpeechEventPayload`:

```ts
  /** Turn number within the capture; matches `speech-partial` events. */
  turn?: number;
```

`src/hooks/useSttStatus.ts`:
- add `liveTextReady: boolean;` to `SttStatus`, `liveTextReady: false,` to the initial state, `live_text_ready: boolean;` to the `stt_get_status` result type, and `liveTextReady: result.live_text_ready ?? false,` in `refresh`;
- add beside `init`:

```ts
  // Live text is optional: a failed download must not block capture, so this
  // reports failure by return value and leaves `status.error` alone.
  const initLiveText = useCallback(async () => {
    setStatus((prev) => ({ ...prev, isInitializing: true }));
    try {
      await invoke("stt_init_live_text");
      await refresh();
      return true;
    } catch (e) {
      console.warn("Live text is unavailable:", e);
      return false;
    } finally {
      setStatus((prev) => ({ ...prev, isInitializing: false }));
      setProgress(null);
    }
  }, [refresh]);
```

- return `initLiveText` from the hook.

`src/hooks/useSystemAudio.ts`:
- import `{ applyPartial, clearThroughTurn, LiveTextPartial, LiveTextState }` from `@/lib/live-text`;
- destructure `initLiveText` from `useSttStatus()` (line ~146);
- add state near `lastTranscription`:

```ts
  const [partialTranscription, setPartialTranscription] = useState("");
  const liveTextRef = useRef<LiveTextState>(null);
  const setLiveText = useCallback((next: LiveTextState) => {
    liveTextRef.current = next;
    setPartialTranscription(next?.text ?? "");
  }, []);
```

- in the listener effect that registers `speech-detected`, add:

```ts
      scope.add(
        listen(
          "speech-partial",
          scope.guard((event) => {
            if (!capturingRef.current) return;
            setLiveText(
              applyPartial(liveTextRef.current, event.payload as LiveTextPartial),
            );
          }),
        ),
      ),
```

- replace the empty `speech-discarded` handler body with `setLiveText(null);`;
- in the `speech-detected` handler, wrap everything after `const payload = event.payload as SpeechEventPayload;` so the provisional text for that turn is cleared however the handler exits (transcribed, backchannel, empty, error, early return): put the existing body in a `try` and add

```ts
            } finally {
              setLiveText(clearThroughTurn(liveTextRef.current, payload.turn));
            }
```

  The handler already has an outer `try`; add this as an inner `try/finally` that begins right after `payload` is read, so `payload` is in scope.
- call `setLiveText(null)` where a capture starts (`commitStarted`, beside `setCapturing(true)`) and in the stop path (where `setCapturing(false)` is called in `stopCapture`);
- at the STT init site (line ~1031, right after `await initStt(requestedModel);`):

```ts
          if (vadConfig.live_text) {
            await initLiveText();
          }
```

  and add `initLiveText` to that callback's dependency array;
- add `partialTranscription` to the hook's returned object and to both snapshot-building objects that already list `currentSpeaker` (lines ~1543 and ~1562), and to their dependency arrays.

- [ ] **Step 5: Run the gates**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/live-text.ts src/lib/live-text.test.ts src/lib/speech-event-dedupe.ts src/hooks/useSttStatus.ts src/hooks/useSystemAudio.ts
git commit -m "feat: track provisional live text in the system-audio hook"
```

---

### Task 7: Show the provisional text and add the toggle

**Files:**
- Modify: `src/lib/live-session.ts`, `src/lib/live-session.test.ts`
- Modify: `src/hooks/system-audio/useLiveStatePublisher.ts` (only if it enumerates snapshot fields)
- Modify: `src/pages/dashboard/components/TranscriptFeed.tsx`, `src/pages/dashboard/index.tsx`
- Create: `src/pages/dashboard/components/TranscriptFeed.test.tsx`
- Modify: `src/pages/app/components/speech/ResultsSection.tsx`, `src/pages/app/components/speech/index.tsx`
- Modify: `src/pages/app/components/speech/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `partialTranscription: string` from `useSystemAudio()` (Task 6); `vadConfig.live_text` (Task 5).
- Produces: `LiveSessionSnapshot.partialTranscription: string`; `TranscriptFeed` and `ResultsSection` accept `partialTranscription?: string`.

- [ ] **Step 1: Write the failing test**

`src/pages/dashboard/components/TranscriptFeed.test.tsx` (follow the render setup used in `src/components/Markdown/raw-html-safety.test.tsx`):

```tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TranscriptFeed } from "./TranscriptFeed";

const conversation = {
  id: "c1",
  title: "",
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { id: "m1", role: "user" as const, content: "First question", timestamp: 1 },
  ],
};

describe("TranscriptFeed live text", () => {
  it("shows provisional text after the settled turns while live", () => {
    render(
      <TranscriptFeed
        conversation={conversation}
        live
        partialTranscription="and the second one is"
      />,
    );
    expect(screen.getByText("First question")).toBeTruthy();
    expect(screen.getByText("and the second one is")).toBeTruthy();
    expect(screen.getByText("hearing")).toBeTruthy();
  });

  it("shows provisional text even before the first settled turn", () => {
    render(
      <TranscriptFeed conversation={null} live partialTranscription="hello" />,
    );
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.queryByText("listening · say something")).toBeNull();
  });

  it("hides provisional text when the feed is not live", () => {
    render(
      <TranscriptFeed conversation={conversation} partialTranscription="stale" />,
    );
    expect(screen.queryByText("stale")).toBeNull();
  });
});
```

If `@testing-library/react` is not the library the existing component test uses, use that file's imports instead; do not add a dependency.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/pages/dashboard/components/TranscriptFeed.test.tsx`
Expected: FAIL — provisional text not found.

- [ ] **Step 3: Implement**

`TranscriptFeed.tsx`: add `partialTranscription = ""` to the props (typed `partialTranscription?: string`), then:

```tsx
  const provisional = live ? partialTranscription.trim() : "";
```

- add `provisional` to the auto-scroll effect's dependency array;
- change `empty` to `turns.length === 0 && liveAnswerDraft === null && !provisional`;
- render after `turns.map(...)` and before the live answer draft:

```tsx
          {provisional && (
            <div className="flex gap-3">
              <span className="min-w-[40px] pt-0.5 font-mono text-[11px] text-meta">
                …
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1 font-mono text-[11px] text-muted-foreground">
                  hearing
                </div>
                <div className="text-sm italic leading-relaxed text-muted-foreground">
                  {provisional}
                </div>
              </div>
            </div>
          )}
```

`live-session.ts`: add `partialTranscription: string;` to `LiveSessionSnapshot` after `lastAIResponse`; add `partialTranscription: ""` to the fixture in `live-session.test.ts`. If `useLiveStatePublisher.ts` lists fields explicitly, add it there.

`dashboard/index.tsx`: pass `partialTranscription={snapshot?.partialTranscription ?? ""}` to `TranscriptFeed`.

`ResultsSection.tsx`: add `partialTranscription?: string` to `Props` (default `""`), then:

```tsx
  const provisional = partialTranscription.trim();

  if (!hasResponse && !lastTranscription && !provisional) {
    return null;
  }
```

```tsx
  // While someone is speaking, show what is being heard instead of the
  // previous turn's final text.
  const transcriptionText = provisional || lastTranscription;
```

and where `transcriptionText` is rendered (two places), add `provisional && "italic text-muted-foreground"` to the element's `cn(...)` class list (wrap the existing `className` string in `cn(...)` if it is a plain string).

`speech/index.tsx`: destructure `partialTranscription` from `useSystemAudio()` and pass it to `ResultsSection`.

`SettingsPanel.tsx`: add a row directly above the `compare_preprocessing` row, using the same markup pattern:

```tsx
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <Label className="text-xs">Live text</Label>
                    <p className="text-[10px] text-muted-foreground">
                      Shows what is being heard while the person is still speaking (English, local model). The final transcript replaces it. Applies to the next capture.
                    </p>
                  </div>
                  <Switch
                    checked={vadConfig.live_text}
                    onCheckedChange={(checked) =>
                      onUpdateVadConfig({
                        ...vadConfig,
                        live_text: checked,
                      })
                    }
                  />
                </div>
```

Copy the wrapper `div`/`Label` classes from the neighbouring `compare_preprocessing` row if they differ from the above.

- [ ] **Step 4: Run all gates**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: clean; all tests pass, 3 more than before; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-session.ts src/lib/live-session.test.ts src/hooks/system-audio/useLiveStatePublisher.ts src/pages
git commit -m "feat: show live text in the transcript and add its setting"
```

---

### Task 8: Final verification and hand-off

- [ ] **Step 1: Full gates**

```bash
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
npx tsc --noEmit
npm run build
npx vitest run
```

Expected: all pass. Report exact test counts.

- [ ] **Step 2: Mark the spec implemented**

Change the spec's `**Status:**` line to `Implemented on dev; awaiting live validation`. Commit: `git commit -am "docs: mark live text spec implemented"`.

- [ ] **Step 3: Hand the live checks to the user**

The user runs the app themselves. Ask them to check, in one real system-audio session:

1. The speech-setup overlay shows a second download the first time (the live-text model).
2. Provisional text appears in italics while someone is speaking, and is replaced by the final text after the pause.
3. The AI responds after roughly a 1-second pause; note whether thinking pauses split turns too often.
4. Turning "Live text" off in settings and restarting capture removes the provisional text and nothing else changes.
5. The log has no `System-audio drain stall` line and no `Live text stopped` error.
