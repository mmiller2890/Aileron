# Live Speaker Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label each transcript line with its speaker as it lands and show who is speaking on the provisional line, then remove the post-stop offline labelling run and the session recording it needs.

**Architecture:** A second best-effort worker thread owns FluidAudio's Sortformer streaming diarizer and receives each turn's 16 kHz audio alongside the live-text worker. It emits `speech-speaker` events keyed by turn number; the frontend attaches the final label to that turn's message whichever arrives first.

**Tech Stack:** Swift (FluidAudio 0.17.4 `SortformerDiarizer`), Rust (Tauri 2, `std::sync::mpsc`), React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-06-live-speaker-labels-design.md`

## Global Constraints

- Speaker labels are best-effort: they must never delay or block capture, the end-of-turn decision, live text, the final transcription, or stop.
- Scope: macOS, VAD capture mode, any speech provider.
- Model: Sortformer, `SortformerConfig.default`. Slots map to "Speaker 1" … "Speaker 4", reset per capture.
- A turn's speaker is the slot with the most active frames, minimum 3 frames (0.24 s); ties go to the lower slot; otherwise no label.
- No offline fallback. The bridge's offline diarization functions stay because `src-tauri/tests/fluidaudio_accuracy.rs` uses them; app-level use is removed.
- All work lands on `dev`. Do not start a dev server.
- Gates before every commit that touches code: `cargo check --locked --manifest-path src-tauri/Cargo.toml`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`, `npx tsc --noEmit`, `npm run build`, `npx vitest run`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`, `src/ffi/bridge.rs`, `src/lib.rs` | Live diarizer init/reset/feed/end-turn |
| `src-tauri/examples/live_speakers_probe.rs` (new) | Go/no-go probe |
| `src-tauri/src/speaker/live_speakers.rs` (new) | Model trait, dominant-slot rule, worker, handle |
| `src-tauri/src/speaker/turn_feeds.rs` (new) | One turn counter feeding both workers (replaces `LiveTextTurns`) |
| `src-tauri/src/stt.rs` | `live_speakers` slot, init command, status flag, adapter |
| `src-tauri/src/speaker/commands.rs` | `VadConfig.live_speakers`, worker spawn, loop wiring |
| `src/lib/live-speakers.ts` (new) | Pure turn → speaker bookkeeping |
| `src/hooks/useSystemAudio.ts`, `useSttStatus.ts`, `system-audio/useVadConfig.ts` | Event listener, label attachment, init, toggle field |
| `TranscriptFeed.tsx`, `ResultsSection.tsx`, `SettingsPanel.tsx`, `live-session.ts` | Provisional speaker display, toggle |

---

### Task 1: Live diarizer in the bridge, and the go/no-go probe

**Files:**
- Modify: `src-tauri/vendor/fluidaudio-rs/swift/FluidAudioBridge.swift`, `src/ffi/bridge.rs`, `src/lib.rs`, `Cargo.toml` (version `0.17.4-assistant.3`), `src-tauri/Cargo.lock`
- Create: `src-tauri/examples/live_speakers_probe.rs`

**Interfaces:**
- Produces (on `fluidaudio_rs::FluidAudio`):
  - `pub fn init_live_diarizer_with_progress<F: Fn(ModelProgress) + Send + Sync>(&self, progress_callback: F) -> Result<(), FluidAudioError>`
  - `pub fn is_live_diarizer_available(&self) -> bool`
  - `pub fn live_diarizer_reset(&self) -> Result<(), FluidAudioError>`
  - `pub fn live_diarizer_feed(&self, samples_16k: &[f32]) -> Result<[u32; 4], FluidAudioError>` — active-frame counts per slot for the turn so far (finalized + tentative)
  - `pub fn live_diarizer_end_turn(&self) -> Result<[u32; 4], FluidAudioError>` — finalized counts for the turn; clears the turn counters

- [ ] **Step 1: Swift implementation**

Before writing, read `processLocked` in the checkout's `Sources/FluidAudio/Diarizer/Sortformer/SortformerDiarizer.swift` to confirm whether one `process()` call consumes every buffered chunk or one chunk. The loop below is correct for both; the iteration cap guards against a non-nil empty update.

In `FluidAudioBridgeInternal` add properties (and clear them in `cleanup()`):

```swift
    private var liveDiarizer: SortformerDiarizer?
    private var liveTurnFinalized = [Int32](repeating: 0, count: 4)
    private var liveTurnTentative = [Int32](repeating: 0, count: 4)
