// Assistant AI Speech Detection, and capture system audio (speaker output) as a stream of f32 samples.
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

#[cfg(target_os = "macos")]
/// Silero VAD contract: 4096-sample chunks of 16 kHz mono audio (256 ms).
const SILERO_CHUNK_SAMPLES: usize = 4096;
const SILERO_SAMPLE_RATE: usize = 16_000;

/// Linear resampler for the VAD path. The capture tap runs at the device rate
/// (typically 48 kHz); Silero expects 16 kHz. Feeding device-rate audio in
/// directly pitch-shifts it 3x and makes the speech probabilities garbage.
fn resample_linear(input: &[f32], from_rate: usize, to_rate: usize) -> Vec<f32> {
    if from_rate == to_rate || input.is_empty() {
        return input.to_vec();
    }
    let out_len = (input.len() * to_rate / from_rate).max(1);
    let step = (input.len() - 1) as f32 / (out_len - 1).max(1) as f32;
    (0..out_len)
        .map(|i| {
            let pos = i as f32 * step;
            let idx = pos as usize;
            let frac = pos - idx as f32;
            let a = input[idx];
            let b = input[(idx + 1).min(input.len() - 1)];
            a + (b - a) * frac
        })
        .collect()
}

fn samples_for_local_asr(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    resample_linear(samples, sample_rate as usize, SILERO_SAMPLE_RATE)
}

/// Hysteresis thresholds mirroring the microphone path (@ricky0123/vad-react
/// defaults): enter speech when probability rises above 0.5, only leave once
/// it drops below 0.35. A single hard cutoff drops soft mid-sentence syllables
/// and chops utterances at natural pauses.
const SILERO_POSITIVE_THRESHOLD: f32 = 0.5;
const SILERO_NEGATIVE_THRESHOLD: f32 = 0.35;

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

