// Assistant AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
use crate::speaker::preprocessing::{apply_noise_gate, prepare_utterance, PreparedUtterance};
use crate::speaker::live_text;
use crate::speaker::session_recording;
use crate::speaker::{AudioDevice, SpeakerInput};
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use futures_util::StreamExt;
use hound::{WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_shell::ShellExt;
use tracing::{error, warn};

/// Silero VAD contract: 4096-sample chunks of 16 kHz mono audio (256 ms).
const SILERO_CHUNK_SAMPLES: usize = 4096;

#[cfg(target_os = "macos")]
fn samples_for_local_asr(samples: &[f32], sample_rate: u32) -> Result<Vec<f32>, String> {
    fluidaudio_rs::resample_samples(samples, sample_rate as f64).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn resampled_vad_frames(
    accumulator: &mut VadFrameAccumulator,
    samples: &[f32],
    sample_rate: u32,
) -> Result<(Vec<f32>, Vec<[f32; SILERO_CHUNK_SAMPLES]>), String> {
    let samples_16k = samples_for_local_asr(samples, sample_rate)?;
    let frames = accumulator.push(&samples_16k);
    Ok((samples_16k, frames))
}

/// Hysteresis thresholds mirroring the microphone path (@ricky0123/vad-react
/// defaults): enter speech when probability rises above 0.5, only leave once
/// it drops below 0.35. A single hard cutoff drops soft mid-sentence syllables
/// and chops utterances at natural pauses.
const SILERO_POSITIVE_THRESHOLD: f32 = 0.5;
const SILERO_NEGATIVE_THRESHOLD: f32 = 0.35;

#[derive(Default)]
struct VadFrameAccumulator {
    samples: Vec<f32>,
}

impl VadFrameAccumulator {
    fn push(&mut self, samples: &[f32]) -> Vec<[f32; SILERO_CHUNK_SAMPLES]> {
        self.samples.extend_from_slice(samples);
        let complete_samples = (self.samples.len() / SILERO_CHUNK_SAMPLES) * SILERO_CHUNK_SAMPLES;
        if complete_samples == 0 {
            return Vec::new();
        }

        self.samples
            .drain(..complete_samples)
            .collect::<Vec<_>>()
            .chunks_exact(SILERO_CHUNK_SAMPLES)
            .map(|chunk| {
                chunk
                    .try_into()
                    .expect("complete VAD chunks always match the frame size")
            })
            .collect()
    }

    #[cfg(test)]
    fn clear(&mut self) {
        self.samples.clear();
    }
}

/// Peak below which a chunk is treated as "no signal at all" for the no-audio
/// warning. A silent tap (denied permission / wrong output device) delivers
/// exactly 0.0; any real audio, however quiet, exceeds this.
const SILENCE_FLOOR: f32 = 0.0005;

/// Hysteresis decision on a raw Silero probability: enter speech only once the
/// probability rises above the positive threshold, and stay in speech until it
/// drops below the (lower) negative threshold. The gap between the two
/// thresholds is what keeps soft mid-utterance dips from prematurely ending an
/// utterance — a single hard cutoff chops speech at every natural pause.
fn silero_is_speech(in_speech: bool, prob: f32) -> bool {
    if in_speech {
        prob >= SILERO_NEGATIVE_THRESHOLD
    } else {
        prob >= SILERO_POSITIVE_THRESHOLD
    }
}

/// Raw Silero speech probability for a 16 kHz chunk, or
/// None when Silero is unavailable and the threshold fallback should be used.
fn get_silero_vad_probability(app: &AppHandle, samples: &[f32]) -> Result<Option<f32>, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(stt_state) = app.try_state::<crate::stt::SttState>() {
            return stt_state.vad_process_streaming_samples(samples).map(Some);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, samples);
    Ok(None)
}

fn get_silero_vad_probability_mic(app: &AppHandle, samples: &[f32]) -> Result<Option<f32>, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(stt_state) = app.try_state::<crate::stt::SttState>() {
            return stt_state
                .mic_vad_process_streaming_samples(samples)
                .map(Some);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, samples);
    Ok(None)
}

fn consume_vad_probability(
    result: Result<Option<f32>, String>,
    reported: &mut bool,
) -> (Option<f32>, Option<String>) {
    match result {
        Ok(probability) => (probability, None),
        Err(error) if take_first_error(reported) => (None, Some(error)),
        Err(_) => (None, None),
    }
}

trait CaptureVadReset {
    fn reset_capture_vad(&self) -> Result<(), String>;
}

trait DictationVadReset {
    fn reset_dictation_vad(&self) -> Result<(), String>;
}

#[cfg(target_os = "macos")]
impl CaptureVadReset for crate::stt::SttState {
    fn reset_capture_vad(&self) -> Result<(), String> {
        self.reset_vad_stream()
    }
}

#[cfg(target_os = "macos")]
impl DictationVadReset for crate::stt::SttState {
    fn reset_dictation_vad(&self) -> Result<(), String> {
        self.reset_mic_vad_stream()
    }
}

fn reset_vad_for_capture(reset: Option<&dyn CaptureVadReset>) -> Result<(), String> {
    match reset {
        Some(reset) => reset.reset_capture_vad(),
        None => Ok(()),
    }
}

fn reset_vad_for_dictation(reset: Option<&dyn DictationVadReset>) -> Result<(), String> {
    match reset {
        Some(reset) => reset.reset_dictation_vad(),
        None => Ok(()),
    }
}

/// Cache an utterance's samples and announce it to the frontend.
///
/// The payload carries both the base64 WAV (which remote STT providers upload
/// as-is) and an `utterance_id`. The local STT path claims the id instead,
/// transcribing the samples we still hold here rather than decoding the WAV
/// and shipping the samples back over IPC.
fn emit_speech_detected(
    app: &AppHandle,
    sr: u32,
    samples: &[f32],
    noise_gate_threshold: f32,
    compare_preprocessing: bool,
    start_time: f32,
    end_time: f32,
    turn: u64,
) {
    let PreparedUtterance { raw, processed } =
        prepare_utterance(samples, noise_gate_threshold, compare_preprocessing);
    if processed.is_empty() {
        let _ = app.emit(
            "audio-encoding-error",
            "Captured audio was empty after normalization",
        );
        return;
    }

    let Ok(b64) = samples_to_wav_b64(sr, &processed) else {
        error!("Failed to encode speech to WAV");
        let _ = app.emit("audio-encoding-error", "Failed to encode speech");
        return;
    };

    #[cfg(target_os = "macos")]
    let utterance_id = match samples_for_local_asr(&processed, sr) {
        Ok(primary_samples) => {
            let comparison_samples = if compare_preprocessing {
                match samples_for_local_asr(&raw, sr) {
                    Ok(samples) => Some(samples),
                    Err(error) => {
                        let _ = app.emit(
                            "stt-error",
                            format!("Failed to resample comparison audio: {error}"),
                        );
                        None
                    }
                }
            } else {
                None
            };
            app.state::<crate::stt::UtteranceStore>().put_capture(
                primary_samples,
                comparison_samples,
                sr,
                samples.len() as f64 / sr as f64,
            )
        }
        Err(error) => {
            let _ = app.emit(
                "audio-encoding-error",
                format!("Failed to resample captured speech: {error}"),
            );
            None
        }
    };
    #[cfg(not(target_os = "macos"))]
    let utterance_id: Option<String> = None;

    let _ = app.emit(
        "speech-detected",
        serde_json::json!({
            "audio": b64,
            "utterance_id": utterance_id,
            "start_time": start_time,
            "end_time": end_time,
            "turn": turn,
        }),
    );
}

// VAD Configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    pub enabled: bool,
    pub hop_size: usize,
    pub sensitivity_rms: f32,
    pub peak_threshold: f32,
    pub silence_chunks: usize,
    pub min_speech_chunks: usize,
    pub pre_speech_chunks: usize,
    pub noise_gate_threshold: f32,
    pub max_recording_duration_secs: u64,
    #[serde(default)]
    pub emit_chunks: bool,
    #[serde(default)]
    pub compare_preprocessing: bool,
    /// Show provisional text for the turn in progress (macOS, local model).
    #[serde(default = "default_live_text")]
    pub live_text: bool,
    #[serde(default = "default_chunk_interval")]
    pub chunk_interval_ms: u64,
}

fn default_live_text() -> bool {
    true
}

fn default_chunk_interval() -> u64 {
    1000
}

impl VadConfig {
    /// Bounds that keep the capture loop safe. `hop_size` feeds
    /// `Vec::with_capacity` / `VecDeque::with_capacity` in the capture task,
    /// where an unbounded value overflows capacity and panics the spawned
    /// task (which skips its slot cleanup and wedges capture).
    pub fn validate(&self) -> Result<(), String> {
        if !(256..=8192).contains(&self.hop_size) {
            return Err("Invalid hop_size: must be 256-8192".to_string());
        }
        if self.pre_speech_chunks > 600 {
            return Err("Invalid pre_speech_chunks: must be <= 600".to_string());
        }
        if self.silence_chunks > 600 {
            return Err("Invalid silence_chunks: must be <= 600".to_string());
        }
        if self.chunk_interval_ms < 100 {
            return Err("Invalid chunk_interval_ms: must be >= 100".to_string());
        }
        if self.sensitivity_rms < 0.0 || self.sensitivity_rms > 1.0 {
            return Err("Invalid sensitivity_rms: must be 0.0-1.0".to_string());
        }
        if self.noise_gate_threshold <= 0.0 {
            return Err("Invalid noise_gate_threshold: must be > 0.0".to_string());
        }
        if self.max_recording_duration_secs == 0 || self.max_recording_duration_secs > 3600 {
            return Err("Invalid max_recording_duration_secs: must be 1-3600".to_string());
        }
        Ok(())
    }
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            hop_size: 1024,
            sensitivity_rms: 0.006, // Tuned for system audio which is quieter than mic speech
            peak_threshold: 0.020,  // Lower threshold to catch quiet video/call audio
            // Tunables are sample-rate-dependent, tuned for 48 kHz:
            // hop_size 1024 = 21.3 ms/hop. At 96 kHz these halve in wall
            // time (silence 100 -> 1.07 s); at 44.1 kHz they scale ~linearly.
            silence_chunks: 100, // ~2.1s of silence before stopping (tolerates thinking pauses)
            min_speech_chunks: 12, // ~0.26s - matches the mic path's minSpeechFrames
            pre_speech_chunks: 30, // ~0.64s - covers 2+ Silero refresh periods (256ms each) so
            // the word onset survives until VAD triggers
            noise_gate_threshold: 0.0015, // Gentler gate for compressed system audio
            max_recording_duration_secs: 180, // 3 minutes default
            emit_chunks: false,
            compare_preprocessing: false,
            live_text: true,
            chunk_interval_ms: 1000,
        }
    }
}