```

Add after the streaming ASR methods:

```swift
    // MARK: - Live diarization (speaker labels)

    /// Silence fed at the end of a turn so its last frames finalize: one full
    /// chunk (6 frames) plus the right context (7 frames) at 80 ms per frame.
    private static let liveTurnFlushSamples = 16_640

    func initializeLiveDiarizer(
        progressCallback: FluidAudioProgressCallback? = nil,
        progressContext: UnsafeMutableRawPointer? = nil
    ) throws {
        let semaphore = DispatchSemaphore(value: 0)
        var initError: Error?

        Task {
            do {
                let models = try await SortformerModels.loadFromHuggingFace(
                    config: .default,
                    progressHandler: Self.makeProgressHandler(progressCallback, progressContext)
                )
                let diarizer = SortformerDiarizer(config: .default)
                diarizer.initialize(models: models)
                self.liveDiarizer = diarizer
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

    func isLiveDiarizerAvailable() -> Bool {
        return liveDiarizer != nil
    }

    func resetLiveDiarizer() throws {
        guard let diarizer = liveDiarizer else {
            throw BridgeError.notInitialized
        }
        diarizer.reset()
        liveTurnFinalized = [Int32](repeating: 0, count: 4)
        liveTurnTentative = [Int32](repeating: 0, count: 4)
    }

    private func liveDiarizerIngest(_ samples: [Float]) throws {
        guard let diarizer = liveDiarizer else {
            throw BridgeError.notInitialized
        }
        guard !samples.isEmpty else { return }
        let speakers = min(diarizer.numSpeakers ?? 4, 4)
        let stride = diarizer.numSpeakers ?? 4
        diarizer.addAudio(samples)
        var iterations = 0
        while iterations < 64, let update = try diarizer.process() {
            iterations += 1
            let chunk = update.chunkResult
            if chunk.finalizedFrameCount == 0 && chunk.tentativeFrameCount == 0 {
                break
            }
            for frame in 0..<chunk.finalizedFrameCount {
                for speaker in 0..<speakers
                where chunk.finalizedPredictions[frame * stride + speaker] >= 0.5 {
                    liveTurnFinalized[speaker] += 1
                }
            }
            var tentative = [Int32](repeating: 0, count: 4)
            for frame in 0..<chunk.tentativeFrameCount {
                for speaker in 0..<speakers
                where chunk.tentativePredictions[frame * stride + speaker] >= 0.5 {
                    tentative[speaker] += 1
                }
            }
            liveTurnTentative = tentative
        }
    }

    /// Feed a turn's audio; returns active-frame counts per slot so far.
    func liveDiarizerFeed(_ samples: [Float]) throws -> [Int32] {
        try liveDiarizerIngest(samples)
        return zip(liveTurnFinalized, liveTurnTentative).map { $0 + $1 }
    }

    /// Close the turn: flush with silence, return its finalized counts, and
    /// start counting afresh. Speaker identity carries over to the next turn.
    func liveDiarizerEndTurn() throws -> [Int32] {
        try liveDiarizerIngest([Float](repeating: 0, count: Self.liveTurnFlushSamples))
        let counts = liveTurnFinalized
        liveTurnFinalized = [Int32](repeating: 0, count: 4)
        liveTurnTentative = [Int32](repeating: 0, count: 4)
        return counts
    }
```

C entry points, next to the streaming ASR ones:

```swift
// MARK: - Live diarization FFI

@_cdecl("fluidaudio_initialize_live_diarizer")
public func fluidaudio_initialize_live_diarizer(
    _ ptr: UnsafeMutableRawPointer?,
    _ progressCallback: FluidAudioProgressCallback?,
    _ progressContext: UnsafeMutableRawPointer?
) -> Int32 {
    guard let ptr = ptr else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    do {
        try bridge.initializeLiveDiarizer(
            progressCallback: progressCallback,
            progressContext: progressContext
        )
        return 0
    } catch {
        bridge.recordError(error)
        print("Live diarizer init error: \(error)")
        return -1
    }
}

@_cdecl("fluidaudio_is_live_diarizer_available")
public func fluidaudio_is_live_diarizer_available(_ ptr: UnsafeMutableRawPointer?) -> Int32 {
    guard let ptr = ptr else { return 0 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    return bridge.isLiveDiarizerAvailable() ? 1 : 0
}

@_cdecl("fluidaudio_live_diarizer_reset")
public func fluidaudio_live_diarizer_reset(_ ptr: UnsafeMutableRawPointer?) -> Int32 {
    guard let ptr = ptr else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    do {
        try bridge.resetLiveDiarizer()
        return 0
    } catch {
        bridge.recordError(error)
        return -1
    }
}

private func writeLiveCounts(_ counts: [Int32], _ out: UnsafeMutablePointer<Int32>) {
    for index in 0..<4 {
        out[index] = index < counts.count ? counts[index] : 0
    }
}

@_cdecl("fluidaudio_live_diarizer_feed")
public func fluidaudio_live_diarizer_feed(
    _ ptr: UnsafeMutableRawPointer?,
    _ samples: UnsafePointer<Float>?,
    _ count: UInt32,
    _ outCounts: UnsafeMutablePointer<Int32>?
) -> Int32 {
    guard let ptr = ptr, let outCounts = outCounts else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    let input: [Float]
    if let samples = samples, count > 0 {
        input = Array(UnsafeBufferPointer(start: samples, count: Int(count)))
    } else {
        input = []
    }
    do {
        writeLiveCounts(try bridge.liveDiarizerFeed(input), outCounts)
        return 0
    } catch {
        bridge.recordError(error)
        return -1
    }
}

@_cdecl("fluidaudio_live_diarizer_end_turn")
public func fluidaudio_live_diarizer_end_turn(
    _ ptr: UnsafeMutableRawPointer?,
    _ outCounts: UnsafeMutablePointer<Int32>?
) -> Int32 {
    guard let ptr = ptr, let outCounts = outCounts else { return -1 }
    let bridge = Unmanaged<FluidAudioBridgeInternal>.fromOpaque(ptr).takeUnretainedValue()
    do {
        writeLiveCounts(try bridge.liveDiarizerEndTurn(), outCounts)
        return 0
    } catch {
        bridge.recordError(error)
        return -1
    }
}
```

- [ ] **Step 2: Rust FFI and wrappers**

`src/ffi/bridge.rs`, in the `extern "C"` block:

```rust
    fn fluidaudio_initialize_live_diarizer(
        bridge: *mut std::ffi::c_void,
        progress_callback: Option<ProgressCallback>,
        progress_context: *mut std::ffi::c_void,
    ) -> i32;
    fn fluidaudio_is_live_diarizer_available(bridge: *mut std::ffi::c_void) -> i32;
    fn fluidaudio_live_diarizer_reset(bridge: *mut std::ffi::c_void) -> i32;
    fn fluidaudio_live_diarizer_feed(
        bridge: *mut std::ffi::c_void,
        samples: *const f32,
        count: u32,
        out_counts: *mut i32,
    ) -> i32;
    fn fluidaudio_live_diarizer_end_turn(bridge: *mut std::ffi::c_void, out_counts: *mut i32) -> i32;
```

On `impl FluidAudioBridge`:

```rust
    pub fn initialize_live_diarizer_with_progress<F>(&self, progress_callback: F) -> Result<(), String>
    where
        F: Fn(ModelProgress) + Send + Sync,
    {
        let context = &progress_callback as *const F as *mut std::ffi::c_void;
        let result = unsafe {
            fluidaudio_initialize_live_diarizer(self.ptr, Some(progress_trampoline::<F>), context)
        };
        if result == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to initialize live diarizer"))
        }
    }

    pub fn is_live_diarizer_available(&self) -> bool {
        unsafe { fluidaudio_is_live_diarizer_available(self.ptr) != 0 }
    }

    pub fn live_diarizer_reset(&self) -> Result<(), String> {
        if unsafe { fluidaudio_live_diarizer_reset(self.ptr) } == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to reset live diarizer"))
        }
    }

    fn live_counts(raw: [i32; 4]) -> [u32; 4] {
        raw.map(|count| count.max(0) as u32)
    }

    pub fn live_diarizer_feed(&self, samples: &[f32]) -> Result<[u32; 4], String> {
        let mut raw = [0_i32; 4];
        let result = unsafe {
            fluidaudio_live_diarizer_feed(
                self.ptr,
                samples.as_ptr(),
                samples.len() as u32,
                raw.as_mut_ptr(),
            )
        };
        if result == 0 {
            Ok(Self::live_counts(raw))
        } else {
            Err(self.last_error_message("Failed to process live diarizer audio"))
        }
    }

    pub fn live_diarizer_end_turn(&self) -> Result<[u32; 4], String> {
        let mut raw = [0_i32; 4];
        let result = unsafe { fluidaudio_live_diarizer_end_turn(self.ptr, raw.as_mut_ptr()) };
        if result == 0 {
            Ok(Self::live_counts(raw))
        } else {
            Err(self.last_error_message("Failed to close live diarizer turn"))
        }
    }
```

`src/lib.rs`, after the streaming ASR methods:

```rust
    // ========== Live diarization (speaker labels) ==========

    /// Download and load the Sortformer streaming diarizer.
    pub fn init_live_diarizer_with_progress<F>(&self, progress_callback: F) -> Result<(), FluidAudioError>
    where
        F: Fn(ModelProgress) + Send + Sync,
    {
        self.bridge
            .initialize_live_diarizer_with_progress(progress_callback)
            .map_err(FluidAudioError::from)
    }

    pub fn is_live_diarizer_available(&self) -> bool {
        self.bridge.is_live_diarizer_available()
    }

    /// Start a new session: forgets every speaker.
    pub fn live_diarizer_reset(&self) -> Result<(), FluidAudioError> {
        self.bridge.live_diarizer_reset().map_err(FluidAudioError::from)
    }

    /// Feed 16 kHz mono samples of the current turn; returns how many 80 ms
    /// frames each speaker slot has been active in the turn so far.
    pub fn live_diarizer_feed(&self, samples_16k: &[f32]) -> Result<[u32; 4], FluidAudioError> {
        self.bridge
            .live_diarizer_feed(samples_16k)
            .map_err(FluidAudioError::from)
    }

    /// Close the current turn and return its final per-slot frame counts.
    pub fn live_diarizer_end_turn(&self) -> Result<[u32; 4], FluidAudioError> {
        self.bridge
            .live_diarizer_end_turn()
            .map_err(FluidAudioError::from)
    }
```

Set the vendored crate version to `0.17.4-assistant.3`; run `cargo check --manifest-path src-tauri/Cargo.toml --examples` once without `--locked`.

- [ ] **Step 3: Probe**

Create `src-tauri/examples/live_speakers_probe.rs`:

```rust
//! Feeds turn recordings through the live diarizer the way the app does and
//! reports the speaker picked for each. Usage:
//!   cargo run --example live_speakers_probe -- a1.wav b1.wav a2.wav b2.wav ...

#[cfg(target_os = "macos")]
fn read_16k(path: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let mut reader = hound::WavReader::open(path)?;
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
    Ok(fluidaudio_rs::resample_samples(&mono, spec.sample_rate as f64)?)
}

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use fluidaudio_rs::FluidAudio;
    use std::time::Instant;

    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        return Err("usage: live_speakers_probe <turn.wav>...".into());
    }
    let audio = FluidAudio::new()?;
    let load_started = Instant::now();
    audio.init_live_diarizer_with_progress(|_| {})?;
    println!("model load: {:.1}s", load_started.elapsed().as_secs_f64());

    const STEP: usize = 5_120; // 320 ms at 16 kHz
    for pass in ["cold", "warm"] {
        audio.live_diarizer_reset()?;
        let mut audio_secs = 0.0_f64;
        let mut worst_ms = 0.0_f64;
        let started = Instant::now();
        let mut picks = Vec::new();
        for path in &paths {
            let samples = read_16k(path)?;
            audio_secs += samples.len() as f64 / 16_000.0;
            for chunk in samples.chunks(STEP) {
                let feed_started = Instant::now();
                audio.live_diarizer_feed(chunk)?;
                worst_ms = worst_ms.max(feed_started.elapsed().as_secs_f64() * 1000.0);
            }
            let counts = audio.live_diarizer_end_turn()?;
            let best = (0..4).max_by_key(|&slot| (counts[slot], std::cmp::Reverse(slot)));
            let pick = best.filter(|&slot| counts[slot] >= 3).map(|slot| slot + 1);
            picks.push(pick);
            println!("{pass} {path}: counts {counts:?} -> {pick:?}");
        }
        let elapsed = started.elapsed().as_secs_f64();
        println!(
            "{pass}: audio {audio_secs:.1}s  processing {elapsed:.2}s  speed {:.1}x real time  worst step {worst_ms:.0} ms  picks {picks:?}",
            audio_secs / elapsed
        );
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("live_speakers_probe requires macOS");
}
```

- [ ] **Step 4: Run the probe — go/no-go gate**

Generate six alternating turns with two clearly different system voices (list voices with `say -v '?'`; pick one male and one female English voice), each a different sentence of 4 to 8 seconds, into the scratchpad, then run the probe with the six files in order A, B, A, B, A, B.

Pass criteria, on the **warm** pass:
- picks are `[Some(x), Some(y), Some(x), Some(y), Some(x), Some(y)]` with `x != y`;
- speed is at least 5x real time and the worst step is under 480 ms.

**If either fails, stop and report the output to the user.** Do not continue to Task 2.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/vendor/fluidaudio-rs src-tauri/Cargo.lock src-tauri/examples/live_speakers_probe.rs
git commit -m "feat: expose the Sortformer live diarizer through the bridge"
```

---

### Task 2: Speaker worker

**Files:**
- Create: `src-tauri/src/speaker/live_speakers.rs`
- Modify: `src-tauri/src/speaker/mod.rs` (add `pub(crate) mod live_speakers;`)

**Interfaces:**
- Produces:
  - `pub(crate) type SlotCounts = [u32; 4];`
  - `pub(crate) fn dominant_slot(counts: &SlotCounts) -> Option<usize>`
  - `pub(crate) trait LiveSpeakerModel: Send { fn reset(&mut self) -> Result<(), String>; fn feed(&mut self, samples_16k: &[f32]) -> Result<SlotCounts, String>; fn end_turn(&mut self) -> Result<SlotCounts, String>; }`
  - `#[derive(Debug, Clone, PartialEq, serde::Serialize)] pub(crate) struct SpeakerUpdate { pub turn: u64, pub speaker: Option<String>, #[serde(rename = "final")] pub is_final: bool }`
  - `#[derive(Debug, Clone, PartialEq)] pub(crate) enum LiveSpeakerEvent { Update(SpeakerUpdate), Error(String) }`
  - `pub(crate) struct LiveSpeakerHandle` with `spawn(model: Box<dyn LiveSpeakerModel>, emit: impl FnMut(LiveSpeakerEvent) + Send + 'static) -> Self`, `audio(&self, turn: u64, samples: Vec<f32>)`, `end_turn(&self, turn: u64)`, `dropped(&self) -> u64`, `stop(self, deadline: Duration) -> bool`

- [ ] **Step 1: Write the module (implementation, then tests)**

```rust
//! Best-effort speaker labels for each turn.
//!
//! Mirrors `live_text`: a dedicated thread owns the diarizer, the queue is
//! bounded, sends never wait, and nothing here may slow capture down.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::Duration;

/// About two seconds of capture hops, plus room for end-of-turn messages.
pub(crate) const LIVE_SPEAKER_QUEUE_MESSAGES: usize = 96;
/// A slot must be active for this many 80 ms frames to name the turn.
const MIN_SPEAKER_FRAMES: u32 = 3;

pub(crate) type SlotCounts = [u32; 4];

/// The slot that was active longest, if any was active long enough. Ties go
/// to the lower slot (the earlier speaker).
pub(crate) fn dominant_slot(counts: &SlotCounts) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (slot, &count) in counts.iter().enumerate() {
        if count >= MIN_SPEAKER_FRAMES && best.is_none_or(|current| count > counts[current]) {
            best = Some(slot);
        }
    }
    best
}

fn speaker_name(slot: usize) -> String {
    format!("Speaker {}", slot + 1)
}

pub(crate) trait LiveSpeakerModel: Send {
    /// Start a new session: forget every speaker.
    fn reset(&mut self) -> Result<(), String>;
    /// Feed 16 kHz mono samples of the open turn; per-slot activity so far.
    fn feed(&mut self, samples_16k: &[f32]) -> Result<SlotCounts, String>;
    /// Close the open turn; its final per-slot activity.
    fn end_turn(&mut self) -> Result<SlotCounts, String>;
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct SpeakerUpdate {
    pub turn: u64,
    pub speaker: Option<String>,
    #[serde(rename = "final")]
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LiveSpeakerEvent {
    Update(SpeakerUpdate),
    Error(String),
}

enum Message {
    Audio { turn: u64, samples: Vec<f32> },
    End { turn: u64 },
}

pub(crate) struct LiveSpeakerHandle {
    tx: SyncSender<Message>,
    done: Receiver<()>,
    active: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
}

impl LiveSpeakerHandle {
    pub(crate) fn spawn(
        model: Box<dyn LiveSpeakerModel>,
        emit: impl FnMut(LiveSpeakerEvent) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel(LIVE_SPEAKER_QUEUE_MESSAGES);
        let (done_tx, done) = mpsc::channel();
        let active = Arc::new(AtomicBool::new(true));
        let worker_active = active.clone();
        std::thread::Builder::new()
            .name("live-speakers".into())
            .spawn(move || {
                run_worker(model, rx, worker_active, emit);
                let _ = done_tx.send(());
            })
            .expect("failed to spawn the live-speakers thread");
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

    pub(crate) fn end_turn(&self, turn: u64) {
        self.send(Message::End { turn });
    }

    pub(crate) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    fn send(&self, message: Message) {
        if self.tx.try_send(message).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Let the worker finish what is queued (the last turn's label), up to
    /// the deadline. Returns false if it had not exited by then, in which
    /// case it is muted and left to finish on its own.
    pub(crate) fn stop(self, deadline: Duration) -> bool {
        let Self { tx, done, active, .. } = self;
        drop(tx);
        let finished = done.recv_timeout(deadline).is_ok();
        active.store(false, Ordering::Release);
        finished
    }
}

fn run_worker(
    mut model: Box<dyn LiveSpeakerModel>,
    rx: Receiver<Message>,
    active: Arc<AtomicBool>,
    mut emit: impl FnMut(LiveSpeakerEvent),
) {
    let mut failed = false;
    if let Err(error) = model.reset() {
        failed = true;
        emit(LiveSpeakerEvent::Error(error));
    }
    let mut open_turn: Option<u64> = None;
    let mut provisional: Option<usize> = None;

    // Close `turn` and report its speaker. Returns false after a model error.
    let mut finish = |model: &mut Box<dyn LiveSpeakerModel>,
                      emit: &mut dyn FnMut(LiveSpeakerEvent),
                      turn: u64|
     -> bool {
        match model.end_turn() {
            Ok(counts) => {
                if active.load(Ordering::Acquire) {
                    emit(LiveSpeakerEvent::Update(SpeakerUpdate {
                        turn,
                        speaker: dominant_slot(&counts).map(speaker_name),
                        is_final: true,
                    }));
                }
                true
            }
            Err(error) => {
                if active.load(Ordering::Acquire) {
                    emit(LiveSpeakerEvent::Error(error));
                }
                false
            }
        }
    };

    while let Ok(message) = rx.recv() {
        if failed || !active.load(Ordering::Acquire) {
            continue;
        }
        match message {
            Message::End { turn } => {
                if open_turn == Some(turn) {
                    open_turn = None;
                    provisional = None;
                    failed = !finish(&mut model, &mut emit, turn);
                }
            }
            Message::Audio { turn, samples } => {
                if open_turn != Some(turn) {
                    // The previous turn's End was dropped: close it here so
                    // its label is still reported and its frames cannot be
                    // counted towards this turn.
                    if let Some(previous) = open_turn.take() {
                        if !finish(&mut model, &mut emit, previous) {
                            failed = true;
                            continue;
                        }
                    }
                    open_turn = Some(turn);
                    provisional = None;
                }
                match model.feed(&samples) {
                    Ok(counts) => {
                        let leader = dominant_slot(&counts);
                        if leader.is_some() && leader != provisional && active.load(Ordering::Acquire) {
                            provisional = leader;
                            emit(LiveSpeakerEvent::Update(SpeakerUpdate {
                                turn,
                                speaker: leader.map(speaker_name),
                                is_final: false,
                            }));
                        }
                    }
                    Err(error) => {
                        failed = true;
                        if active.load(Ordering::Acquire) {
                            emit(LiveSpeakerEvent::Error(error));
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Script {
        calls: Vec<String>,
        /// Per-feed counts returned in order; the last repeats.
        feeds: Vec<SlotCounts>,
        /// Per-turn final counts returned in order; the last repeats.
        finals: Vec<SlotCounts>,
        fed: usize,
        ended: usize,
        fail_on_feed: Option<usize>,
    }

    struct FakeModel {
        script: Arc<Mutex<Script>>,
        gate: Option<mpsc::Receiver<()>>,
    }

    impl LiveSpeakerModel for FakeModel {
        fn reset(&mut self) -> Result<(), String> {
            self.script.lock().unwrap().calls.push("reset".into());
            Ok(())
        }

        fn feed(&mut self, samples: &[f32]) -> Result<SlotCounts, String> {
            if let Some(gate) = &self.gate {
                let _ = gate.recv();
            }
            let mut script = self.script.lock().unwrap();
            script.fed += 1;
            if script.fail_on_feed == Some(script.fed) {
                return Err("model exploded".into());
            }
            script.calls.push(format!("feed:{}", samples.len()));
            let index = (script.fed - 1).min(script.feeds.len().saturating_sub(1));
            Ok(script.feeds.get(index).copied().unwrap_or([0; 4]))
        }

        fn end_turn(&mut self) -> Result<SlotCounts, String> {
            let mut script = self.script.lock().unwrap();
            script.ended += 1;
            script.calls.push("end".into());
            let index = (script.ended - 1).min(script.finals.len().saturating_sub(1));
            Ok(script.finals.get(index).copied().unwrap_or([0; 4]))
        }
    }

    fn spawn_with(
        script: Arc<Mutex<Script>>,
        gate: Option<mpsc::Receiver<()>>,
    ) -> (LiveSpeakerHandle, mpsc::Receiver<LiveSpeakerEvent>) {
        let (tx, rx) = mpsc::channel();
        let handle = LiveSpeakerHandle::spawn(Box::new(FakeModel { script, gate }), move |event| {
            let _ = tx.send(event);
        });
        (handle, rx)
    }

    fn next(rx: &mpsc::Receiver<LiveSpeakerEvent>) -> LiveSpeakerEvent {
        rx.recv_timeout(Duration::from_secs(2)).expect("expected an event")
    }

    fn update(turn: u64, speaker: Option<&str>, is_final: bool) -> LiveSpeakerEvent {
        LiveSpeakerEvent::Update(SpeakerUpdate {
            turn,
            speaker: speaker.map(str::to_string),
            is_final,
        })
    }

    #[test]
    fn dominant_slot_needs_a_minimum_and_breaks_ties_low() {
        assert_eq!(dominant_slot(&[0, 0, 0, 0]), None);
        assert_eq!(dominant_slot(&[2, 2, 0, 0]), None);
        assert_eq!(dominant_slot(&[3, 0, 0, 0]), Some(0));
        assert_eq!(dominant_slot(&[3, 9, 0, 0]), Some(1));
        assert_eq!(dominant_slot(&[5, 5, 0, 0]), Some(0));
        assert_eq!(dominant_slot(&[0, 0, 4, 12]), Some(3));
    }

    #[test]
    fn the_final_update_carries_the_wire_name_final() {
        let json = serde_json::to_value(SpeakerUpdate {
            turn: 2,
            speaker: Some("Speaker 1".into()),
            is_final: true,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({"turn": 2, "speaker": "Speaker 1", "final": true}));
    }

    #[test]
    fn a_turn_reports_its_leader_on_change_and_its_speaker_at_the_end() {
        let script = Arc::new(Mutex::new(Script {
            feeds: vec![[1, 0, 0, 0], [4, 0, 0, 0], [5, 0, 0, 0], [5, 9, 0, 0]],
            finals: vec![[5, 12, 0, 0]],
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script.clone(), None);

        for _ in 0..4 {
            handle.audio(1, vec![0.0; 4]);
        }
        handle.end_turn(1);

        assert_eq!(next(&rx), update(1, Some("Speaker 1"), false));
        assert_eq!(next(&rx), update(1, Some("Speaker 2"), false));
        assert_eq!(next(&rx), update(1, Some("Speaker 2"), true));
        assert!(handle.stop(Duration::from_secs(2)));
        assert_eq!(script.lock().unwrap().calls[0], "reset");
    }

    #[test]
    fn a_turn_nobody_dominated_ends_without_a_speaker() {
        let script = Arc::new(Mutex::new(Script {
            finals: vec![[1, 2, 0, 0]],
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script, None);
        handle.audio(1, vec![0.0; 4]);
        handle.end_turn(1);
        assert_eq!(next(&rx), update(1, None, true));
        assert!(handle.stop(Duration::from_secs(2)));
    }

    #[test]
    fn an_unclosed_turn_is_closed_when_the_next_one_starts() {
        let script = Arc::new(Mutex::new(Script {
            finals: vec![[6, 0, 0, 0], [0, 6, 0, 0]],
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script.clone(), None);

        handle.audio(1, vec![0.0; 4]);
        // No end_turn(1): its End was dropped.
        handle.audio(2, vec![0.0; 4]);
        handle.end_turn(2);

        assert_eq!(next(&rx), update(1, Some("Speaker 1"), true));
        assert_eq!(next(&rx), update(2, Some("Speaker 2"), true));
        assert!(handle.stop(Duration::from_secs(2)));
        let calls = script.lock().unwrap().calls.clone();
        assert_eq!(calls, vec!["reset", "feed:4", "end", "feed:4", "end"]);
    }

    #[test]
    fn an_end_for_a_turn_that_never_opened_is_ignored() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (handle, rx) = spawn_with(script.clone(), None);
        handle.end_turn(7);
        assert!(handle.stop(Duration::from_secs(2)));
        assert!(rx.try_recv().is_err());
        assert_eq!(script.lock().unwrap().ended, 0);
    }

    #[test]
    fn stop_lets_the_last_turns_label_through() {
        let script = Arc::new(Mutex::new(Script {
            finals: vec![[8, 0, 0, 0]],
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script, None);
        handle.audio(1, vec![0.0; 4]);
        handle.end_turn(1);
        assert!(handle.stop(Duration::from_secs(2)));
        assert_eq!(next(&rx), update(1, Some("Speaker 1"), true));
    }

    #[test]
    fn a_full_queue_drops_audio_without_blocking_the_sender() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (gate_tx, gate_rx) = mpsc::channel();
        let (handle, _rx) = spawn_with(script, Some(gate_rx));

        let started = Instant::now();
        for _ in 0..(LIVE_SPEAKER_QUEUE_MESSAGES * 3) {
            handle.audio(1, vec![0.0; 4]);
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(handle.dropped() > 0);

        drop(gate_tx);
        assert!(handle.stop(Duration::from_secs(2)));
    }

    #[test]
    fn a_model_error_is_reported_once_and_later_input_is_ignored() {
        let script = Arc::new(Mutex::new(Script {
            fail_on_feed: Some(1),
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script.clone(), None);
        handle.audio(1, vec![0.0; 4]);
        assert_eq!(next(&rx), LiveSpeakerEvent::Error("model exploded".into()));
        handle.audio(1, vec![0.0; 4]);
        handle.end_turn(1);
        assert!(handle.stop(Duration::from_secs(2)));
        assert!(rx.try_recv().is_err());
        assert_eq!(script.lock().unwrap().ended, 0);
    }

    #[test]
    fn stop_gives_up_at_the_deadline_and_a_detached_worker_stays_silent() {
        let script = Arc::new(Mutex::new(Script {
            feeds: vec![[9, 0, 0, 0]],
            ..Script::default()
        }));
        let (gate_tx, gate_rx) = mpsc::channel();
        let (handle, rx) = spawn_with(script, Some(gate_rx));

        handle.audio(1, vec![0.0; 4]);
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        assert!(!handle.stop(Duration::from_millis(100)));
        assert!(started.elapsed() < Duration::from_secs(1));

        drop(gate_tx);
        std::thread::sleep(Duration::from_millis(100));
        assert!(rx.try_recv().is_err(), "a stopped worker must not emit");
    }
}
```

If the borrow checker rejects the `finish` closure (it captures `active` while the loop also reads it), turn it into a free function `fn finish_turn(model: &mut dyn LiveSpeakerModel, active: &AtomicBool, emit: &mut dyn FnMut(LiveSpeakerEvent), turn: u64) -> bool` with the same body.

- [ ] **Step 2: Run**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib speaker::live_speakers`
Expected: 10 passed. Run it three times; the timing-based tests must not flake.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/speaker/live_speakers.rs src-tauri/src/speaker/mod.rs
git commit -m "feat: add the live speaker-label worker"
```

---

### Task 3: Model state, init command, status

**Files:** Modify `src-tauri/src/stt.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 `FluidAudio` methods; Task 2 `LiveSpeakerModel`, `SlotCounts`.
- Produces: `SttState::live_speaker_model(&self) -> Option<Box<dyn LiveSpeakerModel>>` (macOS); command `stt_init_live_speakers`; status field `live_speakers_ready`.

- [ ] **Step 1: Tests first** — mirror the three live-text tests in `stt.rs`: `live_speakers_lock_is_independent_of_asr_and_live_text` (hold `inner` and `live_text`, assert `live_speakers.try_lock().is_ok()`), `live_speaker_model_is_absent_until_initialised` (macOS), `status_reports_live_speakers_as_not_ready_by_default` (hold `inner`, assert `status["live_speakers_ready"] == false`). Run: expect compile failure.

- [ ] **Step 2: Implement** — copy the live-text pattern exactly, with these differences:
  - struct `LiveSpeakersInner { audio: Option<FluidAudio>, ready: bool }`, field `live_speakers: Arc<Mutex<LiveSpeakersInner>>` on `SttState` (and in the hand-built literal inside `stt_diarize_file`);
  - `init_live_speakers_inner` calls `init_live_diarizer_with_progress`, then warms up with `audio.live_diarizer_feed(&[0.0; 16_000]).and_then(|_| audio.live_diarizer_reset())`;
  - adapter `FluidLiveSpeakerModel` implements `reset` → `live_diarizer_reset`, `feed` → `live_diarizer_feed`, `end_turn` → `live_diarizer_end_turn`;
  - `get_status` takes `self.live_speakers.try_lock()` with the other guards and reports `"live_speakers_ready"`; both default JSON blocks get `"live_speakers_ready": false`;
  - command `stt_init_live_speakers`, registered in `lib.rs` after `stt::stt_init_live_text`.

- [ ] **Step 3: Run** `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` — all pass, 3 more than before.

- [ ] **Step 4: Commit** `git commit -am "feat: load the live diarizer and report its status"`

---

### Task 4: One turn feed for both workers, capture-loop wiring

**Files:**
- Create: `src-tauri/src/speaker/turn_feeds.rs`
- Modify: `src-tauri/src/speaker/live_text.rs` (remove `LiveTextTurns` and its two tests), `mod.rs`, `commands.rs`

**Interfaces:**
- Produces:
  - `pub(crate) struct TurnFeeds` with `new(text: Option<LiveTextHandle>, speakers: Option<LiveSpeakerHandle>) -> Self`, `begin(&mut self, lead_in_16k: Vec<f32>) -> u64`, `audio(&self, samples_16k: Vec<f32>)`, `end(&mut self)`, `current(&self) -> u64`, `stop(self, deadline: Duration)`
  - `VadConfig.live_speakers: bool` (serde default `true`)
  - event `speech-speaker` with payload `{ "turn": number, "speaker": string | null, "final": boolean }`

- [ ] **Step 1: Write `turn_feeds.rs`**

```rust
//! One turn counter feeding the live-text and speaker-label workers.
//! Turns are numbered whether or not either worker exists, so
//! `speech-detected` always carries a turn.

use super::live_speakers::LiveSpeakerHandle;
use super::live_text::LiveTextHandle;
use std::time::Duration;
use tracing::warn;

pub(crate) struct TurnFeeds {
    text: Option<LiveTextHandle>,
    speakers: Option<LiveSpeakerHandle>,
    turn: u64,
    in_turn: bool,
}

impl TurnFeeds {
    pub(crate) fn new(text: Option<LiveTextHandle>, speakers: Option<LiveSpeakerHandle>) -> Self {
        Self {
            text,
            speakers,
            turn: 0,
            in_turn: false,
        }
    }

    /// Start the next turn with the audio that preceded the detection.
    pub(crate) fn begin(&mut self, lead_in_16k: Vec<f32>) -> u64 {
        self.turn += 1;
        self.in_turn = true;
        self.audio(lead_in_16k);
        self.turn
    }

    pub(crate) fn audio(&self, samples_16k: Vec<f32>) {
        if !self.in_turn || samples_16k.is_empty() {
            return;
        }
        match (&self.text, &self.speakers) {
            (Some(text), Some(speakers)) => {
                text.audio(self.turn, samples_16k.clone());
                speakers.audio(self.turn, samples_16k);
            }
            (Some(text), None) => text.audio(self.turn, samples_16k),
            (None, Some(speakers)) => speakers.audio(self.turn, samples_16k),
            (None, None) => {}
        }
    }

    pub(crate) fn end(&mut self) {
        if !self.in_turn {
            return;
        }
        self.in_turn = false;
        if let Some(text) = &self.text {
            text.end_turn();
        }
        if let Some(speakers) = &self.speakers {
            speakers.end_turn(self.turn);
        }
    }

    pub(crate) fn current(&self) -> u64 {
        self.turn
    }

    /// Close any open turn and stop both workers, each within `deadline`.
    pub(crate) fn stop(mut self, deadline: Duration) {
        self.end();
        if let Some(text) = self.text.take() {
            let dropped = text.dropped();
            if dropped > 0 {
                warn!("Live text fell behind and skipped {dropped} audio messages this capture");
            }
            if !text.stop(deadline) {
                warn!("Live-text worker did not stop within the deadline; left to finish muted");
            }
        }
        if let Some(speakers) = self.speakers.take() {
            let dropped = speakers.dropped();
            if dropped > 0 {
                warn!("Speaker labels fell behind and skipped {dropped} audio messages this capture");
            }
            if !speakers.stop(deadline) {
                warn!("Speaker-label worker did not stop within the deadline; left to finish muted");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speaker::live_speakers::{LiveSpeakerEvent, LiveSpeakerModel, SlotCounts, SpeakerUpdate};
    use crate::speaker::live_text::{LiveTextEvent, LiveTextModel, LiveTextPartial};
    use std::sync::mpsc;

    struct CountingText(usize);
    impl LiveTextModel for CountingText {
        fn reset(&mut self) -> Result<(), String> {
            self.0 = 0;
            Ok(())
        }
        fn feed(&mut self, _samples: &[f32]) -> Result<String, String> {
            self.0 += 1;
            Ok(format!("t{}", self.0))
        }
    }

    struct FixedSpeaker;
    impl LiveSpeakerModel for FixedSpeaker {
        fn reset(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn feed(&mut self, _samples: &[f32]) -> Result<SlotCounts, String> {
            Ok([0; 4])
        }
        fn end_turn(&mut self) -> Result<SlotCounts, String> {
            Ok([0, 7, 0, 0])
        }
    }

    #[test]
    fn turns_number_from_one_and_reach_both_workers() {
        let (text_tx, text_rx) = mpsc::channel();
        let (speaker_tx, speaker_rx) = mpsc::channel();
        let text = LiveTextHandle::spawn(Box::new(CountingText(0)), move |event| {
            let _ = text_tx.send(event);
        });
        let speakers = LiveSpeakerHandle::spawn(Box::new(FixedSpeaker), move |event| {
            let _ = speaker_tx.send(event);
        });
        let mut feeds = TurnFeeds::new(Some(text), Some(speakers));

        assert_eq!(feeds.current(), 0);
        feeds.audio(vec![0.0; 9]); // before any turn: ignored
        assert_eq!(feeds.begin(vec![0.0; 8]), 1);
        feeds.audio(vec![0.0; 4]);
        feeds.end();
        feeds.end(); // idempotent
        feeds.audio(vec![0.0; 9]); // between turns: ignored
        assert_eq!(feeds.begin(Vec::new()), 2);
        feeds.audio(vec![0.0; 4]);
        feeds.stop(Duration::from_secs(2)); // closes turn 2

        let texts: Vec<LiveTextEvent> = text_rx.try_iter().collect();
        assert_eq!(
            texts,
            vec![
                LiveTextEvent::Partial(LiveTextPartial { turn: 1, text: "t1".into() }),
                LiveTextEvent::Partial(LiveTextPartial { turn: 1, text: "t2".into() }),
                LiveTextEvent::Partial(LiveTextPartial { turn: 2, text: "t1".into() }),
            ]
        );
        let finals: Vec<LiveSpeakerEvent> = speaker_rx.try_iter().collect();
        let expected = |turn| {
            LiveSpeakerEvent::Update(SpeakerUpdate {
                turn,
                speaker: Some("Speaker 2".into()),
                is_final: true,
            })
        };
        assert_eq!(finals, vec![expected(1), expected(2)]);
    }

    #[test]
    fn turns_still_count_without_workers() {
        let mut feeds = TurnFeeds::new(None, None);
        assert_eq!(feeds.begin(vec![0.0; 8]), 1);
        feeds.audio(vec![0.0; 4]);
        feeds.end();
        assert_eq!(feeds.begin(Vec::new()), 2);
        feeds.stop(Duration::from_millis(10));
    }
}
```

Note: `LiveTextHandle::stop` mutes before draining, so in `turns_number_from_one_and_reach_both_workers` the last text partial may be suppressed. If that assertion flakes, change `LiveTextHandle::stop` to drain first and mute only on timeout (the same order `LiveSpeakerHandle::stop` uses) and keep its `stop_gives_up_at_the_deadline...` test passing.

- [ ] **Step 2: Remove `LiveTextTurns`** and its two tests from `live_text.rs` (and the now-unused `tracing::warn` import there); add `pub(crate) mod turn_feeds;` to `mod.rs`.

- [ ] **Step 3: Wire `commands.rs`**
  - `VadConfig`: `#[serde(default = "default_live_text")] pub live_speakers: bool` (the helper already returns `true`), `live_speakers: true` in `Default`. Extend `live_text_defaults_on_and_survives_configs_saved_without_it` to also remove and assert `live_speakers`.
  - `start_system_audio_capture`: beside the live-text spawn, add

```rust
    #[cfg(target_os = "macos")]
    let live_speakers = if vad_config.enabled && vad_config.live_speakers {
        app.try_state::<crate::stt::SttState>()
            .and_then(|stt_state| stt_state.live_speaker_model())
            .map(|model| {
                let emit_app = app.clone();
                live_speakers::LiveSpeakerHandle::spawn(model, move |event| match event {
                    live_speakers::LiveSpeakerEvent::Update(update) => {
                        let _ = emit_app.emit("speech-speaker", update);
                    }
                    live_speakers::LiveSpeakerEvent::Error(error) => {
                        let _ = emit_app.emit("stt-error", format!("Speaker labels stopped: {error}"));
                    }
                })
            })
    } else {
        None
    };
    #[cfg(not(target_os = "macos"))]
    let live_speakers: Option<live_speakers::LiveSpeakerHandle> = None;
```

    and pass it to `run_vad_capture` as a new last argument.
  - `run_vad_capture`: add the parameter, replace `live_text::LiveTextTurns::new(live_text)` with `turn_feeds::TurnFeeds::new(live_text, live_speakers)`. No other loop change: `begin`, `audio`, `end`, `current`, `stop` keep their call sites. The lead-in guard `if hop_16k.is_empty()` already covers both workers.
  - Imports: `use crate::speaker::{live_speakers, turn_feeds};`.

- [ ] **Step 4: Run** all Rust tests and `cargo check`; expect only the two pre-existing dead-code warnings.

- [ ] **Step 5: Commit** `git add src-tauri/src/speaker && git commit -m "feat: feed speaker labels from the VAD capture loop"`

---

### Task 5: Frontend bookkeeping and label attachment

**Files:**
- Create: `src/lib/live-speakers.ts`, `src/lib/live-speakers.test.ts`
- Modify: `src/hooks/system-audio/useVadConfig.ts` (+ test), `src/hooks/useSttStatus.ts`, `src/hooks/useSystemAudio.ts`

**Interfaces:**
- Produces:
  - `export interface SpeakerEvent { turn: number; speaker: string | null; final: boolean }`
  - `export interface LiveSpeakerState { provisional: { turn: number; speaker: string } | null; finals: Record<number, string | null>; messages: Record<number, string> }`
  - `export const emptyLiveSpeakerState: LiveSpeakerState`
  - `export function applySpeakerEvent(state: LiveSpeakerState, event: SpeakerEvent): { state: LiveSpeakerState; label: { messageId: string; speaker: string } | null }`
  - `export function registerTurnMessage(state: LiveSpeakerState, turn: number, messageId: string): { state: LiveSpeakerState; speaker: string | null }`
  - `export function clearProvisionalThroughTurn(state: LiveSpeakerState, turn: number | null | undefined): LiveSpeakerState`
  - `useSystemAudio()` returns `partialSpeaker: string | null`

- [ ] **Step 1: Failing tests** — `src/lib/live-speakers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  applySpeakerEvent,
  clearProvisionalThroughTurn,
  emptyLiveSpeakerState,
  registerTurnMessage,
} from "./live-speakers";

describe("live speaker bookkeeping", () => {
  it("shows the provisional speaker for the turn in progress", () => {
    const { state, label } = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 1,
      speaker: "Speaker 1",
      final: false,
    });
    expect(state.provisional).toEqual({ turn: 1, speaker: "Speaker 1" });
    expect(label).toBeNull();
  });

  it("ignores a provisional speaker from an older turn", () => {
    const first = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 2,
      speaker: "Speaker 2",
      final: false,
    }).state;
    const { state } = applySpeakerEvent(first, {
      turn: 1,
      speaker: "Speaker 1",
      final: false,
    });
    expect(state.provisional).toEqual({ turn: 2, speaker: "Speaker 2" });
  });

  it("hands the label to a message registered after the final arrived", () => {
    const afterFinal = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 1,
      speaker: "Speaker 1",
      final: true,
    });
    expect(afterFinal.label).toBeNull();
    const registered = registerTurnMessage(afterFinal.state, 1, "m1");
    expect(registered.speaker).toBe("Speaker 1");
  });

  it("labels an existing message when the final arrives late", () => {
    const registered = registerTurnMessage(emptyLiveSpeakerState, 1, "m1");
    expect(registered.speaker).toBeNull();
    const { label } = applySpeakerEvent(registered.state, {
      turn: 1,
      speaker: "Speaker 2",
      final: true,
    });
    expect(label).toEqual({ messageId: "m1", speaker: "Speaker 2" });
  });

  it("leaves a message unlabelled when the turn had no clear speaker", () => {
    const registered = registerTurnMessage(emptyLiveSpeakerState, 1, "m1");
    const { label, state } = applySpeakerEvent(registered.state, {
      turn: 1,
      speaker: null,
      final: true,
    });
    expect(label).toBeNull();
    expect(registerTurnMessage(state, 1, "m1").speaker).toBeNull();
  });

  it("drops the provisional speaker when its turn's final arrives", () => {
    const provisional = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 1,
      speaker: "Speaker 1",
      final: false,
    }).state;
    const { state } = applySpeakerEvent(provisional, {
      turn: 1,
      speaker: "Speaker 1",
      final: true,
    });
    expect(state.provisional).toBeNull();
  });

  it("clears the provisional speaker with the provisional text", () => {
    const state = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 3,
      speaker: "Speaker 1",
      final: false,
    }).state;
    expect(clearProvisionalThroughTurn(state, 3).provisional).toBeNull();
    expect(clearProvisionalThroughTurn(state, 2).provisional).not.toBeNull();
    expect(clearProvisionalThroughTurn(state, null).provisional).toBeNull();
  });
});
```

Run: `npx vitest run src/lib/live-speakers.test.ts` — expect FAIL (module missing).

- [ ] **Step 2: Implement** `src/lib/live-speakers.ts`:

```ts
/**
 * Turn → speaker bookkeeping for one capture. The final label for a turn and
 * the transcript message for that turn arrive independently; whichever comes
 * second completes the pair.
 */
export interface SpeakerEvent {
  turn: number;
  speaker: string | null;
  final: boolean;
}

export interface LiveSpeakerState {
  /** Who is speaking in the turn in progress, for the provisional line. */
  provisional: { turn: number; speaker: string } | null;
  /** Final label per turn; null means the turn had no clear speaker. */
  finals: Record<number, string | null>;
  /** Transcript message created for each turn. */
  messages: Record<number, string>;
}

export const emptyLiveSpeakerState: LiveSpeakerState = {
  provisional: null,
  finals: {},
  messages: {},
};

export function applySpeakerEvent(
  state: LiveSpeakerState,
  event: SpeakerEvent,
): {
  state: LiveSpeakerState;
  label: { messageId: string; speaker: string } | null;
} {
  if (!event.final) {
    if (!event.speaker) return { state, label: null };
    if (state.provisional && event.turn < state.provisional.turn) {
      return { state, label: null };
    }
    return {
      state: {
        ...state,
        provisional: { turn: event.turn, speaker: event.speaker },
      },
      label: null,
    };
  }

  const next: LiveSpeakerState = {
    ...state,
    finals: { ...state.finals, [event.turn]: event.speaker },
    provisional:
      state.provisional && state.provisional.turn <= event.turn
        ? null
        : state.provisional,
  };
  const messageId = state.messages[event.turn];
  return {
    state: next,
    label:
      messageId && event.speaker
        ? { messageId, speaker: event.speaker }
        : null,
  };
}

export function registerTurnMessage(
  state: LiveSpeakerState,
  turn: number,
  messageId: string,
): { state: LiveSpeakerState; speaker: string | null } {
  return {
    state: { ...state, messages: { ...state.messages, [turn]: messageId } },
    speaker: state.finals[turn] ?? null,
  };
}

export function clearProvisionalThroughTurn(
  state: LiveSpeakerState,
  turn: number | null | undefined,
): LiveSpeakerState {
  if (!state.provisional) return state;
  if (turn === null || turn === undefined || state.provisional.turn <= turn) {
    return { ...state, provisional: null };
  }
  return state;
}
```

Run the test — expect 7 passed.

- [ ] **Step 3: Config and status**
  - `useVadConfig.ts`: `live_speakers: boolean` on the interface, `live_speakers: true` in the default; assert it in the defaults test. (No storage-key bump: a saved config without the field picks up the default through the existing spread.)
  - `useSttStatus.ts`: `liveSpeakersReady` in `SttStatus`/initial state/`refresh` (from `live_speakers_ready ?? false`), and `initLiveSpeakers`, a copy of `initLiveText` that invokes `stt_init_live_speakers` and warns "Speaker labels are unavailable:". Return it.

- [ ] **Step 4: Hook wiring** in `useSystemAudio.ts`
  - state: `const [partialSpeaker, setPartialSpeaker] = useState<string | null>(null);` and `const liveSpeakersRef = useRef<LiveSpeakerState>(emptyLiveSpeakerState);` with a helper

```ts
  const setLiveSpeakers = useCallback((next: LiveSpeakerState) => {
    liveSpeakersRef.current = next;
    setPartialSpeaker(next.provisional?.speaker ?? null);
  }, []);
```

  - listener, registered with the other capture listeners:

```ts
      scope.add(
        listen(
          "speech-speaker",
          scope.guard((event) => {
            if (!capturingRef.current && !captureStoppingRef.current) return;
            const { state, label } = applySpeakerEvent(
              liveSpeakersRef.current,
              event.payload as SpeakerEvent,
            );
            setLiveSpeakers(state);
            if (label) {
              setConversation((prev) => ({
                ...prev,
                messages: prev.messages.map((message) =>
                  message.id === label.messageId
                    ? { ...message, speaker: label.speaker }
                    : message,
                ),
              }));
              setCurrentSpeaker(label.speaker);
            }
          }),
        ),
      ),
```

    (`captureStoppingRef` is allowed so the last turn's label, emitted while the worker drains at stop, is not dropped.)
  - `appendUtteranceMessage(transcription: string, speaker?: string | null)`: include `...(speaker ? { speaker } : {})` in the new message.
  - in the `speech-detected` handler, replace `const messageId = appendUtteranceMessage(transcription);` with:

```ts
                  let turnSpeaker: string | null = null;
                  const messageId = (() => {
                    if (payload.turn === undefined) {
                      return appendUtteranceMessage(transcription);
                    }
                    // The id must exist before the lookup, so reserve it by
                    // registering after creation and patch if a label waited.
                    const id = appendUtteranceMessage(transcription);
                    const registered = registerTurnMessage(
                      liveSpeakersRef.current,
                      payload.turn,
                      id,
                    );
                    setLiveSpeakers(registered.state);
                    turnSpeaker = registered.speaker;
                    return id;
                  })();
                  if (turnSpeaker) {
                    const speaker = turnSpeaker;
                    setConversation((prev) => ({
                      ...prev,
                      messages: prev.messages.map((message) =>
                        message.id === messageId ? { ...message, speaker } : message,
                      ),
                    }));
                    setCurrentSpeaker(speaker);
                  }
```

    (So `appendUtteranceMessage` needs no signature change after all; leave it as it is.)
  - in that handler's `finally`, beside the live-text clear: `setLiveSpeakers(clearProvisionalThroughTurn(liveSpeakersRef.current, settledTurn));` inside the `ownsTurn` block; in the `speech-discarded` handler: `setLiveSpeakers(clearProvisionalThroughTurn(liveSpeakersRef.current, null));`
  - reset at capture start (`commitStarted`): `setLiveSpeakers(emptyLiveSpeakerState);`. At stop do **not** reset `finals`/`messages` (late final labels still need them); only clear the provisional: `setLiveSpeakers(clearProvisionalThroughTurn(liveSpeakersRef.current, null));`
  - at the STT init site, after the live-text init: `if (vadConfig.enabled && vadConfig.live_speakers && !status.live_speakers_ready) { await initLiveSpeakers(); }` (add `live_speakers_ready?: boolean` to that status type and `initLiveSpeakers` to the dependency array). This init must run for every provider, not only the local one: if the surrounding block is gated on the local provider, hoist the live-speakers init to a place that runs for all providers on macOS in VAD mode, guarded by `isSupported`.
  - return `partialSpeaker` from the hook and add it to the live snapshot object and its dependency array.

- [ ] **Step 5: Gates** `npx tsc --noEmit && npx vitest run` — clean.

- [ ] **Step 6: Commit** `git commit -am "feat: attach live speaker labels to transcript lines"` (after `git add src/lib/live-speakers.ts src/lib/live-speakers.test.ts`).

---

### Task 6: Display and toggle

**Files:** Modify `src/lib/live-session.ts` (+ test fixture), `src/pages/dashboard/index.tsx`, `TranscriptFeed.tsx` (+ test), `ResultsSection.tsx`, `speech/index.tsx`, `SettingsPanel.tsx`

- [ ] **Step 1: Failing test** — add to `TranscriptFeed.test.tsx`:

```tsx
  it("names the speaker on the provisional line when known", () => {
    const text = renderFeed({
      conversation,
      live: true,
      partialTranscription: "and the second one is",
      partialSpeaker: "Speaker 2",
    });
    expect(text).toContain("speaker 2");
    expect(text).not.toContain("hearing");
  });
```

Run — expect a type error / FAIL.

- [ ] **Step 2: Implement**
  - `LiveSessionSnapshot.partialSpeaker: string | null` (fixture: `partialSpeaker: null`); dashboard passes `partialSpeaker={snapshot?.partialSpeaker ?? null}`.
  - `TranscriptFeed`: prop `partialSpeaker?: string | null` (default `null`); the provisional row's label becomes `{(partialSpeaker || "hearing").toLowerCase()}`.
  - `ResultsSection`: prop `partialSpeaker?: string | null`; while `provisional` is non-empty, show `partialSpeaker` in the speaker badge instead of `currentSpeaker` (both render sites): compute `const shownSpeaker = provisional ? partialSpeaker : currentSpeaker;` and use it where `currentSpeaker` is rendered.
  - `speech/index.tsx`: pass `partialSpeaker`.
  - `SettingsPanel`: a "Live speaker labels" row below "Live text", same markup, bound to `vadConfig.live_speakers`, description: "Labels each line with who said it, up to four speakers. Applies to the next capture."

- [ ] **Step 3: Gates** `npx tsc --noEmit && npx vitest run && npm run build`.

- [ ] **Step 4: Commit** `git add src && git commit -m "feat: show the live speaker and add its setting"`

---

### Task 7: Remove the offline pass from the frontend

**Files:** `src/hooks/useSystemAudio.ts`, `src/hooks/system-audio/useSpeakerLabels.ts` (+ test), `src/lib/capture-session-work.ts` (+ test), `src/hooks/useSttStatus.ts`, `src/lib/live-session.ts` (+ test), `ResultsSection.tsx`, `speech/index.tsx`, `src/hooks/system-audio/reconnectCapture.test.ts`

Work from the compiler: delete, run `npx tsc --noEmit`, fix every error by deleting the consumer, repeat.

- [ ] **Step 1:** In `useSystemAudio.ts` remove: the `stt_diarize_file` block at stop and everything that only feeds it (`sessionAudioStopAction`, `utteranceRecordsRef` and the `utteranceRecord` in the `speech-detected` handler, `speakerSegments`, `labelMessagesWithSpeakers*`); every `discardSessionAudio` call and the session paths they consume (stop results are now ignored: `await invoke("stop_system_audio_capture", ...)` without using the result); the `stt_init_diarization` call; `isLabelingSpeakers` from state, snapshot and return. Read `processWithAI` around its `speakerSegments`/`getSpeakerForUtterance` use and remove that segment lookup; `currentSpeaker` is now set only by the live label path from Task 5.
- [ ] **Step 2:** `useSpeakerLabels.ts` shrinks to `currentSpeaker` state only; delete `SpeakerSegment`, `getSpeakerForUtterance`, `applySpeakerLabels`, `labelMessagesWithSpeakers`, and the tests for them. If nothing but `currentSpeaker` remains, inline it into `useSystemAudio` and delete the file and its test.
- [ ] **Step 3:** `capture-session-work.ts`: delete `SessionAudioStopAction`, `getSessionAudioStopAction`, `discardSessionAudio` and their tests; keep `createCaptureSessionWork`.
- [ ] **Step 4:** Remove `isLabelingSpeakers` from `LiveSessionSnapshot`, its fixture, `ResultsSection` (prop and the two "labeling speakers…" spans) and `speech/index.tsx`. Remove `diarizationReady`/`diarization_ready` from `useSttStatus.ts` and any reader.
- [ ] **Step 5:** Fix `reconnectCapture.test.ts` if it references any removed helper.
- [ ] **Step 6: Gates** `npx tsc --noEmit && npx vitest run && npm run build`. Report the test count change (deleted tests).
- [ ] **Step 7: Commit** `git add -A src && git commit -m "refactor: drop the post-stop speaker labelling pass from the frontend"`

The backend still writes and returns a session recording after this task; the frontend ignores it. Task 8 removes it. Between the two commits a capture leaves one temp WAV per session, cleaned by the existing startup sweep.

---

### Task 8: Remove the session recording and offline commands from Rust

**Files:** `src-tauri/src/speaker/commands.rs`, `src-tauri/src/speaker/session_recording.rs` (delete), `src-tauri/src/speaker/mod.rs`, `src-tauri/src/stt.rs`, `src-tauri/src/lib.rs`

Work from the compiler, as in Task 7. Keep the bridge's `init_diarization`/`diarize_file` in the vendored crate: `src-tauri/tests/fluidaudio_accuracy.rs` and `examples/compare_fluidaudio.rs` use them.

- [ ] **Step 1:** `commands.rs`: delete the session-recording block in `run_vad_capture` and the finalisation block at its end; `run_vad_capture` returns `()`. The capture task's `JoinHandle` becomes `JoinHandle<()>`: update `AudioState.stream_task`'s type, `await_capture_shutdown` (returns `()`), the unexpected-end branch (no `orphaned_session_path`), the stop-during-start branch (no WAV discard), and `stop_system_audio_capture` (returns `Result<(), String>`). Delete `sweep_stale_session_wavs` and its call, `write_f32_samples_to_wav` if still unused, and the tests of everything deleted.
- [ ] **Step 2:** Delete `session_recording.rs` and its `mod` line.
- [ ] **Step 3:** `stt.rs`: delete `session_wav_path` and its methods (`set_`, `take_`, `discard_session_wav_path`), the `Drop` impl that removes the file, `diarize_file`, `init_diarization_inner`, `diarization_ready` (struct field and status), `cleanup_session_file_after`, the commands `stt_diarize_file`, `stt_discard_session_audio`, `stt_init_diarization`, and their tests. Remove the three commands from `lib.rs`'s handler list and `orphaned_session_path` from `AudioState`.
- [ ] **Step 4:** `cargo check` must now be warning-free apart from nothing: the two long-standing dead-code warnings (`from_writer`/`discard`, `write_f32_samples_to_wav`) should disappear with the deleted code. Run `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` and `cargo check --locked --manifest-path src-tauri/Cargo.toml --tests --examples` (the accuracy test and examples must still compile).
- [ ] **Step 5: All gates**, then commit: `git add -A src-tauri && git commit -m "refactor: remove the session recording and offline diarization commands"`

---

### Task 9: Final verification and hand-off

- [ ] **Step 1:** Run all five gates; report exact counts.
- [ ] **Step 2:** Set the spec's status to `Implemented on dev; awaiting live validation`; update `docs/plans/2026-09-28-audio-overflow-remediation.md` only if it is tracked (it is not at the time of writing: leave it). Commit the spec.
- [ ] **Step 3:** Ask the user to check, in a real two- or three-person session:
  1. The first capture start downloads the speaker model.
  2. The provisional line names the speaker while they talk.
  3. Each transcript line gets a speaker label as it lands, and labels stay consistent for each person across the session.
  4. Stopping a capture is immediate, with no "labeling speakers…" phase.
  5. The log has no `System-audio drain stall`, `Speaker labels stopped`, or `Live text stopped` lines.
