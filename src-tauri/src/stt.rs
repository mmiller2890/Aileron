#[cfg(target_os = "macos")]
use fluidaudio_rs::{AsrModelVersion, FluidAudio};
use serde_json;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// How many recent utterances to keep addressable by id.
///
/// Only the newest is normally claimed; the small backlog covers a frontend
/// that falls behind during a burst of speech.
const MAX_CACHED_UTTERANCES: usize = 4;
const CACHED_UTTERANCE_TTL: Duration = Duration::from_secs(60);
const UTTERANCE_CACHE_MISS_PREFIX: &str = "UTTERANCE_CACHE_MISS:";

#[cfg(target_os = "macos")]
fn cleanup_session_file_after<T>(
    path: &std::path::Path,
    result: Result<T, String>,
) -> Result<T, String> {
    let cleanup_result = std::fs::remove_file(path).map_err(|error| error.to_string());
    match (result, cleanup_result) {
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(cleanup_error)) => Err(format!(
            "Failed to remove session audio after processing: {cleanup_error}"
        )),
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup_error)) => Err(format!(
            "{error}; failed to remove session audio: {cleanup_error}"
        )),
    }
}

pub(crate) struct CachedUtterance {
    id: String,
    pub(crate) primary_samples: Vec<f32>,
    pub(crate) comparison_samples: Option<Vec<f32>>,
    pub(crate) source_sample_rate: u32,
    pub(crate) source_duration: f64,
    created_at: Instant,
}

#[derive(Debug, Clone)]
struct TranscriptionVariant {
    raw_text: String,
    normalized_text: String,
    confidence: f32,
    duration: f64,
    processing_time: f64,
}

fn transcription_variant_json(variant: &TranscriptionVariant) -> serde_json::Value {
    serde_json::json!({
        "text": variant.normalized_text,
        "raw_text": variant.raw_text,
        "normalized_text": variant.normalized_text,
        "confidence": variant.confidence,
        "duration": variant.duration,
        "processing_time": variant.processing_time,
        "itn_applied": variant.normalized_text != variant.raw_text,
    })
}

fn build_local_transcription_result(
    primary: TranscriptionVariant,
    comparison: Option<(Result<TranscriptionVariant, String>, f64)>,
    model_version: &str,
    path: &str,
    preprocessing: &str,
    source_sample_rate: u32,
    source_duration: f64,
    converted_sample_count: usize,
    comparison_converted_sample_count: Option<usize>,
) -> serde_json::Value {
    let comparison = comparison.map(|(result, attempt_seconds)| match result {
        Ok(variant) => {
            let mut value = transcription_variant_json(&variant);
            value["diagnostics"] = serde_json::json!({
                "model_version": model_version,
                "preprocessing": "raw",
                "source_path": path,
                "input_duration_ms": source_duration * 1_000.0,
                "input_sample_rate": source_sample_rate,
                "converted_sample_count": comparison_converted_sample_count
                    .unwrap_or(converted_sample_count),
                "transcription_ms": variant.processing_time * 1_000.0,
                "itn_applied": variant.normalized_text != variant.raw_text,
            });
            value
        }
        Err(error) => serde_json::json!({
            "error": error,
            "diagnostics": {
                "model_version": model_version,
                "preprocessing": "raw",
                "source_path": path,
                "input_duration_ms": source_duration * 1_000.0,
                "input_sample_rate": source_sample_rate,
                "converted_sample_count": comparison_converted_sample_count
                    .unwrap_or(converted_sample_count),
                "transcription_ms": attempt_seconds * 1_000.0,
                "itn_applied": false,
            },
        }),
    });

    serde_json::json!({
        "text": primary.normalized_text,
        "raw_text": primary.raw_text,
        "normalized_text": primary.normalized_text,
        "confidence": primary.confidence,
        "duration": primary.duration,
        "processing_time": primary.processing_time,
        "diagnostics": {
            "model_version": model_version,
            "itn_applied": primary.normalized_text != primary.raw_text,
            "preprocessing": preprocessing,
            "source_path": path,
            "input_sample_rate": source_sample_rate,
            "input_duration_ms": source_duration * 1_000.0,
            "converted_sample_count": converted_sample_count,
            "transcription_ms": primary.processing_time * 1_000.0,
        },
        "comparison": comparison,
    })
}