/// Mutex-protected slot for the currently running capture task.
///
/// A reservation is acquired before setup and spawning, so concurrent starts
/// cannot create detached duplicate capture tasks. `release_if_owned` lets a
/// finishing task clear the slot only while it still holds its own handle.
enum TaskSlotState<T> {
    Vacant,
    /// A start holds the slot while it sets up and spawns. `stop_requested`
    /// records a stop that arrived in that window so `install` can report it.
    Starting { stop_requested: bool },
    /// A stop holds the slot until the task it took has shut down.
    Stopping,
    Running(tokio::task::JoinHandle<T>),
}

pub struct TaskSlot<T> {
    inner: std::sync::Mutex<TaskSlotState<T>>,
}

pub struct TaskReservation<'a, T> {
    slot: &'a TaskSlot<T>,
    active: bool,
}

pub struct TaskStopReservation<'a, T> {
    slot: &'a TaskSlot<T>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TaskInstallOutcome {
    Running,
    Finished,
    /// A stop was requested while the start was still setting up. The task is
    /// installed; the starter must stop it instead of reporting success.
    StopRequested,
}

impl<T> TaskSlot<T> {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(TaskSlotState::Vacant),
        }
    }

    pub fn reserve(&self, already_running: &str) -> Result<TaskReservation<'_, T>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;
        match &*guard {
            TaskSlotState::Vacant => {
                *guard = TaskSlotState::Starting {
                    stop_requested: false,
                };
                Ok(TaskReservation {
                    slot: self,
                    active: true,
                })
            }
            TaskSlotState::Starting { .. }
            | TaskSlotState::Stopping
            | TaskSlotState::Running(_) => Err(already_running.to_string()),
        }
    }

    /// Record a stop that arrived while a start still holds the slot. Returns
    /// true when a start was in flight: there is no task to take yet, and the
    /// starter stops the capture itself once `install` reports the request.
    pub fn request_stop_during_start(&self) -> Result<bool, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire task lock: {}", e))?;
        match &mut *guard {
            TaskSlotState::Starting { stop_requested } => {
                *stop_requested = true;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Clear the slot, but only if it still holds the task with id `my_id`.
    /// Called by a finishing task; a stale task can never clobber a newer
    /// capture's entry.
    pub fn release_if_owned(&self, my_id: tokio::task::Id) {
        if let Ok(mut guard) = self.inner.lock() {
            if matches!(&*guard, TaskSlotState::Running(task) if task.id() == my_id) {
                *guard = TaskSlotState::Vacant;
            }
        }
    }

    /// Take the registered task out of the slot (stop path).
    pub fn take(&self) -> Result<Option<tokio::task::JoinHandle<T>>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire task lock: {}", e))?;
        match std::mem::replace(&mut *guard, TaskSlotState::Vacant) {
            TaskSlotState::Running(task) => Ok(Some(task)),
            TaskSlotState::Vacant | TaskSlotState::Starting { .. } | TaskSlotState::Stopping => {
                Ok(None)
            }
        }
    }

    pub fn take_for_stop(
        &self,
    ) -> Result<
        (
            Option<tokio::task::JoinHandle<T>>,
            TaskStopReservation<'_, T>,
        ),
        String,
    > {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire task lock: {}", e))?;
        match &*guard {
            TaskSlotState::Stopping => return Err("Task stop already in progress".to_string()),
            TaskSlotState::Starting { .. } => return Err("Task start in progress".to_string()),
            TaskSlotState::Vacant | TaskSlotState::Running(_) => {}
        }
        let task = match std::mem::replace(&mut *guard, TaskSlotState::Stopping) {
            TaskSlotState::Running(task) => Some(task),
            _ => None,
        };
        Ok((task, TaskStopReservation { slot: self }))
    }
}

impl<T> Drop for TaskStopReservation<'_, T> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.slot.inner.lock() {
            if matches!(&*guard, TaskSlotState::Stopping) {
                *guard = TaskSlotState::Vacant;
            }
        }
    }
}

impl<T> TaskReservation<'_, T> {
    pub fn install(
        mut self,
        task: tokio::task::JoinHandle<T>,
    ) -> Result<TaskInstallOutcome, String> {
        let mut guard = match self.slot.inner.lock() {
            Ok(guard) => guard,
            Err(error) => {
                task.abort();
                return Err(format!("Failed to acquire lock: {}", error));
            }
        };
        let stop_requested = match &*guard {
            TaskSlotState::Starting { stop_requested } => *stop_requested,
            _ => {
                task.abort();
                return Err("Task slot reservation was lost".to_string());
            }
        };
        let outcome = if task.is_finished() {
            *guard = TaskSlotState::Vacant;
            TaskInstallOutcome::Finished
        } else {
            *guard = TaskSlotState::Running(task);
            if stop_requested {
                TaskInstallOutcome::StopRequested
            } else {
                TaskInstallOutcome::Running
            }
        };
        self.active = false;
        Ok(outcome)
    }
}

impl<T> Drop for TaskReservation<'_, T> {
    fn drop(&mut self) {
        if self.active {
            if let Ok(mut guard) = self.slot.inner.lock() {
                if matches!(&*guard, TaskSlotState::Starting { .. }) {
                    *guard = TaskSlotState::Vacant;
                }
            }
        }
    }
}