/// Raw Silero speech probability for a 16 kHz chunk (max across frames), or
/// None when Silero is unavailable and the threshold fallback should be used.
fn get_silero_vad_probability(
    app: &AppHandle,
    samples: &[f32],
) -> Option<f32> {
    #[cfg(target_os = "macos")]
    {
        if let Some(stt_state) = app.try_state::<crate::stt::SttState>() {
            if let Ok(frames) = stt_state.vad_process_samples(samples) {
                return Some(
                    frames
                        .iter()
                        .map(|f| f.probability)
                        .fold(0.0f32, f32::max),
                );
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, samples);
    None
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
    start_time: f32,
    end_time: f32,
) {
    if samples.is_empty() {
        let _ = app.emit(
            "audio-encoding-error",
            "Captured audio was empty after normalization",
        );
        return;
    }

    let Ok(b64) = samples_to_wav_b64(sr, samples) else {
        error!("Failed to encode speech to WAV");
        let _ = app.emit("audio-encoding-error", "Failed to encode speech");
        return;
    };

    let utterance_id = app
        .state::<crate::stt::UtteranceStore>()
        .put(samples_for_local_asr(samples, sr));

    let _ = app.emit(
        "speech-detected",
        serde_json::json!({
            "audio": b64,
            "utterance_id": utterance_id,
            "start_time": start_time,
            "end_time": end_time,
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
    #[serde(default = "default_chunk_interval")]
    pub chunk_interval_ms: u64,
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
            silence_chunks: 100,    // ~2.1s of silence before stopping (tolerates thinking pauses)
            min_speech_chunks: 12,  // ~0.26s - matches the mic path's minSpeechFrames
            pre_speech_chunks: 30,  // ~0.64s - covers 2+ Silero refresh periods (256ms each) so
                                    // the word onset survives until VAD triggers
            noise_gate_threshold: 0.0015, // Gentler gate for compressed system audio
            max_recording_duration_secs: 180, // 3 minutes default
            emit_chunks: false,
            chunk_interval_ms: 1000,
        }
    }
}

/// Mutex-protected slot for the currently running capture task.
///
/// `claim` verifies the slot is empty and stores the handle in the same lock
/// acquisition, so two concurrent starts cannot both pass the emptiness check
/// and double-spawn (the TOCTOU that allowed duplicate capture tasks and
/// duplicate speech-detected events). `release_if_owned` lets a finishing
/// task clear the slot only while it still holds its own handle, so a stale
/// task can never clobber a newer capture's entry.
pub struct TaskSlot<T> {
    inner: std::sync::Mutex<Option<tokio::task::JoinHandle<T>>>,
}

impl<T> TaskSlot<T> {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
    }

    /// Claim the slot for `task`, failing if a task is already registered.
    /// A task that already finished is not stored: it can never be observed
    /// as "running" by a later start.
    pub fn claim(
        &self,
        task: tokio::task::JoinHandle<T>,
        already_running: &str,
    ) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire lock: {}", e))?;
        if guard.is_some() {
            return Err(already_running.to_string());
        }
        if !task.is_finished() {
            *guard = Some(task);
        }
        Ok(())
    }

    /// Clear the slot, but only if it still holds the task with id `my_id`.
    /// Called by a finishing task; a stale task can never clobber a newer
    /// capture's entry.
    pub fn release_if_owned(&self, my_id: tokio::task::Id) {
        if let Ok(mut guard) = self.inner.lock() {
            if guard.as_ref().map(|t| t.id()) == Some(my_id) {
                *guard = None;
            }
        }
    }

    /// Take the registered task out of the slot (stop path).
    pub fn take(&self) -> Result<Option<tokio::task::JoinHandle<T>>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| format!("Failed to acquire task lock: {}", e))?;
        Ok(guard.take())
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
        .map_or(true, |d| d.is_empty() || d == "default");
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
    state.stop_flag.store(false, Ordering::Release);
    let stop_flag = state.stop_flag.clone();

    let state_clone = app.state::<crate::AudioState>();
    let task = tokio::spawn(async move {
        let session_path = if vad_config.enabled {
            run_vad_capture(
                app_clone.clone(),
                stream,
                sr,
                vad_config,
                monitor_output_uid,
                stop_flag,
            )
            .await
        } else {
            run_continuous_capture(app_clone.clone(), stream, sr, vad_config, stop_flag).await;
            None
        };

        // Release the task slot, but only while it still holds this task:
        // a newer capture may have claimed the slot since (never clobber a
        // live task's entry).
        let state = app_clone.state::<crate::AudioState>();
        state.stream_task.release_if_owned(tokio::task::id());

        session_path
    });

    // Claim the slot in the same lock acquisition that verifies it is empty,
    // so concurrent starts cannot both pass the check and double-spawn (the
    // TOCTOU that produced duplicate capture tasks and duplicate
    // speech-detected events).
    if let Err(e) = state_clone.stream_task.claim(task, "Capture already running") {
        warn!("{}", e);
        return Err(e);
    }

    *state_clone
        .is_capturing
        .lock()
        .map_err(|e| format!("Failed to set capturing state: {}", e))? = true;

    let _ = app.emit("capture-started", sr);

    Ok(())
}