/// Samples for recently captured utterances, addressable by id.
///
/// The capture loop already holds each utterance as f32 samples. Without this,
/// the local STT path encoded them to a base64 WAV, shipped that to the
/// frontend, and the frontend decoded it (atob loop, a fresh `AudioContext`,
/// `decodeAudioData`, resample) only to send the samples straight back as a
/// JSON array of ~80k numbers — a full round trip of the audio across the IPC
/// boundary to reach code running in the same process that produced it.
#[derive(Default)]
pub struct UtteranceStore {
    inner: Mutex<VecDeque<CachedUtterance>>,
}

impl UtteranceStore {
    #[cfg(test)]
    fn put_at(&self, samples: Vec<f32>, now: Instant) -> Option<String> {
        let duration = samples.len() as f64 / 16_000.0;
        self.put_capture_at(samples, None, 16_000, duration, now)
    }

    pub(crate) fn put_capture(
        &self,
        primary_samples: Vec<f32>,
        comparison_samples: Option<Vec<f32>>,
        source_sample_rate: u32,
        source_duration: f64,
    ) -> Option<String> {
        self.put_capture_at(
            primary_samples,
            comparison_samples,
            source_sample_rate,
            source_duration,
            Instant::now(),
        )
    }

    fn put_capture_at(
        &self,
        primary_samples: Vec<f32>,
        comparison_samples: Option<Vec<f32>>,
        source_sample_rate: u32,
        source_duration: f64,
        now: Instant,
    ) -> Option<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut queue = self.inner.lock().ok()?;
        Self::prune_expired(&mut queue, now);
        while queue.len() >= MAX_CACHED_UTTERANCES {
            queue.pop_front();
        }
        queue.push_back(CachedUtterance {
            id: id.clone(),
            primary_samples,
            comparison_samples,
            source_sample_rate,
            source_duration,
            created_at: now,
        });
        Some(id)
    }

    /// Claim an utterance, removing it from the cache.
    pub(crate) fn take(&self, id: &str) -> Option<CachedUtterance> {
        self.take_at(id, Instant::now())
    }

    fn take_at(&self, id: &str, now: Instant) -> Option<CachedUtterance> {
        let mut queue = self.inner.lock().ok()?;
        Self::prune_expired(&mut queue, now);
        let position = queue.iter().position(|entry| entry.id == id)?;
        queue.remove(position)
    }

    fn prune_expired(queue: &mut VecDeque<CachedUtterance>, now: Instant) {
        queue.retain(|entry| {
            now.saturating_duration_since(entry.created_at) <= CACHED_UTTERANCE_TTL
        });
    }
}