impl<T> Default for TaskSlot<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    vad_config: Option<VadConfig>,
    device_id: Option<String>,
    streaming: Option<bool>,
) -> Result<(), String> {
    let state = app.state::<crate::AudioState>();
    let reservation = state.stream_task.reserve("Capture already running")?;

    if let Some(mut config) = vad_config {
        config.validate()?;
        let stream_enabled = streaming.unwrap_or(false);
        if stream_enabled {
            config.emit_chunks = true;
        }
        let mut vad_cfg = state
            .vad_config
            .lock()
            .map_err(|e| format!("Failed to acquire VAD config lock: {}", e))?;
        *vad_cfg = config;
    }

    // Only monitor for default-output-device switches when we're actually
    // tapping the default device (not a user-pinned one). Captured before the
    // tap is built, so it reflects the device the tap binds to.
    let on_default_device = device_id
        .as_deref()
        .is_none_or(|d| d.is_empty() || d == "default");
    let monitor_output_uid = if on_default_device {
        crate::speaker::default_output_uid()
    } else {
        None
    };

    let input = SpeakerInput::new_with_device(device_id).map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    let stream = input.stream().map_err(|e| {
        error!("Failed to start audio stream: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;
    let sr = stream.sample_rate();

    if !(8000..=96000).contains(&sr) {
        error!("Invalid sample rate: {}", sr);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sr
        ));
    }

    let app_clone = app.clone();
    let vad_config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {}", e))?
        .clone();

    #[cfg(target_os = "macos")]
    {
        let stt_state = app.try_state::<crate::stt::SttState>();
        reset_vad_for_capture(
            stt_state
                .as_deref()
                .map(|state| state as &dyn CaptureVadReset),
        )?;
    }

    state.stop_flag.store(false, Ordering::Release);
    // A discard applies to one take only; every new take starts wanted.
    state.discard_take.store(false, Ordering::Release);
    let stop_flag = state.stop_flag.clone();
    let stop_requested = state.stop_flag.clone();
    let discard_flag = state.discard_take.clone();

    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set capturing state: {}", e))? = true;

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

    let task = tokio::spawn(async move {
        let session_path = if vad_config.enabled {
            run_vad_capture(
                app_clone.clone(),
                stream,
                sr,
                vad_config,
                monitor_output_uid,
                stop_flag,
                live_text,
            )
            .await
        } else {
            run_continuous_capture(
                app_clone.clone(),
                stream,
                sr,
                vad_config,
                stop_flag,
                discard_flag,
            )
            .await;
            None
        };

        // Release the task slot, but only while it still holds this task:
        // a newer capture may have claimed the slot since (never clobber a
        // live task's entry).
        let state = app_clone.state::<crate::AudioState>();
        state.stream_task.release_if_owned(tokio::task::id());

        // A stream that ends without a stop request (device disconnect,
        // sleep/wake, stream failure) has nothing left to tell the frontend
        // it is over: `capture-stopped` is only emitted by
        // `stop_system_audio_capture`, which nobody called. Without this the
        // UI stays on "listening" forever.
        if !stop_requested.load(Ordering::Acquire) {
            if let Ok(mut is_capturing) = state.is_capturing.lock() {
                *is_capturing = false;
            }
            if let Ok(mut orphaned) = state.orphaned_session_path.lock() {
                *orphaned = session_path.clone();
            }
            let _ = app_clone.emit("capture-ended-unexpectedly", ());
        }

        session_path
    });

    match reservation.install(task) {
        Ok(TaskInstallOutcome::Running) => {}
        Ok(TaskInstallOutcome::Finished) => {
            if let Ok(mut is_capturing) = state.is_capturing.lock() {
                *is_capturing = false;
            }
            return Err("Audio capture ended during startup".to_string());
        }
        Ok(TaskInstallOutcome::StopRequested) => {
            // A stop raced this start and found no task to take. Honor it
            // here: the stop flag may have been reset above, so set it again,
            // then shut the task down exactly as the stop command would.
            state.stop_flag.store(true, Ordering::Release);
            if let Ok((Some(task), stop_reservation)) = state.stream_task.take_for_stop() {
                let session_path = await_capture_shutdown(task, Duration::from_secs(5)).await;
                drop(stop_reservation);
                // Nobody is left to diarize a take that was stopped before
                // it was announced.
                #[cfg(target_os = "macos")]
                if let (Some(path), Some(stt_state)) =
                    (session_path, app.try_state::<crate::stt::SttState>())
                {
                    let _ = stt_state.discard_session_wav_path(&path.to_string_lossy());
                }
                #[cfg(not(target_os = "macos"))]
                let _ = session_path;
            }
            if let Ok(mut is_capturing) = state.is_capturing.lock() {
                *is_capturing = false;
            }
            return Err("Capture stopped during startup".to_string());
        }
        Err(error) => {
            if let Ok(mut is_capturing) = state.is_capturing.lock() {
                *is_capturing = false;
            }
            warn!("{}", error);
            return Err(error);
        }
    }

    let _ = app.emit("capture-started", sr);

    Ok(())
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
#[cfg(any(target_os = "macos", test))]
struct CaptureDrainMonitor {
    last_hop: Instant,
    last_report: Option<Instant>,
}

#[cfg(any(target_os = "macos", test))]
impl CaptureDrainMonitor {
    fn observe(&mut self, started: Instant, processing: Duration) -> Option<Duration> {
        let gap = started.saturating_duration_since(self.last_hop);
        self.last_hop = started;
        if gap < Duration::from_millis(500) && processing < Duration::from_millis(500) {
            return None;
        }
        if self
            .last_report
            .is_some_and(|last| started.saturating_duration_since(last) < Duration::from_secs(10))
        {
            return None;
        }
        self.last_report = Some(started);
        Some(gap)
    }
}

async fn run_vad_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    // When Some, the UID of the default output device this capture bound to.
    // If it changes mid-session, we emit `audio-device-changed` and stop so
    // the frontend can restart on the new device instead of silently tapping
    // the old one.
    monitor_output_uid: Option<String>,
    stop_flag: Arc<AtomicBool>,
    live_text: Option<live_text::LiveTextHandle>,
) -> Option<std::path::PathBuf> {
    let mut stream = stream;
    let mut live_turns = live_text::LiveTextTurns::new(live_text);
    let mut last_device_check = Instant::now();
    // Input-level metering + no-audio detection (see the emit sites below).
    let mut last_level_emit = Instant::now();
    let mut level_window_peak: f32 = 0.0;
    let mut ever_had_signal = false;
    let mut silent_warned = false;
    let mut buffer: VecDeque<f32> = VecDeque::new();
    let mut pre_speech: VecDeque<f32> =
        VecDeque::with_capacity(config.pre_speech_chunks * config.hop_size);
    let mut speech_buffer = Vec::new();
    let mut in_speech = false;
    let mut silence_chunks = 0;
    let mut speech_chunks = 0;
    let max_samples = sr as usize * 30; // 30s safety cap per utterance

    let chunk_interval = Duration::from_millis(config.chunk_interval_ms);

    let mut last_emitted_len: usize = 0;
    let mut last_chunk_time: Option<Instant> = None;

    let session_start = Instant::now();
    #[cfg(target_os = "macos")]
    let mut drain_monitor = CaptureDrainMonitor {
        last_hop: session_start,
        last_report: None,
    };
    #[cfg(target_os = "macos")]
    let mut last_hop_end = session_start;
    #[cfg(target_os = "macos")]
    let mut session_recording: Option<
        session_recording::SessionRecording<std::io::BufWriter<std::fs::File>>,
    > = None;
    #[cfg(target_os = "macos")]
    let mut session_recording_issue_reported = false;
    let mut vad_accumulator = VadFrameAccumulator::default();
    let mut vad_resample_error_reported = false;
    let mut vad_processing_error_reported = false;
    // macOS assumes silence until the first Silero result; elsewhere Silero
    // never runs, so start at None to engage the threshold fallback.
    let mut pending_silero_prob: Option<f32> = if cfg!(target_os = "macos") {
        Some(0.0)
    } else {
        None
    };
    let mut utterance_start_time: f32 = 0.0;
    // Utterance times are positions in the captured audio, not wall-clock
    // readings: after a processing stall the loop catches up on buffered
    // audio, and the clock would stamp those utterances late and misalign
    // them with the session WAV that diarization reads.
    let mut samples_processed: u64 = 0;
    let audio_position_secs = |samples: u64| (samples as f64 / sr as f64) as f32;

    while let Some(sample) = stream.next().await {
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        // Detect a mid-session default-output-device switch (checked ~1x/sec so
        // the CoreAudio query stays off the hot path). On a switch the tap is
        // still bound to the old device and would capture silence, so stop and
        // let the frontend restart on the new device.
        if let Some(ref bound_uid) = monitor_output_uid {
            if last_device_check.elapsed() >= Duration::from_secs(1) {
                last_device_check = Instant::now();
                if let Some(current_uid) = crate::speaker::default_output_uid() {
                    if &current_uid != bound_uid {
                        warn!(
                            "Default output device changed mid-capture ({} -> {}); \
                             restarting on the new device",
                            bound_uid, current_uid
                        );
                        let _ = app.emit("audio-device-changed", ());
                        break;
                    }
                }
            }
        }

        buffer.push_back(sample);

        // Process in fixed chunks for VAD analysis
        while buffer.len() >= config.hop_size {
            #[cfg(target_os = "macos")]
            let hop_started = Instant::now();
            let mut mono = Vec::with_capacity(config.hop_size);
            for _ in 0..config.hop_size {
                if let Some(v) = buffer.pop_front() {
                    mono.push(v);
                }
            }

            // Keep the raw samples for VAD: the mic path (vad-react) feeds
            // Silero ungated audio, and gating first zeroes quiet speech
            // onsets. The gate still applies to the recorded/streamed audio.
            let raw_mono = mono;
            samples_processed += raw_mono.len() as u64;

            // Track the raw input level (pre-gate) for the UI meter and the
            // no-audio warning. A flat meter / warning surfaces the silent-tap
            // failure (denied permission, wrong device) that otherwise looks
            // exactly like "listening but nothing happens".
            let chunk_peak = raw_mono.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
            level_window_peak = level_window_peak.max(chunk_peak);
            if chunk_peak > SILENCE_FLOOR {
                ever_had_signal = true;
            }
            if last_level_emit.elapsed() >= Duration::from_millis(150) {
                last_level_emit = Instant::now();
                let _ = app.emit("audio-level", level_window_peak);
                level_window_peak = 0.0;
            }
            if !ever_had_signal
                && !silent_warned
                && session_start.elapsed() >= Duration::from_secs(8)
            {
                warn!("No system audio detected 8s into capture — likely a permission or output-device issue");
                let _ = app.emit("audio-silent", ());
                silent_warned = true;
            }

            #[cfg(target_os = "macos")]
            {
                if session_recording.is_none() && !session_recording_issue_reported {
                    let temp_path = std::env::temp_dir()
                        .join(format!("assistant-session-{}.wav", uuid::Uuid::new_v4()));
                    match session_recording::SessionRecording::create_file(
                        temp_path,
                        sr,
                        sr as usize * session_recording::SESSION_RECORDING_MAX_SECS as usize,
                    ) {
                        Ok(recording) => session_recording = Some(recording),
                        Err(e) => {
                            session_recording_issue_reported = true;
                            error!("Failed to open session recording: {}", e);
                            let _ = app.emit(
                                "stt-error",
                                "Speaker labels are unavailable for this session.",
                            );
                        }
                    }
                }
                if let Some(recording) = session_recording.as_mut() {
                    match recording.append(&raw_mono) {
                        Ok(session_recording::AppendOutcome::Appended) => {}
                        Ok(session_recording::AppendOutcome::Full) => {
                            session_recording = None;
                            if !session_recording_issue_reported {
                                session_recording_issue_reported = true;
                                let message = "Speaker labels cover the first hour of a session.";
                                error!("{}", message);
                                let _ = app.emit("stt-error", message);
                            }
                        }
                        Err(e) => {
                            session_recording = None;
                            if !session_recording_issue_reported {
                                session_recording_issue_reported = true;
                                error!("Session recording failed: {}", e);
                                let _ = app.emit(
                                    "stt-error",
                                    "Speaker labels are unavailable for this session.",
                                );
                            }
                        }
                    }
                }
            }

            #[cfg(target_os = "macos")]
            let (resample_duration, vad_duration, hop_16k) = {
                let resample_started = Instant::now();
                // The 16 kHz samples are kept for live text; VAD only needs
                // the complete frames.
                let (hop_16k, frames) =
                    match resampled_vad_frames(&mut vad_accumulator, &raw_mono, sr) {
                        Ok((samples_16k, frames)) => (samples_16k, Ok(frames)),
                        Err(error) => (Vec::new(), Err(error)),
                    };
                let resample_duration = resample_started.elapsed();
                let vad_started = Instant::now();
                match frames {
                    Ok(frames) => {
                        for frame in frames {
                            let (probability, error) = consume_vad_probability(
                                get_silero_vad_probability(&app, &frame),
                                &mut vad_processing_error_reported,
                            );
                            pending_silero_prob = probability;
                            if let Some(error) = error {
                                let _ = app.emit(
                                    "stt-error",
                                    format!("FluidAudio VAD processing failed: {error}"),
                                );
                            }
                        }
                    }
                    Err(error) => {
                        if take_first_error(&mut vad_resample_error_reported) {
                            let _ = app.emit(
                                "stt-error",
                                format!("Failed to resample VAD audio: {error}"),
                            );
                        }
                        pending_silero_prob = None;
                    }
                }
                (resample_duration, vad_started.elapsed(), hop_16k)
            };
            #[cfg(not(target_os = "macos"))]
            let hop_16k: Vec<f32> = Vec::new();

            let is_speech = match pending_silero_prob {
                // Mic-style hysteresis on the raw probability.
                Some(prob) => silero_is_speech(in_speech, prob),
                None => fallback_vad_is_speech(&raw_mono, &config),
            };

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;

                    // Live text starts from the same lead-in the utterance
                    // gets, so its first word is not clipped.
                    #[cfg(target_os = "macos")]
                    let lead_in_16k = if hop_16k.is_empty() {
                        Vec::new()
                    } else {
                        let lead_in: Vec<f32> = pre_speech.iter().copied().collect();
                        samples_for_local_asr(&lead_in, sr).unwrap_or_default()
                    };
                    #[cfg(not(target_os = "macos"))]
                    let lead_in_16k = Vec::new();
                    live_turns.begin(lead_in_16k);

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    utterance_start_time = audio_position_secs(samples_processed);

                    let _ = app.emit("speech-start", ());
                    last_emitted_len = 0;
                    last_chunk_time = Some(Instant::now());
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&raw_mono);
                live_turns.audio(hop_16k);
                silence_chunks = 0; // Reset silence counter on any speech

                if config.emit_chunks {
                    // Emit incremental streaming chunks for custom providers
                    if let Some(t) = last_chunk_time {
                        if t.elapsed() >= chunk_interval && speech_buffer.len() > last_emitted_len {
                            let new_samples = &speech_buffer[last_emitted_len..];
                            let processed =
                                prepare_utterance(new_samples, config.noise_gate_threshold, false)
                                    .processed;
                            if let Ok(b64) = samples_to_raw_f32_b64(&processed) {
                                let _ = app.emit("speech-chunk", b64);
                            }
                            last_emitted_len = speech_buffer.len();
                            last_chunk_time = Some(Instant::now());
                        }
                    }
                }

                // Safety cap: force emit if exceeds 30s
                if speech_buffer.len() > max_samples {
                    let utterance_end_time = audio_position_secs(samples_processed);
                    emit_speech_detected(
                        &app,
                        sr,
                        &speech_buffer,
                        config.noise_gate_threshold,
                        config.compare_preprocessing,
                        utterance_start_time,
                        utterance_end_time,
                        live_turns.current(),
                    );
                    live_turns.end();
                    speech_buffer.clear();
                    in_speech = false;
                    speech_chunks = 0;
                    last_emitted_len = 0;
                    last_chunk_time = None;
                }
            } else {
                // Silence detected
                if in_speech {
                    silence_chunks += 1;

                    // Continue collecting during silence (important for natural speech)
                    speech_buffer.extend_from_slice(&raw_mono);
                    live_turns.audio(hop_16k);

                    // Check if silence duration exceeds threshold
                    if silence_chunks >= config.silence_chunks {
                        if speech_chunks >= config.min_speech_chunks && !speech_buffer.is_empty() {
                            // Trim trailing silence (keep ~0.15s for natural ending)
                            let silence_duration_samples = silence_chunks * config.hop_size;
                            let keep_silence_samples = (sr as usize) * 15 / 100; // 0.15s
                            let trim_amount =
                                silence_duration_samples.saturating_sub(keep_silence_samples);

                            if speech_buffer.len() > trim_amount {
                                speech_buffer.truncate(speech_buffer.len() - trim_amount);
                            }

                            let utterance_end_time = audio_position_secs(samples_processed);
                            emit_speech_detected(
                                &app,
                                sr,
                                &speech_buffer,
                                config.noise_gate_threshold,
                                config.compare_preprocessing,
                                utterance_start_time,
                                utterance_end_time,
                                live_turns.current(),
                            );
                        } else {
                            let _ = app.emit(
                                "speech-discarded",
                                "Audio too short (likely background noise)",
                            );
                        }

                        live_turns.end();
                        // Reset for next speech detection
                        speech_buffer.clear();
                        in_speech = false;
                        silence_chunks = 0;
                        speech_chunks = 0;
                        last_emitted_len = 0;
                        last_chunk_time = None;
                    }
                } else {
                    // Not in speech yet - maintain rolling pre-speech buffer
                    pre_speech.extend(raw_mono.into_iter());

                    // Trim excess (maintain fixed size)
                    while pre_speech.len() > config.pre_speech_chunks * config.hop_size {
                        pre_speech.pop_front();
                    }

                    // Periodically shrink capacity to prevent memory bloat
                    if pre_speech.len() == config.pre_speech_chunks * config.hop_size {
                        pre_speech.shrink_to_fit();
                    }
                }
            }

            // Measured at the end of the hop so `processing_ms` covers the
            // speech state machine and utterance emission too; `wait_ms` is
            // the part of the gap spent outside hop processing (awaiting
            // samples or the executor).
            #[cfg(target_os = "macos")]
            {
                let wait_duration = hop_started.saturating_duration_since(last_hop_end);
                let processing_duration = hop_started.elapsed();
                last_hop_end = Instant::now();
                if let Some(gap) = drain_monitor.observe(hop_started, processing_duration) {
                    warn!(
                        "System-audio drain stall: gap_ms={}, wait_ms={}, processing_ms={}, resample_ms={}, vad_ms={}, sample_rate={}",
                        gap.as_millis(), wait_duration.as_millis(),
                        processing_duration.as_millis(), resample_duration.as_millis(),
                        vad_duration.as_millis(), sr
                    );
                }
            }
        }
    }

    // Emit any remaining audio when the stream ends.
    if in_speech && !speech_buffer.is_empty() {
        let utterance_end_time = audio_position_secs(samples_processed);
        emit_speech_detected(
            &app,
            sr,
            &speech_buffer,
            config.noise_gate_threshold,
            config.compare_preprocessing,
            utterance_start_time,
            utterance_end_time,
            live_turns.current(),
        );
    }

    // Bounded: a worker that will not stop is left behind and muted.
    live_turns.stop(Duration::from_millis(500));

    // Finalize the session WAV for diarization before its path is returned.
    #[cfg(target_os = "macos")]
    let session_path: Option<std::path::PathBuf> = match session_recording {
        Some(recording) => {
            let path = recording.path().to_path_buf();
            match recording.finalize() {
                Ok(()) => {
                    match app
                        .try_state::<crate::stt::SttState>()
                        .map(|state| state.set_session_wav_path(path.clone()))
                    {
                        Some(Ok(())) => Some(path),
                        Some(Err(e)) => {
                            error!("Failed to manage session WAV: {}", e);
                            let _ = std::fs::remove_file(&path);
                            None
                        }
                        None => {
                            let _ = std::fs::remove_file(&path);
                            None
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to finalize session recording: {}", e);
                    let _ = app.emit(
                        "stt-error",
                        "Speaker labels are unavailable for this session.",
                    );
                    None
                }
            }
        }
        None => None,
    };

    #[cfg(not(target_os = "macos"))]
    let session_path: Option<std::path::PathBuf> = None;

    session_path
}

/// What a finished manual take should do with the audio it collected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TakeAction {
    Emit,
    Drop,
    ReportNoAudio,
}