// VAD-enabled capture - OPTIMIZED for real-time speech detection
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
) -> Option<std::path::PathBuf> {
    let mut stream = stream;
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
    let max_session_samples =
        (sr as usize * config.max_recording_duration_secs as usize).min(sr as usize * 3600);
    let mut session_audio: Vec<f32> = Vec::new();
    let mut vad_accumulator: Vec<f32> = Vec::new();
    // macOS assumes silence until the first Silero result; elsewhere Silero
    // never runs, so start at None to engage the threshold fallback.
    let mut pending_silero_prob: Option<f32> = if cfg!(target_os = "macos") {
        Some(0.0)
    } else {
        None
    };
    let mut vad_hops_until_refresh: usize = 0;
    let mut utterance_start_time: f32 = 0.0;

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

            let mono = apply_noise_gate(&raw_mono, config.noise_gate_threshold);

            if session_audio.len() + mono.len() <= max_session_samples {
                session_audio.extend_from_slice(&mono);
            }

            // Silero VAD processes 256 ms chunks of 16 kHz audio. The tap runs
            // at the device rate, so accumulate 256 ms of device-rate samples
            // and resample down to Silero's expected 4096 @ 16 kHz.
            #[cfg(target_os = "macos")]
            {
                let silero_device_chunk =
                    (sr as usize * SILERO_CHUNK_SAMPLES) / SILERO_SAMPLE_RATE;
                vad_accumulator.extend_from_slice(&raw_mono);
                if vad_accumulator.len() >= silero_device_chunk {
                    let chunk: Vec<f32> =
                        vad_accumulator.drain(..silero_device_chunk).collect();
                    let chunk_16k =
                        resample_linear(&chunk, sr as usize, SILERO_SAMPLE_RATE);
                    pending_silero_prob = get_silero_vad_probability(&app, &chunk_16k);
                    vad_hops_until_refresh = silero_device_chunk / config.hop_size;
                }
                if vad_hops_until_refresh > 0 {
                    vad_hops_until_refresh -= 1;
                }
            }

            let is_speech = match pending_silero_prob {
                // Mic-style hysteresis on the raw probability.
                Some(prob) => silero_is_speech(in_speech, prob),
                None => {
                    // Fallback to threshold VAD
                    let (rms, peak) = calculate_audio_metrics(&mono);
                    rms > config.sensitivity_rms || peak > config.peak_threshold
                }
            };

            if is_speech {
                if !in_speech {
                    // Speech START detected
                    in_speech = true;
                    speech_chunks = 0;

                    // Include pre-speech buffer for natural sound
                    speech_buffer.extend(pre_speech.drain(..));

                    utterance_start_time = session_start.elapsed().as_secs_f32();

                    let _ = app.emit("speech-start", ());
                    last_emitted_len = 0;
                    last_chunk_time = Some(Instant::now());
                }

                speech_chunks += 1;
                speech_buffer.extend_from_slice(&mono);
                silence_chunks = 0; // Reset silence counter on any speech

                if config.emit_chunks {
                    // Emit incremental streaming chunks for custom providers
                    if let Some(t) = last_chunk_time {
                        if t.elapsed() >= chunk_interval && speech_buffer.len() > last_emitted_len {
                            let new_samples = &speech_buffer[last_emitted_len..];
                            let cleaned = apply_noise_gate(
                                new_samples,
                                config.noise_gate_threshold,
                            );
                            let normalized = normalize_audio_level(&cleaned, 0.1);
                            if let Ok(b64) = samples_to_raw_f32_b64(&normalized) {
                                let _ = app.emit("speech-chunk", b64);
                            }
                            last_emitted_len = speech_buffer.len();
                            last_chunk_time = Some(Instant::now());
                        }
                    }
                }

                // Safety cap: force emit if exceeds 30s
                if speech_buffer.len() > max_samples {
                    let utterance_end_time = session_start.elapsed().as_secs_f32();
                    let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                    emit_speech_detected(
                        &app,
                        sr,
                        &normalized_buffer,
                        utterance_start_time,
                        utterance_end_time,
                    );
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
                    speech_buffer.extend_from_slice(&mono);

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

                            let utterance_end_time = session_start.elapsed().as_secs_f32();
                            let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
                            emit_speech_detected(
                                &app,
                                sr,
                                &normalized_buffer,
                                utterance_start_time,
                                utterance_end_time,
                            );
                        } else {
                            let _ = app.emit(
                                "speech-discarded",
                                "Audio too short (likely background noise)",
                            );
                        }

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
                    pre_speech.extend(mono.into_iter());

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
        }
    }

    // Emit any remaining audio when the stream ends.
    if in_speech && !speech_buffer.is_empty() {
        let utterance_end_time = session_start.elapsed().as_secs_f32();
        let normalized_buffer = normalize_audio_level(&speech_buffer, 0.1);
        emit_speech_detected(
            &app,
            sr,
            &normalized_buffer,
            utterance_start_time,
            utterance_end_time,
        );
    }

    // Write session WAV for diarization
    let mut session_path: Option<std::path::PathBuf> = None;
    if !session_audio.is_empty() {
        let temp_dir = std::env::temp_dir();
        let temp_path = temp_dir.join(format!("assistant-session-{}.wav", uuid::Uuid::new_v4()));
        if let Err(e) = write_f32_samples_to_wav(sr, &session_audio, &temp_path) {
            error!("Failed to write session WAV: {}", e);
        } else {
            let Some(stt_state) = app.try_state::<crate::stt::SttState>() else {
                let _ = std::fs::remove_file(&temp_path);
                return None;
            };
            if let Err(e) = stt_state.set_session_wav_path(temp_path.clone()) {
                error!("Failed to manage session WAV: {}", e);
                let _ = std::fs::remove_file(&temp_path);
                return None;
            }
            session_path = Some(temp_path);
        }
    }

    session_path
}