#[cfg(test)]
mod utterance_store_tests {
    #[cfg(target_os = "macos")]
    use super::AsrModelVersion;
    use super::{
        build_local_transcription_result, cleanup_session_file_after, try_lock_stt_inner, SttInner,
        SttState, TranscriptionVariant, UtteranceStore, MAX_CACHED_UTTERANCES,
    };
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_supported_asr_model_versions() {
        assert_eq!(AsrModelVersion::parse("v2"), Ok(AsrModelVersion::V2));
        assert_eq!(AsrModelVersion::parse("v3"), Ok(AsrModelVersion::V3));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_unknown_asr_model_versions() {
        assert!(AsrModelVersion::parse("turbo").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_itn_symbols_are_available_at_runtime() {
        let audio = fluidaudio_rs::FluidAudio::new().unwrap();

        assert!(audio.itn_is_native_available());
        assert_eq!(audio.itn_normalize("two hundred").unwrap(), "200");
    }

    #[test]
    fn evicts_the_oldest_entry_when_capacity_is_exceeded() {
        let store = UtteranceStore::default();
        let now = Instant::now();
        let ids: Vec<String> = (0..=MAX_CACHED_UTTERANCES)
            .map(|index| store.put_at(vec![index as f32], now).unwrap())
            .collect();

        assert!(store.take_at(&ids[0], now).is_none());
        assert_eq!(
            store
                .take_at(ids.last().unwrap(), now)
                .map(|entry| entry.primary_samples),
            Some(vec![MAX_CACHED_UTTERANCES as f32])
        );
    }

    #[test]
    fn expires_unclaimed_entries_after_the_ttl() {
        let store = UtteranceStore::default();
        let now = Instant::now();
        let id = store.put_at(vec![1.0], now).unwrap();

        assert!(store.take_at(&id, now + Duration::from_secs(61)).is_none());
    }

    #[test]
    fn claims_primary_and_comparison_as_one_utterance() {
        let store = UtteranceStore::default();
        let now = Instant::now();
        let id = store
            .put_capture_at(vec![1.0], Some(vec![2.0]), 48_000, 1.25, now)
            .unwrap();

        let cached = store.take_at(&id, now).unwrap();

        assert_eq!(cached.primary_samples, vec![1.0]);
        assert_eq!(cached.comparison_samples, Some(vec![2.0]));
        assert_eq!(cached.source_sample_rate, 48_000);
        assert_eq!(cached.source_duration, 1.25);
    }

    #[test]
    fn comparison_failure_keeps_the_primary_result() {
        let primary = TranscriptionVariant {
            raw_text: "one two".to_string(),
            normalized_text: "1 2".to_string(),
            confidence: 0.9,
            duration: 1.0,
            processing_time: 0.2,
        };

        let result = build_local_transcription_result(
            primary,
            Some((Err("comparison failed".to_string()), 0.05)),
            "v3",
            "utterance-cache",
            "processed",
            48_000,
            1.25,
            16_000,
            None,
        );

        assert_eq!(result["text"], "1 2");
        assert_eq!(result["comparison"]["error"], "comparison failed");
        assert_eq!(result["diagnostics"]["source_path"], "utterance-cache");
        assert_eq!(result["diagnostics"]["input_duration_ms"], 1_250.0);
        assert_eq!(result["diagnostics"]["input_sample_rate"], 48_000);
        assert_eq!(result["diagnostics"]["transcription_ms"], 200.0);
        assert_eq!(
            result["comparison"]["diagnostics"]["transcription_ms"],
            50.0
        );
        assert_eq!(result["comparison"]["diagnostics"]["itn_applied"], false);
        assert!(result["diagnostics"].get("path").is_none());
    }

    #[test]
    fn consecutive_utterances_keep_comparisons_separate() {
        let store = UtteranceStore::default();
        let now = Instant::now();
        let first = store
            .put_capture_at(vec![1.0], Some(vec![10.0]), 16_000, 0.5, now)
            .unwrap();
        let second = store
            .put_capture_at(vec![2.0], Some(vec![20.0]), 16_000, 0.5, now)
            .unwrap();

        let first = store.take_at(&first, now).unwrap();
        let second = store.take_at(&second, now).unwrap();

        assert_eq!(first.comparison_samples, Some(vec![10.0]));
        assert_eq!(second.comparison_samples, Some(vec![20.0]));
    }

    #[test]
    fn long_utterance_keeps_full_source_duration() {
        let store = UtteranceStore::default();
        let now = Instant::now();
        let id = store
            .put_capture_at(vec![0.0; 16_000 * 16], None, 16_000, 16.0, now)
            .unwrap();

        let cached = store.take_at(&id, now).unwrap();

        assert_eq!(cached.primary_samples.len(), 16_000 * 16);
        assert_eq!(cached.source_duration, 16.0);
    }

    #[test]
    fn busy_stt_lock_returns_without_waiting() {
        let inner = Mutex::new(SttInner::default());
        let _held = inner.lock().unwrap();

        assert_eq!(
            try_lock_stt_inner(&inner).err().as_deref(),
            Some("STT temporarily unavailable")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vad_lock_remains_available_while_asr_is_busy() {
        let state = SttState::default();
        let _asr = state.inner.lock().unwrap();

        assert!(state.streaming_vad.try_lock().is_ok());
        assert!(state.batch_vad.try_lock().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn streaming_vad_lock_remains_available_while_batch_vad_is_busy() {
        let state = SttState::default();
        let _batch = state.batch_vad.lock().unwrap();

        assert!(state.streaming_vad.try_lock().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn session_path_update_does_not_wait_for_asr_lock() {
        let state = Arc::new(SttState::default());
        let held = state.inner.lock().unwrap();
        let worker_state = state.clone();
        let (sent, received) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = worker_state.set_session_wav_path(std::path::PathBuf::from(
                "/tmp/aileron-session-lock-test.wav",
            ));
            sent.send(result).unwrap();
        });

        let update = received.recv_timeout(Duration::from_millis(50));
        drop(held);
        worker.join().unwrap();

        assert!(update.is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn discarding_session_audio_removes_the_managed_file() {
        let state = SttState::default();
        let path = std::env::temp_dir().join(format!(
            "aileron-discard-session-{}.wav",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"wav").unwrap();
        state.set_session_wav_path(path.clone()).unwrap();

        state
            .discard_session_wav_path(path.to_string_lossy().as_ref())
            .unwrap();

        assert!(!path.exists());
        assert!(state.take_session_wav_path().is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replacing_session_audio_removes_the_previous_file() {
        let state = SttState::default();
        let previous_path = std::env::temp_dir().join(format!(
            "aileron-replaced-session-{}.wav",
            uuid::Uuid::new_v4()
        ));
        let current_path = std::env::temp_dir().join(format!(
            "aileron-current-session-{}.wav",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&previous_path, b"previous").unwrap();
        std::fs::write(&current_path, b"current").unwrap();

        state.set_session_wav_path(previous_path.clone()).unwrap();
        state.set_session_wav_path(current_path.clone()).unwrap();

        assert!(!previous_path.exists());
        assert_eq!(state.take_session_wav_path(), Some(current_path.clone()));
        std::fs::remove_file(current_path).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mismatched_discard_keeps_the_managed_session() {
        let state = SttState::default();
        let managed_path = std::env::temp_dir().join(format!(
            "aileron-managed-session-{}.wav",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&managed_path, b"managed").unwrap();
        state.set_session_wav_path(managed_path.clone()).unwrap();

        assert!(state
            .discard_session_wav_path("/tmp/not-the-managed-session.wav")
            .is_err());
        assert_eq!(state.take_session_wav_path(), Some(managed_path.clone()));
        std::fs::remove_file(managed_path).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn failed_session_processing_still_removes_the_audio_file() {
        let path = std::env::temp_dir().join(format!(
            "aileron-failed-diarization-{}.wav",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"sensitive audio").unwrap();

        let result: Result<(), String> =
            cleanup_session_file_after(&path, Err("diarization failed".to_string()));

        assert_eq!(result.unwrap_err(), "diarization failed");
        assert!(!path.exists());
    }
}

pub struct SttInner {
    #[cfg(target_os = "macos")]
    audio: Option<FluidAudio>,
    #[cfg(target_os = "macos")]
    model_version: Option<AsrModelVersion>,
    asr_ready: bool,
    diarization_ready: bool,
}

impl Default for SttInner {
    fn default() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            audio: None,
            #[cfg(target_os = "macos")]
            model_version: None,
            asr_ready: false,
            diarization_ready: false,
        }
    }
}

struct VadInner {
    #[cfg(target_os = "macos")]
    audio: Option<FluidAudio>,
    ready: bool,
}

impl Default for VadInner {
    fn default() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            audio: None,
            ready: false,
        }
    }
}

#[derive(Default)]
pub struct SttState {
    pub inner: Arc<Mutex<SttInner>>,
    streaming_vad: Arc<Mutex<VadInner>>,
    batch_vad: Arc<Mutex<VadInner>>,
    session_wav_path: Arc<Mutex<Option<std::path::PathBuf>>>,
}

#[cfg(test)]
fn try_lock_stt_inner(
    inner: &Mutex<SttInner>,
) -> Result<std::sync::MutexGuard<'_, SttInner>, String> {
    match inner.try_lock() {
        Ok(guard) => Ok(guard),
        Err(TryLockError::WouldBlock) => Err("STT temporarily unavailable".to_string()),
        Err(TryLockError::Poisoned(error)) => Err(error.to_string()),
    }
}

fn not_supported() -> String {
    "Local STT requires macOS Apple Silicon".to_string()
}

fn emit_error(app: &AppHandle, message: String) {
    eprintln!("[STT] error: {}", message);
    let _ = app.emit("stt-error", message);
}

impl SttState {
    #[cfg(target_os = "macos")]
    fn init_asr_inner(
        inner: Arc<Mutex<SttInner>>,
        app: AppHandle,
        model_version: AsrModelVersion,
    ) -> Result<(), String> {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        if guard.asr_ready && guard.model_version == Some(model_version) {
            return Ok(());
        }

        if guard.audio.is_none() {
            let audio = FluidAudio::new().map_err(|e| e.to_string())?;
            if audio.is_intel_mac() {
                let msg = not_supported();
                emit_error(&app, msg.clone());
                return Err(msg);
            }
            guard.audio = Some(audio);
        }
        guard
            .audio
            .as_ref()
            .ok_or("STT not initialized")?
            .init_asr_version(model_version)
            .map_err(|e| e.to_string())?;
        guard.asr_ready = true;
        guard.model_version = Some(model_version);
        let _ = app.emit("stt-ready", ());
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn init_vad_inner(
        inner: Arc<Mutex<VadInner>>,
        app: AppHandle,
        threshold: f32,
    ) -> Result<(), String> {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        if guard.ready {
            return Ok(());
        }
        if guard.audio.is_none() {
            let audio = FluidAudio::new().map_err(|e| e.to_string())?;
            if audio.is_intel_mac() {
                let msg = not_supported();
                emit_error(&app, msg.clone());
                return Err(msg);
            }
            guard.audio = Some(audio);
        }
        let audio = guard.audio.as_ref().ok_or("VAD not initialized")?;
        if let Err(e) = audio.init_vad(threshold) {
            let msg = e.to_string();
            emit_error(&app, format!("Failed to initialize VAD: {}", msg));
            return Err(msg);
        }
        guard.ready = true;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn init_diarization_inner(
        inner: Arc<Mutex<SttInner>>,
        app: AppHandle,
        threshold: f64,
    ) -> Result<(), String> {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        if guard.diarization_ready {
            return Ok(());
        }
        let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
        if let Err(e) = audio.init_diarization(threshold) {
            let msg = e.to_string();
            emit_error(&app, format!("Failed to initialize diarization: {}", msg));
            return Err(msg);
        }
        guard.diarization_ready = true;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn vad_process_samples(
        &self,
        samples: &[f32],
    ) -> Result<Vec<fluidaudio_rs::VadFrame>, String> {
        let guard = self.batch_vad.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => "VAD temporarily unavailable".to_string(),
            TryLockError::Poisoned(error) => error.to_string(),
        })?;
        if !guard.ready {
            return Err("VAD not initialized".to_string());
        }
        let audio = guard.audio.as_ref().ok_or("VAD not initialized")?;
        audio
            .vad_process_samples(samples)
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn vad_process_streaming_samples(&self, samples: &[f32]) -> Result<f32, String> {
        let guard = self.streaming_vad.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => "VAD temporarily unavailable".to_string(),
            TryLockError::Poisoned(error) => error.to_string(),
        })?;
        if !guard.ready {
            return Err("VAD not initialized".to_string());
        }
        guard
            .audio
            .as_ref()
            .ok_or("VAD not initialized")?
            .vad_process_streaming_samples(samples)
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn reset_vad_stream(&self) -> Result<(), String> {
        let guard = self.streaming_vad.lock().map_err(|e| e.to_string())?;
        if !guard.ready {
            return Ok(());
        }
        guard
            .audio
            .as_ref()
            .ok_or("VAD not initialized")?
            .vad_reset_stream()
            .map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn diarize_file(
        &self,
        path: &str,
    ) -> Result<Vec<fluidaudio_rs::DiarizationSegment>, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        if !guard.diarization_ready {
            return Err("Diarization not initialized".to_string());
        }
        let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
        audio.diarize_file(path).map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn set_session_wav_path(&self, path: std::path::PathBuf) -> Result<(), String> {
        let mut guard = self.session_wav_path.lock().map_err(|e| e.to_string())?;
        if let Some(previous_path) = guard.as_ref().filter(|previous| *previous != &path) {
            std::fs::remove_file(previous_path).map_err(|error| error.to_string())?;
        }
        *guard = Some(path);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn take_session_wav_path(&self) -> Option<std::path::PathBuf> {
        self.session_wav_path.lock().ok()?.take()
    }

    #[cfg(target_os = "macos")]
    pub fn discard_session_wav_path(&self, path: &str) -> Result<(), String> {
        let mut guard = self.session_wav_path.lock().map_err(|e| e.to_string())?;
        let is_managed = guard
            .as_ref()
            .is_some_and(|managed| managed.to_string_lossy() == path);
        if !is_managed {
            return Err("Path is not the managed session audio file".to_string());
        }
        let managed_path = guard
            .take()
            .ok_or("Path is not the managed session audio file")?;
        drop(guard);
        std::fs::remove_file(managed_path).map_err(|error| error.to_string())
    }

    #[cfg(target_os = "macos")]
    fn ensure_asr(guard: &mut SttInner, model_version: AsrModelVersion) -> Result<(), String> {
        if guard.audio.is_none() {
            let audio = FluidAudio::new().map_err(|e| e.to_string())?;
            if audio.is_intel_mac() {
                return Err(not_supported());
            }
            guard.audio = Some(audio);
        }
        if !guard.asr_ready || guard.model_version != Some(model_version) {
            guard
                .audio
                .as_ref()
                .ok_or("STT not initialized")?
                .init_asr_version(model_version)
                .map_err(|e| e.to_string())?;
            guard.asr_ready = true;
            guard.model_version = Some(model_version);
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn transcribe_variant(
        audio: &FluidAudio,
        samples: &[f32],
    ) -> Result<TranscriptionVariant, String> {
        let result = audio
            .transcribe_samples(samples)
            .map_err(|e| e.to_string())?;
        let raw_text = result.text;
        let normalized_text = audio
            .itn_normalize_sentence(&raw_text)
            .unwrap_or(raw_text.clone());
        Ok(TranscriptionVariant {
            raw_text,
            normalized_text,
            confidence: result.confidence,
            duration: result.duration,
            processing_time: result.processing_time,
        })
    }

    fn transcribe_samples_inner(
        inner: Arc<Mutex<SttInner>>,
        samples: &[f32],
        model_version: String,
    ) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "macos"))]
        return Err(not_supported());

        #[cfg(target_os = "macos")]
        {
            let model_version = AsrModelVersion::parse(&model_version)?;
            let mut guard = inner.lock().map_err(|e| e.to_string())?;
            Self::ensure_asr(&mut guard, model_version)?;
            let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
            let primary = Self::transcribe_variant(audio, samples)?;
            Ok(build_local_transcription_result(
                primary,
                None,
                guard.model_version.unwrap_or(AsrModelVersion::V3).as_str(),
                "sample-ipc",
                "processed",
                16_000,
                samples.len() as f64 / 16_000.0,
                samples.len(),
                None,
            ))
        }
    }

    fn transcribe_cached_inner(
        inner: Arc<Mutex<SttInner>>,
        cached: CachedUtterance,
    ) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "macos"))]
        return Err(not_supported());

        #[cfg(target_os = "macos")]
        {
            let mut guard = inner.lock().map_err(|e| e.to_string())?;
            let model_version = guard.model_version.unwrap_or(AsrModelVersion::V3);
            Self::ensure_asr(&mut guard, model_version)?;
            let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
            let primary = Self::transcribe_variant(audio, &cached.primary_samples)?;
            let comparison_converted_sample_count =
                cached.comparison_samples.as_ref().map(Vec::len);
            let comparison = cached.comparison_samples.as_deref().map(|samples| {
                let started = Instant::now();
                let result = Self::transcribe_variant(audio, samples);
                (result, started.elapsed().as_secs_f64())
            });
            Ok(build_local_transcription_result(
                primary,
                comparison,
                guard.model_version.unwrap_or(AsrModelVersion::V3).as_str(),
                "utterance-cache",
                "processed",
                cached.source_sample_rate,
                cached.source_duration,
                cached.primary_samples.len(),
                comparison_converted_sample_count,
            ))
        }
    }

    pub fn get_status(&self) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "macos"))]
        {
            return Ok(serde_json::json!({
                "asr_ready": false,
                "model_version": serde_json::Value::Null,
                "vad_ready": false,
                "diarization_ready": false,
                "is_apple_silicon": false,
                "is_intel": false,
                "is_supported": false,
            }));
        }

        #[cfg(target_os = "macos")]
        {
            let guard = self.inner.lock().map_err(|e| e.to_string())?;
            let streaming_vad_guard = self.streaming_vad.lock().map_err(|e| e.to_string())?;
            let batch_vad_guard = self.batch_vad.lock().map_err(|e| e.to_string())?;

            let (is_apple_silicon, is_intel) = if let Some(audio) = guard.audio.as_ref() {
                (audio.is_apple_silicon(), audio.is_intel_mac())
            } else {
                match FluidAudio::new() {
                    Ok(audio) => (audio.is_apple_silicon(), audio.is_intel_mac()),
                    Err(_) => (false, false),
                }
            };

            Ok(serde_json::json!({
                "asr_ready": guard.asr_ready,
                "model_version": guard.model_version.map(AsrModelVersion::as_str),
                "vad_ready": streaming_vad_guard.ready && batch_vad_guard.ready,
                "diarization_ready": guard.diarization_ready,
                "is_apple_silicon": is_apple_silicon,
                "is_intel": is_intel,
                "is_supported": is_apple_silicon && !is_intel,
            }))
        }
    }
}

impl Drop for SttState {
    fn drop(&mut self) {
        if let Ok(guard) = self.session_wav_path.lock() {
            if let Some(path) = guard.as_ref() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

#[tauri::command]
pub async fn stt_init(
    state: State<'_, SttState>,
    app: AppHandle,
    model_version: Option<String>,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        emit_error(&app, not_supported());
        return Err(not_supported());
    }

    #[cfg(target_os = "macos")]
    {
        let model_version = AsrModelVersion::parse(model_version.as_deref().unwrap_or("v3"))?;
        let inner = state.inner.clone();
        tokio::task::spawn_blocking(move || SttState::init_asr_inner(inner, app, model_version))
            .await
            .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
pub async fn stt_transcribe_speech(
    samples: Vec<f32>,
    model_version: Option<String>,
    state: State<'_, SttState>,
) -> Result<serde_json::Value, String> {
    let model_version = model_version.unwrap_or_else(|| "v3".to_string());
    let inner = state.inner.clone();
    tokio::task::spawn_blocking(move || {
        SttState::transcribe_samples_inner(inner, &samples, model_version)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Transcribe an utterance the capture loop already holds, by id.
///
/// Preferred over `stt_transcribe_speech` for system-audio capture: the samples
/// never leave the Rust process, so this skips both the base64 WAV decode in
/// the frontend and the multi-megabyte JSON array on the way back.
#[tauri::command]
pub async fn stt_transcribe_utterance(
    utterance_id: String,
    state: State<'_, SttState>,
    store: State<'_, UtteranceStore>,
) -> Result<serde_json::Value, String> {
    let cached = store.take(&utterance_id).ok_or_else(|| {
        format!(
            "{} Utterance {} is no longer cached",
            UTTERANCE_CACHE_MISS_PREFIX, utterance_id
        )
    })?;
    let inner = state.inner.clone();
    tokio::task::spawn_blocking(move || SttState::transcribe_cached_inner(inner, cached))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stt_get_status(state: State<'_, SttState>) -> Result<serde_json::Value, String> {
    state.get_status()
}

/// Bring Silero VAD up unless it already is.
///
/// Idempotent — `init_vad_inner` returns early once a model is ready — so any
/// feature that needs VAD can call this instead of assuming some other code
/// path already initialized it.
#[cfg(target_os = "macos")]
pub async fn ensure_vad_ready(app: &AppHandle, threshold: f32) -> Result<(), String> {
    let (streaming_vad, batch_vad) = {
        let state = app.state::<SttState>();
        (state.streaming_vad.clone(), state.batch_vad.clone())
    };
    let app_for_task = app.clone();
    tokio::task::spawn_blocking(move || {
        SttState::init_vad_inner(streaming_vad, app_for_task.clone(), threshold)?;
        SttState::init_vad_inner(batch_vad, app_for_task, threshold)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stt_init_vad(
    state: State<'_, SttState>,
    app: AppHandle,
    threshold: f32,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    return Err(not_supported());

    #[cfg(target_os = "macos")]
    {
        let _ = state;
        ensure_vad_ready(&app, threshold).await
    }
}

#[tauri::command]
pub async fn stt_init_diarization(
    state: State<'_, SttState>,
    app: AppHandle,
    threshold: f64,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    return Err(not_supported());

    #[cfg(target_os = "macos")]
    {
        let inner = state.inner.clone();
        tokio::task::spawn_blocking(move || SttState::init_diarization_inner(inner, app, threshold))
            .await
            .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
pub async fn stt_diarize_file(
    state: State<'_, SttState>,
    path: String,
) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "macos"))]
    return Ok(serde_json::json!([]));

    #[cfg(target_os = "macos")]
    {
        let managed_path = state
            .take_session_wav_path()
            .map(|p| p.to_string_lossy().to_string());

        let path_for_diarization = managed_path
            .filter(|managed| managed == &path)
            .ok_or("Path is not the managed session audio file")?;
        let path_for_cleanup = path_for_diarization.clone();

        let inner = state.inner.clone();
        let segments_result = tokio::task::spawn_blocking(move || {
            let state = SttState {
                inner,
                streaming_vad: Arc::default(),
                batch_vad: Arc::default(),
                session_wav_path: Arc::default(),
            };
            state.diarize_file(&path_for_diarization)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result);
        let segments_result =
            cleanup_session_file_after(std::path::Path::new(&path_for_cleanup), segments_result);
        if segments_result.is_err() && std::path::Path::new(&path_for_cleanup).exists() {
            let _ = state.set_session_wav_path(std::path::PathBuf::from(&path_for_cleanup));
        }
        let segments = segments_result?;

        Ok(serde_json::json!(segments
            .iter()
            .map(|s| {
                serde_json::json!({
                    "speaker_id": s.speaker_id,
                    "start_time": s.start_time,
                    "end_time": s.end_time,
                })
            })
            .collect::<Vec<_>>()))
    }
}

#[tauri::command]
pub fn stt_discard_session_audio(state: State<'_, SttState>, path: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    return Ok(());

    #[cfg(target_os = "macos")]
    state.discard_session_wav_path(&path)
}