fn finish_take_action(discarded: bool, has_audio: bool) -> TakeAction {
    if discarded {
        TakeAction::Drop
    } else if has_audio {
        TakeAction::Emit
    } else {
        TakeAction::ReportNoAudio
    }
}

fn take_first_error(reported: &mut bool) -> bool {
    if *reported {
        false
    } else {
        *reported = true;
        true
    }
}

fn fallback_vad_is_speech(samples: &[f32], config: &VadConfig) -> bool {
    let gated = apply_noise_gate(samples, config.noise_gate_threshold);
    let (rms, peak) = calculate_audio_metrics(&gated);
    rms > config.sensitivity_rms || peak > config.peak_threshold
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    stop_flag: Arc<AtomicBool>,
    discard_flag: Arc<AtomicBool>,
) -> Option<std::path::PathBuf> {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    let prealloc_samples = ((sr as usize) * 10).min(max_samples);
    let mut audio_buffer = Vec::with_capacity(prealloc_samples);
    let start_time = Instant::now();
    let max_duration = Duration::from_secs(config.max_recording_duration_secs);

    // Streaming chunk emission state
    let mut last_emitted_len: usize = 0;
    let mut last_chunk_time = Instant::now();
    let chunk_interval = Duration::from_millis(config.chunk_interval_ms);

    let stop_flag_for_listener = stop_flag.clone();

    // Listen for manual stop event
    let stop_listener = app.listen("manual-stop-continuous", move |_| {
        stop_flag_for_listener.store(true, Ordering::Release);
    });

    // Emit recording started
    let _ = app.emit(
        "continuous-recording-start",
        config.max_recording_duration_secs,
    );

    // Accumulate audio - check stop flag on EVERY sample for immediate response
    loop {
        // Check stop flag FIRST on every iteration for immediate stopping
        if stop_flag.load(Ordering::Acquire) {
            break;
        }

        tokio::select! {
            sample_opt = stream.next() => {
                match sample_opt {
                    Some(sample) => {
                        if stop_flag.load(Ordering::Acquire) {
                            break;
                        }

                        audio_buffer.push(sample);

                        let elapsed = start_time.elapsed();

                        // Emit progress every second
                        if audio_buffer.len() % (sr as usize) == 0 {
                            let _ = app.emit("recording-progress", elapsed.as_secs());
                        }

                        // Emit incremental streaming chunks
                        if config.emit_chunks
                            && last_chunk_time.elapsed() >= chunk_interval
                            && audio_buffer.len() > last_emitted_len
                        {
                            let new_samples = &audio_buffer[last_emitted_len..];
                            let processed = prepare_utterance(
                                new_samples,
                                config.noise_gate_threshold,
                                false,
                            )
                            .processed;
                            if let Ok(b64) = samples_to_raw_f32_b64(&processed) {
                                let _ = app.emit("speech-chunk", b64);
                            }
                            last_emitted_len = audio_buffer.len();
                            last_chunk_time = Instant::now();
                        }

                        // Check size limit (safety)
                        if audio_buffer.len() >= max_samples {
                            break;
                        }

                        // Check time limit
                        if elapsed >= max_duration {
                            break;
                        }
                    },
                    None => {
                        warn!("Audio stream ended unexpectedly");
                        break;
                    }
                }
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(10)) => {
            }
        }
    }

    // Clean up event listener (CRITICAL)
    app.unlisten(stop_listener);

    // Process and emit audio. The discard flag is stored before the stop flag
    // that broke the loop above, so it is visible here for the take the user
    // just discarded.
    match finish_take_action(
        discard_flag.load(Ordering::Acquire),
        !audio_buffer.is_empty(),
    ) {
        TakeAction::Emit => {
            emit_speech_detected(
                &app,
                sr,
                &audio_buffer,
                config.noise_gate_threshold,
                config.compare_preprocessing,
                0.0,
                0.0,
                0,
            );
        }
        TakeAction::Drop => {
            let _ = app.emit("speech-discarded", "Recording discarded");
        }
        TakeAction::ReportNoAudio => {
            warn!("No audio captured in continuous mode");
            let _ = app.emit("audio-encoding-error", "No audio recorded");
        }
    }

    let _ = app.emit("continuous-recording-stopped", ());

    None
}