// Continuous capture (VAD disabled)
async fn run_continuous_capture(
    app: AppHandle,
    stream: impl StreamExt<Item = f32> + Unpin,
    sr: u32,
    config: VadConfig,
    stop_flag: Arc<AtomicBool>,
) -> Option<std::path::PathBuf> {
    let mut stream = stream;
    let max_samples = (sr as u64 * config.max_recording_duration_secs) as usize;

    // Pre-allocate buffer to prevent reallocations
    let mut audio_buffer = Vec::with_capacity(max_samples);
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
                            let cleaned = apply_noise_gate(new_samples, config.noise_gate_threshold);
                            let normalized = normalize_audio_level(&cleaned, 0.1);
                            if let Ok(b64) = samples_to_raw_f32_b64(&normalized) {
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

    // Process and emit audio
    if !audio_buffer.is_empty() {
        // let duration = start_time.elapsed().as_secs_f32();

        // Apply noise gate
        let cleaned_audio = apply_noise_gate(&audio_buffer, config.noise_gate_threshold);
        let cleaned_audio = normalize_audio_level(&cleaned_audio, 0.1);

        emit_speech_detected(&app, sr, &cleaned_audio, 0.0, 0.0);
    } else {
        warn!("No audio captured in continuous mode");
        let _ = app.emit("audio-encoding-error", "No audio recorded");
    }

    let _ = app.emit("continuous-recording-stopped", ());

    None
}

// Apply noise gate
fn apply_noise_gate(samples: &[f32], threshold: f32) -> Vec<f32> {
    const KNEE_RATIO: f32 = 3.0; // Compression ratio for soft knee

    samples
        .iter()
        .map(|&s| {
            let abs = s.abs();
            if abs < threshold {
                s * (abs / threshold).powf(1.0 / KNEE_RATIO)
            } else {
                s
            }
        })
        .collect()
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

fn normalize_audio_level(samples: &[f32], target_rms: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let sum_squares: f32 = samples.iter().map(|&s| s * s).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return samples.to_vec();
    }

    let gain = (target_rms / current_rms).min(10.0);

    samples
        .iter()
        .map(|&s| {
            let amplified = s * gain;
            if amplified.abs() > 1.0 {
                amplified.signum() * (1.0 - (-amplified.abs()).exp())
            } else {
                amplified
            }
        })
        .collect()
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
) -> Result<Option<std::path::PathBuf>, String> {
    let state = app.state::<crate::AudioState>();
    state.stop_flag.store(true, Ordering::Release);

    // Take the task and await it so the capture function can finish writing
    // its session WAV before we return to the frontend.
    let task = state.stream_task.take()?;

    let session_path = if let Some(task) = task {
        await_capture_shutdown(task, Duration::from_secs(5)).await
    } else {
        None
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
pub fn get_audio_sample_rate(_app: AppHandle) -> Result<u32, String> {
    let input = SpeakerInput::new().map_err(|e| {
        error!("Failed to create speaker input: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;

    // macOS exposes the tap's format rate without starting the aggregate
    // device; the other platforms only learn the rate once the capture loop
    // runs, so they fall back to starting the stream.
    if let Some(sr) = input.sample_rate() {
        return Ok(sr);
    }

    let stream = input.stream().map_err(|e| {
        error!("Failed to start audio stream: {}", e);
        format!("Failed to access system audio: {}", e)
    })?;
    Ok(stream.sample_rate())
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
    fn resample_is_identity_when_rates_match() {
        let input = vec![0.1, 0.2, 0.3, 0.4];
        assert_eq!(resample_linear(&input, 16_000, 16_000), input);
    }

    #[test]
    fn resample_handles_empty_input() {
        assert!(resample_linear(&[], 48_000, 16_000).is_empty());
    }

    #[test]
    fn resample_downsamples_length_by_the_rate_ratio() {
        // 48 kHz -> 16 kHz is a 3:1 decimation. 4096 in -> ~1365 out.
        let input = vec![0.0f32; 4096];
        let out = resample_linear(&input, 48_000, 16_000);
        assert_eq!(out.len(), 4096 * 16_000 / 48_000);
    }

    #[test]
    fn resample_upsamples_length_by_the_rate_ratio() {
        // 8 kHz -> 16 kHz doubles the frame count (the sub-16k truncation case).
        let input = vec![0.0f32; 1000];
        let out = resample_linear(&input, 8_000, 16_000);
        assert_eq!(out.len(), 2000);
    }

    #[test]
    fn resample_preserves_endpoints_and_stays_in_range() {
        // A ramp from 0..1 should still start at 0 and end at ~1 after resampling.
        let input: Vec<f32> = (0..48).map(|i| i as f32 / 47.0).collect();
        let out = resample_linear(&input, 48_000, 16_000);
        assert!((out[0] - 0.0).abs() < 1e-6);
        assert!((out[out.len() - 1] - 1.0).abs() < 1e-6);
        for &v in &out {
            assert!((0.0..=1.0).contains(&v));
        }
    }

    #[test]
    fn normalizes_cached_utterance_samples_to_16khz() {
        let device_rate_samples = vec![0.25f32; 48_000];
        let normalized = samples_for_local_asr(&device_rate_samples, 48_000);
        assert_eq!(normalized.len(), 16_000);

        let native_rate_samples = vec![0.5f32; 16_000];
        assert_eq!(
            samples_for_local_asr(&native_rate_samples, 16_000),
            native_rate_samples
        );
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
    async fn second_claim_rejected_while_a_task_is_registered() {
        let slot = TaskSlot::<()>::new();
        let first = tokio::spawn(std::future::pending::<()>());
        slot.claim(first, "Capture already running").unwrap();

        let second = tokio::spawn(async {});
        assert_eq!(
            slot.claim(second, "Capture already running"),
            Err("Capture already running".to_string())
        );
        // The winner's entry is untouched by the rejected claim.
        assert!(slot.take().unwrap().is_some());
    }

    #[tokio::test]
    async fn owner_cleanup_releases_the_slot() {
        let slot = TaskSlot::<()>::new();
        let task = tokio::spawn(async {});
        let id = task.id();
        slot.claim(task, "busy").unwrap();

        slot.release_if_owned(id);

        assert!(slot.take().unwrap().is_none());
    }

    #[tokio::test]
    async fn stale_task_cleanup_does_not_clobber_the_newer_captures_slot() {
        let slot = TaskSlot::<()>::new();
        let first = tokio::spawn(std::future::pending::<()>());
        let stale_id = first.id();
        slot.claim(first, "busy").unwrap();
        slot.take().unwrap(); // first capture stopped

        let second = tokio::spawn(std::future::pending::<()>());
        slot.claim(second, "busy").unwrap();

        // The first task's exit cleanup runs late (after the slot was
        // reclaimed): it must not clear the newer task's entry.
        slot.release_if_owned(stale_id);

        assert!(slot.take().unwrap().is_some());
    }

    #[tokio::test]
    async fn claim_skips_a_task_that_finished_before_the_claim() {
        let slot = TaskSlot::<()>::new();
        // A capture whose stream ends before the claim must not leave a
        // finished task in the slot ("Capture already running" forever).
        let task = tokio::spawn(async {});
        tokio::task::yield_now().await; // let the spawned task run to completion
        slot.claim(task, "busy").unwrap();

        assert!(slot.take().unwrap().is_none());
    }

    #[test]
    fn vad_config_validate_accepts_the_defaults() {
        assert!(VadConfig::default().validate().is_ok());
    }

    #[test]
    fn vad_config_validate_rejects_unbounded_hop_size() {
        // hop_size feeds Vec/VecDeque::with_capacity in the capture task: an
        // unbounded value overflows capacity and panics the spawned task.
        let mut config = VadConfig::default();
        config.hop_size = 1_000_000;
        assert!(config.validate().is_err());

        config.hop_size = 128; // below the 256 floor
        assert!(config.validate().is_err());
    }

    #[test]
    fn vad_config_validate_rejects_unbounded_pre_speech_and_silence_chunks() {
        let mut config = VadConfig::default();
        config.pre_speech_chunks = 100_000;
        assert!(config.validate().is_err());

        let mut config = VadConfig::default();
        config.silence_chunks = 100_000;
        assert!(config.validate().is_err());
    }

    #[test]
    fn vad_config_validate_rejects_fast_chunk_interval() {
        let mut config = VadConfig::default();
        config.chunk_interval_ms = 1;
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
        let silero_device_chunk = (sr * SILERO_CHUNK_SAMPLES) / SILERO_SAMPLE_RATE;
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

        let path = std::env::temp_dir().join(format!(
            "aileron-perms-{}.wav",
            uuid::Uuid::new_v4()
        ));
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
pub async fn start_mic_dictation(
    app: AppHandle,
    device_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<MicDictationState>();

    // Fail fast if Silero isn't available: dictation quality depends on it.
    if get_silero_vad_probability(&app, &[0.0f32; 512]).is_none() {
        return Err(
            "Voice detection isn't ready — initialize speech recognition first".to_string(),
        );
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
        let _ = app_clone.emit("dictation-stopped", ());
        let state = app_clone.state::<MicDictationState>();
        state.task.release_if_owned(tokio::task::id());
    });

    // Same atomic claim as the system-audio slot: the check and the store
    // share one lock acquisition, so concurrent starts cannot double-spawn.
    state.task.claim(task, "Dictation already running")?;
    Ok(())
}

#[tauri::command]
pub async fn stop_mic_dictation(app: AppHandle) -> Result<(), String> {
    let state = app.state::<MicDictationState>();
    state
        .stop_flag
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let task = state.task.take()?;
    if let Some(task) = task {
        let _ = tokio::time::timeout(tokio::time::Duration::from_secs(3), task).await;
    }
    Ok(())
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
        let chunk = match tokio::time::timeout(
            tokio::time::Duration::from_millis(200),
            rx.recv(),
        )
        .await
        {
            Ok(Some(c)) => c,
            Ok(None) => break,  // stream thread ended
            Err(_) => continue, // timeout: re-check stop flag
        };
        pending.extend_from_slice(&chunk);

        while pending.len() >= hop {
            let hop_chunk: Vec<f32> = pending.drain(..hop).collect();
            let chunk_16k = resample_linear(&hop_chunk, sr as usize, SILERO_SAMPLE_RATE);
            if let Some(p) = get_silero_vad_probability(&app, &chunk_16k) {
                prob = Some(p);
            }
            let is_speech = match prob {
                Some(p) => silero_is_speech(in_speech, p),
                None => {
                    // Threshold fallback (mirrors the tap loop's philosophy).
                    let (rms, peak) = calculate_audio_metrics(&hop_chunk);
                    rms > config.sensitivity_rms || peak > config.peak_threshold
                }
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
    let cleaned = apply_noise_gate(samples, config.noise_gate_threshold);
    let normalized = normalize_audio_level(&cleaned, 0.1);
    if normalized.is_empty() {
        return;
    }
    match samples_to_wav_b64(sr, &normalized) {
        Ok(b64) => {
            let _ = app.emit("dictation-detected", serde_json::json!({ "audio": b64 }));
        }
        Err(e) => error!("Failed to encode dictation utterance: {e}"),
    }
}