// Calculate RMS and peak (optimized)
fn calculate_audio_metrics(chunk: &[f32]) -> (f32, f32) {
    if chunk.is_empty() {
        return (0.0, 0.0);
    }

    let mut sumsq = 0.0f32;
    let mut peak = 0.0f32;

    for &v in chunk {
        let a = v.abs();
        peak = peak.max(a);
        sumsq += v * v;
    }

    let rms = (sumsq / chunk.len() as f32).sqrt();
    (rms, peak)
}

// Convert samples to WAV base64 (with proper error handling)
fn samples_to_wav_b64(sample_rate: u32, mono_f32: &[f32]) -> Result<String, String> {
    // Validate sample rate
    if !(8000..=96000).contains(&sample_rate) {
        error!("Invalid sample rate: {}", sample_rate);
        return Err(format!(
            "Invalid sample rate: {}. Expected 8000-96000 Hz",
            sample_rate
        ));
    }

    // Validate buffer
    if mono_f32.is_empty() {
        return Err("Empty audio buffer".to_string());
    }

    let mut cursor = Cursor::new(Vec::new());
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::new(&mut cursor, spec).map_err(|e| {
        error!("Failed to create WAV writer: {}", e);
        e.to_string()
    })?;

    for &s in mono_f32 {
        let clamped = s.clamp(-1.0, 1.0);
        let sample_i16 = (clamped * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16).map_err(|e| e.to_string())?;
    }

    writer.finalize().map_err(|e| e.to_string())?;

    Ok(B64.encode(cursor.into_inner()))
}

fn write_f32_samples_to_wav(
    sample_rate: u32,
    samples: &[f32],
    path: &std::path::Path,
) -> Result<(), String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    // Session WAVs live in the world-readable temp dir; create them
    // owner-only so other local users cannot read captured audio.
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path).map_err(|e| e.to_string())?;
    let mut writer = WavWriter::new(file, spec).map_err(|e| e.to_string())?;
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        writer
            .write_sample((clamped * i16::MAX as f32) as i16)
            .map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove `assistant-session-*.wav` files older than `older_than` from `dir`.
/// Startup crash recovery: sessions abandoned before diarization would
/// otherwise accumulate in the temp dir forever. Returns the number removed.
pub fn sweep_stale_session_wavs(dir: &std::path::Path, older_than: Duration) -> usize {
    let now = std::time::SystemTime::now();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("assistant-session-") && name.ends_with(".wav")) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let stale = now
            .duration_since(modified)
            .map(|age| age > older_than)
            .unwrap_or(false);
        if stale && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

// Convert samples to raw little-endian f32 bytes, base64-encoded (no WAV header).
// Used for streaming chunks sent to the WebSocket endpoint.
fn samples_to_raw_f32_b64(mono_f32: &[f32]) -> Result<String, String> {
    if mono_f32.is_empty() {
        return Err("Empty audio buffer".to_string());
    }
    let mut bytes = Vec::with_capacity(mono_f32.len() * 4);
    for &s in mono_f32 {
        let clamped = s.clamp(-1.0, 1.0);
        bytes.extend_from_slice(&clamped.to_le_bytes());
    }
    Ok(B64.encode(&bytes))
}

async fn await_capture_shutdown(
    mut task: tokio::task::JoinHandle<Option<std::path::PathBuf>>,
    deadline: Duration,
) -> Option<std::path::PathBuf> {
    match tokio::time::timeout(deadline, &mut task).await {
        Ok(Ok(path)) => path,
        Ok(Err(error)) => {
            error!("Capture task ended before cleanup completed: {}", error);
            None
        }
        Err(_) => {
            error!("Capture task did not finish within the shutdown deadline");
            task.abort();
            let _ = task.await;
            None
        }
    }
}

#[tauri::command]
pub async fn stop_system_audio_capture(
    app: AppHandle,
    discard: Option<bool>,
) -> Result<Option<std::path::PathBuf>, String> {
    let state = app.state::<crate::AudioState>();
    // Store the intent BEFORE the stop flag: the capture loop breaks on the
    // stop flag and then reads this, so ordering it this way is what makes the
    // discard visible to the take being stopped.
    latch_discard_intent(&state.discard_take, discard.unwrap_or(false));
    state.stop_flag.store(true, Ordering::Release);

    // A start is still setting up: there is no task to take yet. The start
    // sees the request when it installs its task and stops the capture itself
    // without ever announcing it.
    if state.stream_task.request_stop_during_start()? {
        return Ok(None);
    }

    // Hold the stop reservation until the capture task has joined and its
    // finalization completed: releasing the slot early would let a start/stop
    // overlap claim it while the previous capture is still shutting down.
    let (task, stop_reservation) = state.stream_task.take_for_stop()?;

    // Drain unconditionally: a live task supersedes anything a previous
    // unexpected end left behind, and `sweep_stale_session_wavs` reclaims the
    // superseded file.
    let orphaned_session_path = state
        .orphaned_session_path
        .lock()
        .map_err(|e| format!("Failed to read session audio path: {}", e))?
        .take();

    let session_path = if let Some(task) = task {
        let joined = await_capture_shutdown(task, Duration::from_secs(5)).await;
        drop(stop_reservation);
        joined
    } else {
        drop(stop_reservation);
        orphaned_session_path
    };

    // Mark as not capturing
    *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to update capturing state: {}", e))? = false;

    // Emit stopped event
    let _ = app.emit("capture-stopped", ());
    Ok(session_path)
}

fn latch_discard_intent(discard: &AtomicBool, requested: bool) {
    if requested {
        discard.store(true, Ordering::Release);
    }
}

/// Manual stop for continuous recording
#[tauri::command]
pub async fn manual_stop_continuous(app: AppHandle) -> Result<(), String> {
    // Signal the shared stop flag directly: the continuous-capture loop
    // checks it on every sample. Relying on the event alone raced the
    // listener's registration inside the spawned task — a stop issued before
    // the task registered its listener was silently missed. The event is
    // still emitted for the task's listener and any frontend listeners.
    let state = app.state::<crate::AudioState>();
    state.stop_flag.store(true, Ordering::Release);
    let _ = app.emit("manual-stop-continuous", ());

    Ok(())
}

#[tauri::command]
pub fn check_system_audio_access(_app: AppHandle) -> Result<bool, String> {
    match SpeakerInput::new() {
        Ok(_) => Ok(true),
        Err(e) => {
            error!("System audio access check failed: {}", e);
            Ok(false)
        }
    }
}

#[tauri::command]
pub async fn request_system_audio_access(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.shell()
            .command("open")
            .args(["x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"])
            .spawn()
            .map_err(|e| {
                error!("Failed to open system preferences: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        app.shell()
            .command("ms-settings:sound")
            .spawn()
            .map_err(|e| {
                error!("Failed to open sound settings: {}", e);
                e.to_string()
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        let commands = ["pavucontrol", "gnome-control-center sound"];
        let mut opened = false;

        for cmd in &commands {
            if app.shell().command(cmd).spawn().is_ok() {
                opened = true;
                break;
            }
        }

        if !opened {
            warn!("Failed to open audio settings on Linux");
        }
    }

    Ok(())
}

// VAD Configuration Management
#[tauri::command]
pub async fn get_vad_config(app: AppHandle) -> Result<VadConfig, String> {
    let state = app.state::<crate::AudioState>();
    let config = state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to get VAD config: {}", e))?
        .clone();
    Ok(config)
}

#[tauri::command]
pub async fn update_vad_config(app: AppHandle, config: VadConfig) -> Result<(), String> {
    config.validate()?;

    let state = app.state::<crate::AudioState>();
    *state
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to update VAD config: {}", e))? = config;

    Ok(())
}

#[tauri::command]
pub async fn get_capture_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<crate::AudioState>();
    let is_capturing = *state
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to get capture status: {}", e))?;
    Ok(is_capturing)
}

#[tauri::command]
pub fn get_input_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_input_devices().map_err(|e| {
        error!("Failed to get input devices: {}", e);
        format!("Failed to get input devices: {}", e)
    })
}

#[tauri::command]
pub fn get_output_devices() -> Result<Vec<AudioDevice>, String> {
    crate::speaker::list_output_devices().map_err(|e| {
        error!("Failed to get output devices: {}", e);
        format!("Failed to get output devices: {}", e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_text_defaults_on_and_survives_configs_saved_without_it() {
        assert!(VadConfig::default().live_text);
        let mut saved = serde_json::to_value(VadConfig::default()).unwrap();
        saved.as_object_mut().unwrap().remove("live_text");
        let parsed: VadConfig = serde_json::from_value(saved).unwrap();
        assert!(parsed.live_text);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vad_resampling_also_returns_the_16k_samples() {
        let mut accumulator = VadFrameAccumulator::default();
        let (samples_16k, frames) =
            resampled_vad_frames(&mut accumulator, &[0.0; 1024], 16_000).unwrap();
        assert_eq!(samples_16k.len(), 1024);
        assert!(frames.is_empty());
    }

    #[test]
    fn capture_drain_monitor_reports_stalls_without_flooding_logs() {
        let start = Instant::now();
        let mut monitor = CaptureDrainMonitor {
            last_hop: start,
            last_report: None,
        };
        assert_eq!(monitor.observe(start, Duration::from_millis(2)), None);
        assert_eq!(
            monitor.observe(start + Duration::from_secs(1), Duration::ZERO),
            Some(Duration::from_secs(1))
        );
        assert_eq!(
            monitor.observe(start + Duration::from_secs(2), Duration::ZERO),
            None
        );
        assert_eq!(
            monitor.observe(start + Duration::from_secs(11), Duration::ZERO),
            Some(Duration::from_secs(9))
        );
    }

    #[test]
    fn capture_drain_monitor_reports_slow_processing_without_a_read_gap() {
        let start = Instant::now();
        let mut monitor = CaptureDrainMonitor {
            last_hop: start,
            last_report: None,
        };
        assert_eq!(
            monitor.observe(start, Duration::from_millis(500)),
            Some(Duration::ZERO)
        );
    }

    struct FakeVadReset {
        result: Result<(), String>,
        calls: std::sync::atomic::AtomicUsize,
    }

    impl CaptureVadReset for FakeVadReset {
        fn reset_capture_vad(&self) -> Result<(), String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.clone()
        }
    }

    impl DictationVadReset for FakeVadReset {
        fn reset_dictation_vad(&self) -> Result<(), String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.clone()
        }
    }

    #[test]
    fn capture_boundary_resets_vad_once() {
        let reset = FakeVadReset {
            result: Ok(()),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };

        reset_vad_for_capture(Some(&reset)).unwrap();

        assert_eq!(reset.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn capture_boundary_propagates_vad_reset_errors() {
        let reset = FakeVadReset {
            result: Err("reset failed".to_string()),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };

        assert_eq!(
            reset_vad_for_capture(Some(&reset)),
            Err("reset failed".to_string())
        );
    }

    #[test]
    fn dictation_boundary_resets_its_vad_once() {
        let reset = FakeVadReset {
            result: Ok(()),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };

        reset_vad_for_dictation(Some(&reset)).unwrap();

        assert_eq!(reset.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dictation_boundary_propagates_vad_reset_errors() {
        let reset = FakeVadReset {
            result: Err("mic reset failed".to_string()),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };

        assert_eq!(
            reset_vad_for_dictation(Some(&reset)),
            Err("mic reset failed".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn normalizes_cached_utterance_samples_to_16khz() {
        let device_rate_samples = vec![0.25f32; 48_000];
        let normalized = samples_for_local_asr(&device_rate_samples, 48_000).unwrap();
        assert_eq!(normalized.len(), 16_000);

        let native_rate_samples = vec![0.5f32; 16_000];
        assert_eq!(
            samples_for_local_asr(&native_rate_samples, 16_000).unwrap(),
            native_rate_samples
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn short_utterance_survives_converter_boundaries() {
        let short = vec![0.1f32; 48_000 / 4];
        let converted = samples_for_local_asr(&short, 48_000).unwrap();
        assert_eq!(converted.len(), 4_000);
        assert!(converted.iter().any(|sample| sample.abs() > 0.0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resampler_surfaces_swift_error_detail() {
        let error = samples_for_local_asr(&[0.25], 0).unwrap_err();

        assert!(error.contains("Invalid audio input sample rate"));
        assert_ne!(error, "Failed to resample audio");
    }

    #[test]
    fn hysteresis_requires_positive_threshold_to_enter_speech() {
        // Not currently in speech: must exceed the positive threshold.
        assert!(!silero_is_speech(false, 0.34));
        assert!(!silero_is_speech(false, 0.49)); // above negative but below positive
        assert!(silero_is_speech(false, 0.50));
        assert!(silero_is_speech(false, 0.90));
    }

    #[test]
    fn hysteresis_holds_speech_until_below_negative_threshold() {
        // Already in speech: only a drop below the negative threshold ends it.
        assert!(silero_is_speech(true, 0.40)); // between thresholds -> keep going
        assert!(silero_is_speech(true, 0.35));
        assert!(!silero_is_speech(true, 0.34));
        assert!(!silero_is_speech(true, 0.10));
    }

    #[test]
    fn mic_vad_waits_for_a_complete_silero_frame() {
        let mut accumulator = VadFrameAccumulator::default();

        for value in [1.0, 2.0, 3.0] {
            assert!(accumulator.push(&vec![value; 1024]).is_empty());
        }

        let frames = accumulator.push(&vec![4.0; 1024]);

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), SILERO_CHUNK_SAMPLES);
        assert_eq!(&frames[0][0..1024], vec![1.0; 1024]);
        assert_eq!(&frames[0][3072..4096], vec![4.0; 1024]);
    }

    #[test]
    fn mic_vad_retains_surplus_samples_until_the_next_frame() {
        let mut accumulator = VadFrameAccumulator::default();

        let first = accumulator.push(&vec![1.0; 5000]);
        let second = accumulator.push(&vec![2.0; 3192]);

        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(&second[0][0..904], vec![1.0; 904]);
        assert_eq!(&second[0][904..4096], vec![2.0; 3192]);
    }

    #[test]
    fn vad_accumulator_emits_every_complete_frame_from_one_push() {
        let mut accumulator = VadFrameAccumulator::default();

        let frames = accumulator.push(&vec![1.0; SILERO_CHUNK_SAMPLES * 3 + 17]);

        assert_eq!(frames.len(), 3);
        assert!(frames
            .iter()
            .all(|frame| frame.len() == SILERO_CHUNK_SAMPLES));
        assert!(accumulator
            .push(&vec![2.0; SILERO_CHUNK_SAMPLES - 18])
            .is_empty());
        assert_eq!(accumulator.push(&[2.0]).len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn system_vad_resampling_emits_exact_frames_at_supported_device_rates() {
        for sample_rate in [44_100, 48_000, 96_000] {
            let mut accumulator = VadFrameAccumulator::default();
            let (_, frames) = resampled_vad_frames(
                &mut accumulator,
                &vec![0.25; sample_rate as usize],
                sample_rate,
            )
            .unwrap();

            assert_eq!(frames.len(), 3, "sample rate {sample_rate}");
            assert!(frames
                .iter()
                .all(|frame| frame.len() == SILERO_CHUNK_SAMPLES));
        }
    }

    #[test]
    fn mic_vad_reset_discards_an_incomplete_frame() {
        let mut accumulator = VadFrameAccumulator::default();

        assert!(accumulator.push(&vec![1.0; 904]).is_empty());
        accumulator.clear();

        assert!(accumulator.push(&vec![2.0; 3192]).is_empty());
    }

    #[test]
    fn discarded_take_is_dropped_rather_than_emitted() {
        // "Discard" on a manual take must drop the audio outright: emitting it
        // means the frontend transcribes it, appends it to the transcript and
        // may answer it — i.e. discard behaving exactly like stop-and-send.
        assert_eq!(finish_take_action(true, true), TakeAction::Drop);
        assert_eq!(finish_take_action(true, false), TakeAction::Drop);
    }

    #[test]
    fn discard_intent_cannot_be_downgraded_by_a_later_stop() {
        let discard = AtomicBool::new(false);

        latch_discard_intent(&discard, true);
        latch_discard_intent(&discard, false);

        assert!(discard.load(Ordering::Acquire));
    }

    #[test]
    fn kept_take_with_audio_is_emitted() {
        assert_eq!(finish_take_action(false, true), TakeAction::Emit);
    }

    #[test]
    fn kept_take_without_audio_reports_the_failure() {
        assert_eq!(finish_take_action(false, false), TakeAction::ReportNoAudio);
    }

    #[tokio::test]
    async fn capture_shutdown_waits_for_cleanup_result() {
        let expected = std::env::temp_dir().join("capture-cleanup.wav");
        let task_path = expected.clone();
        let task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Some(task_path)
        });

        let result = await_capture_shutdown(task, Duration::from_secs(1)).await;

        assert_eq!(result, Some(expected));
    }

    #[tokio::test]
    async fn capture_shutdown_times_out_without_hanging() {
        let task = tokio::spawn(async {
            std::future::pending::<()>().await;
            None
        });

        let result = await_capture_shutdown(task, Duration::from_millis(1)).await;

        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn second_reservation_is_rejected_before_a_task_is_spawned() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("Capture already running").unwrap();
        let first = tokio::spawn(std::future::pending::<()>());
        reservation.install(first).unwrap();

        assert_eq!(
            slot.reserve("Capture already running").err(),
            Some("Capture already running".to_string())
        );
        assert!(slot.take().unwrap().is_some());
    }

    #[test]
    fn dropped_reservation_reopens_the_slot_after_setup_failure() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();

        drop(reservation);

        assert!(slot.reserve("busy").is_ok());
    }

    #[tokio::test]
    async fn owner_cleanup_releases_the_slot() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();
        let task = tokio::spawn(async {});
        let id = task.id();
        reservation.install(task).unwrap();

        slot.release_if_owned(id);

        assert!(slot.take().unwrap().is_none());
    }

    #[tokio::test]
    async fn stale_task_cleanup_does_not_clobber_the_newer_captures_slot() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();
        let first = tokio::spawn(std::future::pending::<()>());
        let stale_id = first.id();
        reservation.install(first).unwrap();
        slot.take().unwrap(); // first capture stopped

        let reservation = slot.reserve("busy").unwrap();
        let second = tokio::spawn(std::future::pending::<()>());
        reservation.install(second).unwrap();

        // The first task's exit cleanup runs late (after the slot was
        // reclaimed): it must not clear the newer task's entry.
        slot.release_if_owned(stale_id);

        assert!(slot.take().unwrap().is_some());
    }

    #[tokio::test]
    async fn stopping_task_keeps_slot_reserved_until_termination() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();
        reservation
            .install(tokio::spawn(std::future::pending::<()>()))
            .unwrap();

        let (task, stopping) = slot.take_for_stop().unwrap();

        assert_eq!(slot.reserve("busy").err(), Some("busy".to_string()));
        task.unwrap().abort();
        drop(stopping);
        assert!(slot.reserve("busy").is_ok());
    }

    #[tokio::test]
    async fn second_stop_is_rejected_while_the_first_is_in_progress() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();
        reservation
            .install(tokio::spawn(std::future::pending::<()>()))
            .unwrap();

        let (_task, stopping) = slot.take_for_stop().unwrap();

        assert!(slot.take_for_stop().is_err());
        drop(stopping);
        assert!(slot.take_for_stop().is_ok());
    }

    #[tokio::test]
    async fn timed_out_stop_aborts_before_the_slot_reopens() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();
        reservation
            .install(tokio::spawn(std::future::pending::<()>()))
            .unwrap();
        let (task, stopping) = slot.take_for_stop().unwrap();
        let mut task = task.unwrap();

        let timed_out = tokio::time::timeout(Duration::ZERO, &mut task)
            .await
            .is_err();
        assert!(timed_out);
        task.abort();
        let _ = task.await;
        assert_eq!(slot.reserve("busy").err(), Some("busy".to_string()));
        drop(stopping);
        assert!(slot.reserve("busy").is_ok());
    }

    #[tokio::test]
    async fn install_skips_a_task_that_finished_before_registration() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();
        let task = tokio::spawn(async {});
        tokio::task::yield_now().await;
        let outcome = reservation.install(task).unwrap();

        assert_eq!(outcome, TaskInstallOutcome::Finished);
        assert!(slot.take().unwrap().is_none());
    }

    #[tokio::test]
    async fn stop_during_start_is_reported_at_install_with_the_task_stoppable() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();

        assert!(slot.request_stop_during_start().unwrap());
        // No task exists yet, so a plain stop has nothing to take.
        assert!(slot.take_for_stop().is_err());

        let outcome = reservation
            .install(tokio::spawn(std::future::pending::<()>()))
            .unwrap();
        assert_eq!(outcome, TaskInstallOutcome::StopRequested);

        let (task, stopping) = slot.take_for_stop().unwrap();
        task.expect("the starter must be able to stop its task").abort();
        drop(stopping);
        assert!(slot.reserve("busy").is_ok());
    }

    #[tokio::test]
    async fn stop_request_is_only_recorded_while_a_start_is_in_flight() {
        let slot = TaskSlot::<()>::new();
        assert!(!slot.request_stop_during_start().unwrap());

        let reservation = slot.reserve("busy").unwrap();
        let outcome = reservation
            .install(tokio::spawn(std::future::pending::<()>()))
            .unwrap();
        assert_eq!(outcome, TaskInstallOutcome::Running);
        assert!(!slot.request_stop_during_start().unwrap());

        let (task, stopping) = slot.take_for_stop().unwrap();
        assert!(!slot.request_stop_during_start().unwrap());
        task.unwrap().abort();
        drop(stopping);

        // A request left by an abandoned start does not leak into the next.
        let abandoned = slot.reserve("busy").unwrap();
        assert!(slot.request_stop_during_start().unwrap());
        drop(abandoned);
        let reservation = slot.reserve("busy").unwrap();
        let outcome = reservation
            .install(tokio::spawn(std::future::pending::<()>()))
            .unwrap();
        assert_eq!(outcome, TaskInstallOutcome::Running);
        slot.take().unwrap().unwrap().abort();
    }

    #[tokio::test]
    async fn install_reports_a_running_task() {
        let slot = TaskSlot::<()>::new();
        let reservation = slot.reserve("busy").unwrap();
        let task = tokio::spawn(std::future::pending::<()>());

        let outcome = reservation.install(task).unwrap();

        assert_eq!(outcome, TaskInstallOutcome::Running);
        assert!(slot.take().unwrap().is_some());
    }

    #[test]
    fn dictation_stop_reports_whether_the_stream_ended_unexpectedly() {
        assert!(!dictation_stopped_payload(true).unexpected);
        assert!(dictation_stopped_payload(false).unexpected);
    }

    #[test]
    fn repeated_vad_resample_failures_are_reported_once() {
        let mut reported = false;

        assert!(take_first_error(&mut reported));
        assert!(!take_first_error(&mut reported));
    }

    #[test]
    fn vad_processing_failure_switches_to_fallback_and_is_reported_once() {
        let mut reported = false;

        let (probability, first_error) =
            consume_vad_probability(Err("CoreML prediction failed".to_string()), &mut reported);
        let (_, repeated_error) = consume_vad_probability(
            Err("CoreML prediction failed again".to_string()),
            &mut reported,
        );

        assert_eq!(probability, None);
        assert_eq!(first_error.as_deref(), Some("CoreML prediction failed"));
        assert_eq!(repeated_error, None);
    }

    #[test]
    fn vad_processing_success_preserves_the_native_probability() {
        let mut reported = false;

        let (probability, error) = consume_vad_probability(Ok(Some(0.73)), &mut reported);

        assert_eq!(probability, Some(0.73));
        assert_eq!(error, None);
        assert!(!reported);
    }

    #[test]
    fn fallback_vad_keeps_metrics_tuned_to_gated_audio() {
        let mut samples = vec![0.011; 302];
        samples.extend(vec![0.00075; 722]);
        let config = VadConfig::default();

        let (raw_rms, _) = calculate_audio_metrics(&samples);
        assert!(raw_rms > config.sensitivity_rms);
        assert!(!fallback_vad_is_speech(&samples, &config));
    }

    #[test]
    fn vad_config_validate_accepts_the_defaults() {
        assert!(VadConfig::default().validate().is_ok());
    }

    #[test]
    fn vad_config_validate_rejects_unbounded_hop_size() {
        // hop_size feeds Vec/VecDeque::with_capacity in the capture task: an
        // unbounded value overflows capacity and panics the spawned task.
        let mut config = VadConfig {
            hop_size: 1_000_000,
            ..VadConfig::default()
        };
        assert!(config.validate().is_err());

        config.hop_size = 128; // below the 256 floor
        assert!(config.validate().is_err());
    }

    #[test]
    fn vad_config_validate_rejects_unbounded_pre_speech_and_silence_chunks() {
        let config = VadConfig {
            pre_speech_chunks: 100_000,
            ..VadConfig::default()
        };
        assert!(config.validate().is_err());

        let config = VadConfig {
            silence_chunks: 100_000,
            ..VadConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn vad_config_validate_rejects_fast_chunk_interval() {
        let config = VadConfig {
            chunk_interval_ms: 1,
            ..VadConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn default_pre_speech_buffer_covers_two_silero_refresh_periods() {
        // The pre-speech buffer must span at least two Silero refresh periods
        // (4096 samples @ 16 kHz = 256 ms each). Silero only reports a
        // probability after a full chunk, so a buffer exactly one refresh wide
        // ages the word onset out before VAD triggers — the capture then starts
        // mid-word. At 48 kHz: silero_device_chunk = 48000 * 4096 / 16000 =
        // 12,288 samples = 12 hops; 2 periods = 24 hops.
        let config = VadConfig::default();
        let sr: usize = 48_000;
        let silero_device_chunk = (sr * SILERO_CHUNK_SAMPLES) / 16_000;
        let pre_speech_samples = config.pre_speech_chunks * config.hop_size;
        assert!(
            pre_speech_samples >= 2 * silero_device_chunk,
            "pre_speech buffer {} samples must cover 2 Silero periods ({} samples)",
            pre_speech_samples,
            2 * silero_device_chunk
        );
    }

    #[test]
    fn sweep_stale_session_wavs_removes_only_stale_session_files() {
        let dir = std::env::temp_dir().join(format!("aileron-sweep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let stale = dir.join("assistant-session-stale.wav");
        std::fs::write(&stale, b"wav").unwrap();
        let stale_time = std::time::SystemTime::now() - Duration::from_secs(25 * 3600);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(stale_time))
            .unwrap();

        let fresh = dir.join("assistant-session-fresh.wav");
        std::fs::write(&fresh, b"wav").unwrap();

        let unrelated = dir.join("unrelated.wav");
        std::fs::write(&unrelated, b"wav").unwrap();

        let removed = sweep_stale_session_wavs(&dir, Duration::from_secs(24 * 3600));

        assert_eq!(removed, 1);
        assert!(!stale.exists());
        assert!(fresh.exists());
        assert!(unrelated.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn session_wav_is_written_with_restrictive_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(format!("aileron-perms-{}.wav", uuid::Uuid::new_v4()));
        let samples = vec![0.1f32, -0.2, 0.3];

        write_f32_samples_to_wav(16_000, &samples, &path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode & 0o077,
            0,
            "session WAV must not be readable by group or others (got mode {mode:o})"
        );

        let _ = std::fs::remove_file(&path);
    }
}

// ---- Mic dictation (native path for the mic button; macOS v1) ----
// Own task slot: dictation and system-audio capture must never share one, so
// neither can kill the other and both may run simultaneously.

#[derive(Default)]
pub struct MicDictationState {
    task: TaskSlot<()>,
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[tauri::command]
pub async fn start_mic_dictation(app: AppHandle, device_id: Option<String>) -> Result<(), String> {
    let state = app.state::<MicDictationState>();
    let reservation = state.task.reserve("Dictation already running")?;

    // Dictation quality depends on Silero, but it must not depend on a system
    // audio capture having run first. `stt_init_vad` is called from that path
    // only, so on a fresh session VAD was never up and every mic click failed
    // here — with the error surfacing as nothing louder than a red mic icon.
    // Bring VAD up on demand, then apply the original guard unchanged.
    #[cfg(target_os = "macos")]
    {
        let needs_init = app
            .try_state::<crate::stt::SttState>()
            .is_none_or(|state| !state.is_mic_vad_ready());
        if needs_init {
            crate::stt::ensure_vad_ready(&app, SILERO_POSITIVE_THRESHOLD).await?;
        }
        let stt_state = app
            .try_state::<crate::stt::SttState>()
            .ok_or("Voice detection isn't ready — initialize speech recognition first")?;
        if !stt_state.is_mic_vad_ready() {
            return Err(
                "Voice detection isn't ready — initialize speech recognition first".to_string(),
            );
        }
        reset_vad_for_dictation(Some(&*stt_state))?;
    }

    let input = crate::speaker::mic::MicInput::new(device_id)?;
    let sr = input.sample_rate();
    if !(8000..=96000).contains(&sr) {
        return Err(format!("Invalid mic sample rate: {sr}"));
    }
    let (rx, stream_guard) = input.start()?;

    let vad_config = app
        .state::<crate::AudioState>()
        .vad_config
        .lock()
        .map_err(|e| format!("Failed to read VAD config: {e}"))?
        .clone();

    state
        .stop_flag
        .store(false, std::sync::atomic::Ordering::SeqCst);
    let stop_flag = state.stop_flag.clone();

    let app_clone = app.clone();
    let task = tokio::spawn(async move {
        run_mic_dictation(app_clone.clone(), rx, sr, vad_config, stop_flag).await;
        drop(stream_guard);
        let state = app_clone.state::<MicDictationState>();
        let payload =
            dictation_stopped_payload(state.stop_flag.load(std::sync::atomic::Ordering::SeqCst));
        let _ = app_clone.emit("dictation-stopped", payload);
        state.task.release_if_owned(tokio::task::id());
    });

    match reservation.install(task)? {
        TaskInstallOutcome::Running => Ok(()),
        TaskInstallOutcome::Finished => Err("Microphone capture ended during startup".to_string()),
        TaskInstallOutcome::StopRequested => {
            // A stop raced this start; the flag was reset above, so set it
            // again and shut the task down as the stop command would.
            state
                .stop_flag
                .store(true, std::sync::atomic::Ordering::SeqCst);
            stop_installed_dictation(&state.task).await;
            Err("Dictation stopped during startup".to_string())
        }
    }
}

#[derive(Clone, Serialize)]
struct DictationStoppedPayload {
    unexpected: bool,
}

fn dictation_stopped_payload(stop_requested: bool) -> DictationStoppedPayload {
    DictationStoppedPayload {
        unexpected: !stop_requested,
    }
}

#[tauri::command]
pub async fn stop_mic_dictation(app: AppHandle) -> Result<(), String> {
    let state = app.state::<MicDictationState>();
    state
        .stop_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    if state.task.request_stop_during_start()? {
        return Ok(());
    }
    let (task, _stopping) = state.task.take_for_stop()?;
    if let Some(task) = task {
        await_dictation_shutdown(task).await;
    }
    Ok(())
}

async fn await_dictation_shutdown(mut task: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(tokio::time::Duration::from_secs(3), &mut task)
        .await
        .is_err()
    {
        task.abort();
        let _ = task.await;
    }
}

async fn stop_installed_dictation(slot: &TaskSlot<()>) {
    if let Ok((Some(task), _stopping)) = slot.take_for_stop() {
        await_dictation_shutdown(task).await;
    }
}

async fn run_mic_dictation(
    app: AppHandle,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Vec<f32>>,
    sr: u32,
    config: VadConfig,
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let hop = config.hop_size.max(256);
    let mut pending: Vec<f32> = Vec::new();
    let mut pre_speech: std::collections::VecDeque<Vec<f32>> =
        std::collections::VecDeque::with_capacity(config.pre_speech_chunks);
    let mut speech_buffer: Vec<f32> = Vec::new();
    let mut in_speech = false;
    let mut silence_hops = 0usize;
    let mut speech_hops = 0usize;
    let mut vad_accumulator = VadFrameAccumulator::default();
    let mut vad_resample_error_reported = false;
    let mut vad_processing_error_reported = false;
    // macOS assumes silence until the first Silero result (mirrors the tap loop).
    let mut prob: Option<f32> = if cfg!(target_os = "macos") {
        Some(0.0)
    } else {
        None
    };

    loop {
        if stop_flag.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
        let chunk =
            match tokio::time::timeout(tokio::time::Duration::from_millis(200), rx.recv()).await {
                Ok(Some(c)) => c,
                Ok(None) => break,  // stream thread ended
                Err(_) => continue, // timeout: re-check stop flag
            };
        pending.extend_from_slice(&chunk);

        while pending.len() >= hop {
            let hop_chunk: Vec<f32> = pending.drain(..hop).collect();
            #[cfg(target_os = "macos")]
            match resampled_vad_frames(&mut vad_accumulator, &hop_chunk, sr) {
                Ok((_, frames)) => {
                    for frame in frames {
                        let (probability, error) = consume_vad_probability(
                            get_silero_vad_probability_mic(&app, &frame),
                            &mut vad_processing_error_reported,
                        );
                        prob = probability;
                        if let Some(error) = error {
                            let _ = app.emit(
                                "stt-error",
                                format!("FluidAudio microphone VAD processing failed: {error}"),
                            );
                        }
                    }
                }
                Err(error) => {
                    if take_first_error(&mut vad_resample_error_reported) {
                        let _ = app.emit(
                            "stt-error",
                            format!("Failed to resample microphone VAD audio: {error}"),
                        );
                    }
                    prob = None;
                }
            }
            let is_speech = match prob {
                Some(p) => silero_is_speech(in_speech, p),
                None => fallback_vad_is_speech(&hop_chunk, &config),
            };

            if is_speech {
                if !in_speech {
                    in_speech = true;
                    speech_hops = 0;
                    speech_buffer.clear();
                    for pre in pre_speech.iter() {
                        speech_buffer.extend_from_slice(pre);
                    }
                }
                silence_hops = 0;
                speech_hops += 1;
                speech_buffer.extend_from_slice(&hop_chunk);
            } else if in_speech {
                silence_hops += 1;
                speech_buffer.extend_from_slice(&hop_chunk);
                if silence_hops >= config.silence_chunks {
                    in_speech = false;
                    if speech_hops >= config.min_speech_chunks {
                        emit_dictation_utterance(&app, sr, &speech_buffer, &config);
                    }
                    speech_buffer.clear();
                }
            } else {
                pre_speech.push_back(hop_chunk);
                while pre_speech.len() > config.pre_speech_chunks {
                    pre_speech.pop_front();
                }
            }
        }
    }

    // Flush a trailing utterance on stop.
    if in_speech && speech_hops >= config.min_speech_chunks {
        emit_dictation_utterance(&app, sr, &speech_buffer, &config);
    }
}

fn emit_dictation_utterance(app: &AppHandle, sr: u32, samples: &[f32], config: &VadConfig) {
    let processed = prepare_utterance(samples, config.noise_gate_threshold, false).processed;
    if processed.is_empty() {
        return;
    }
    match samples_to_wav_b64(sr, &processed) {
        Ok(b64) => {
            let _ = app.emit("dictation-detected", serde_json::json!({ "audio": b64 }));
        }
        Err(e) => error!("Failed to encode dictation utterance: {e}"),
    }
}
