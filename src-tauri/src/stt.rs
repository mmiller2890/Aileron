#[cfg(target_os = "macos")]
use fluidaudio_rs::FluidAudio;
use serde_json;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

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

struct CachedUtterance {
    id: String,
    samples: Vec<f32>,
    created_at: Instant,
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
    /// Cache an utterance and return the id the frontend can claim it with.
    pub fn put(&self, samples: Vec<f32>) -> Option<String> {
        self.put_at(samples, Instant::now())
    }

    fn put_at(&self, samples: Vec<f32>, now: Instant) -> Option<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let mut queue = self.inner.lock().ok()?;
        Self::prune_expired(&mut queue, now);
        while queue.len() >= MAX_CACHED_UTTERANCES {
            queue.pop_front();
        }
        queue.push_back(CachedUtterance {
            id: id.clone(),
            samples,
            created_at: now,
        });
        Some(id)
    }

    /// Claim an utterance, removing it from the cache.
    pub fn take(&self, id: &str) -> Option<Vec<f32>> {
        self.take_at(id, Instant::now())
    }

    fn take_at(&self, id: &str, now: Instant) -> Option<Vec<f32>> {
        let mut queue = self.inner.lock().ok()?;
        Self::prune_expired(&mut queue, now);
        let position = queue.iter().position(|entry| entry.id == id)?;
        queue.remove(position).map(|entry| entry.samples)
    }

    fn prune_expired(queue: &mut VecDeque<CachedUtterance>, now: Instant) {
        queue.retain(|entry| {
            now.saturating_duration_since(entry.created_at) <= CACHED_UTTERANCE_TTL
        });
    }
}

#[cfg(test)]
mod utterance_store_tests {
    use super::{
        cleanup_session_file_after, try_lock_stt_inner, SttInner, SttState, UtteranceStore,
        MAX_CACHED_UTTERANCES,
    };
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    #[test]
    fn evicts_the_oldest_entry_when_capacity_is_exceeded() {
        let store = UtteranceStore::default();
        let now = Instant::now();
        let ids: Vec<String> = (0..=MAX_CACHED_UTTERANCES)
            .map(|index| store.put_at(vec![index as f32], now).unwrap())
            .collect();

        assert!(store.take_at(&ids[0], now).is_none());
        assert_eq!(
            store.take_at(ids.last().unwrap(), now),
            Some(vec![MAX_CACHED_UTTERANCES as f32])
        );
    }

    #[test]
    fn expires_unclaimed_entries_after_the_ttl() {
        let store = UtteranceStore::default();
        let now = Instant::now();
        let id = store.put_at(vec![1.0], now).unwrap();

        assert!(store
            .take_at(&id, now + Duration::from_secs(61))
            .is_none());
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
    fn session_path_update_does_not_wait_for_asr_lock() {
        let state = Arc::new(SttState::default());
        let held = state.inner.lock().unwrap();
        let worker_state = state.clone();
        let (sent, received) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = worker_state.set_session_wav_path(
                std::path::PathBuf::from("/tmp/aileron-session-lock-test.wav"),
            );
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
    asr_ready: bool,
    vad_ready: bool,
    diarization_ready: bool,
}

impl Default for SttInner {
    fn default() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            audio: None,
            asr_ready: false,
            vad_ready: false,
            diarization_ready: false,
        }
    }
}

#[derive(Default)]
pub struct SttState {
    pub inner: Arc<Mutex<SttInner>>,
    session_wav_path: Arc<Mutex<Option<std::path::PathBuf>>>,
}

fn try_lock_stt_inner(inner: &Mutex<SttInner>) -> Result<MutexGuard<'_, SttInner>, String> {
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
    ) -> Result<(), String> {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        if guard.asr_ready {
            return Ok(());
        }

        let audio = FluidAudio::new().map_err(|e| e.to_string())?;
        if audio.is_intel_mac() {
            let msg = not_supported();
            emit_error(&app, msg.clone());
            return Err(msg);
        }

        audio.init_asr().map_err(|e| e.to_string())?;
        guard.asr_ready = true;
        guard.audio = Some(audio);
        let _ = app.emit("stt-ready", ());
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn init_vad_inner(
        inner: Arc<Mutex<SttInner>>,
        app: AppHandle,
        threshold: f32,
    ) -> Result<(), String> {
        let mut guard = inner.lock().map_err(|e| e.to_string())?;
        if guard.vad_ready {
            return Ok(());
        }
        let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
        if let Err(e) = audio.init_vad(threshold) {
            let msg = e.to_string();
            emit_error(&app, format!("Failed to initialize VAD: {}", msg));
            return Err(msg);
        }
        guard.vad_ready = true;
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
    pub fn vad_process_samples(&self, samples: &[f32]) -> Result<Vec<fluidaudio_rs::VadFrame>, String> {
        let guard = try_lock_stt_inner(&self.inner)?;
        if !guard.vad_ready {
            return Err("VAD not initialized".to_string());
        }
        let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
        audio.vad_process_samples(samples).map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn diarize_file(&self, path: &str) -> Result<Vec<fluidaudio_rs::DiarizationSegment>, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        if !guard.diarization_ready {
            return Err("Diarization not initialized".to_string());
        }
        let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
        audio.diarize_file(path).map_err(|e| e.to_string())
    }

    #[cfg(target_os = "macos")]
    pub fn set_session_wav_path(&self, path: std::path::PathBuf) -> Result<(), String> {
        let mut guard = self
            .session_wav_path
            .lock()
            .map_err(|e| e.to_string())?;
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
        let mut guard = self
            .session_wav_path
            .lock()
            .map_err(|e| e.to_string())?;
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

    fn transcribe_samples_inner(
        inner: Arc<Mutex<SttInner>>,
        samples: &[f32],
    ) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "macos"))]
        return Err(not_supported());

        #[cfg(target_os = "macos")]
        {
            let mut guard = inner.lock().map_err(|e| e.to_string())?;
            if guard.audio.is_none() || !guard.asr_ready {
                let audio = FluidAudio::new().map_err(|e| e.to_string())?;
                if audio.is_intel_mac() {
                    return Err(not_supported());
                }
                audio.init_asr().map_err(|e| e.to_string())?;
                guard.asr_ready = true;
                guard.audio = Some(audio);
            }
            let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
            let result = audio
                .transcribe_samples(samples)
                .map_err(|e| e.to_string())?;
            let text = audio
                .itn_normalize_sentence(&result.text)
                .unwrap_or(result.text.clone());
            Ok(serde_json::json!({
                "text": text,
                "confidence": result.confidence,
                "duration": result.duration,
                "processing_time": result.processing_time,
            }))
        }
    }

    pub fn get_status(&self) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "macos"))]
        {
            return Ok(serde_json::json!({
                "asr_ready": false,
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
                "vad_ready": guard.vad_ready,
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
pub async fn stt_init(state: State<'_, SttState>, app: AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        emit_error(&app, not_supported());
        return Err(not_supported());
    }

    #[cfg(target_os = "macos")]
    {
        let inner = state.inner.clone();
        tokio::task::spawn_blocking(move || SttState::init_asr_inner(inner, app))
            .await
            .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
pub async fn stt_transcribe_speech(
    samples: Vec<f32>,
    state: State<'_, SttState>,
) -> Result<serde_json::Value, String> {
    let inner = state.inner.clone();
    tokio::task::spawn_blocking(move || SttState::transcribe_samples_inner(inner, &samples))
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
    let samples = store.take(&utterance_id).ok_or_else(|| {
        format!(
            "{} Utterance {} is no longer cached",
            UTTERANCE_CACHE_MISS_PREFIX, utterance_id
        )
    })?;
    let inner = state.inner.clone();
    tokio::task::spawn_blocking(move || SttState::transcribe_samples_inner(inner, &samples))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn stt_get_status(state: State<'_, SttState>) -> Result<serde_json::Value, String> {
    state.get_status()
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
        let inner = state.inner.clone();
        tokio::task::spawn_blocking(move || SttState::init_vad_inner(inner, app, threshold))
            .await
            .map_err(|e| e.to_string())?
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
                session_wav_path: Arc::default(),
            };
            state.diarize_file(&path_for_diarization)
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result);
        let segments_result = cleanup_session_file_after(
            std::path::Path::new(&path_for_cleanup),
            segments_result,
        );
        if segments_result.is_err() && std::path::Path::new(&path_for_cleanup).exists() {
            let _ = state.set_session_wav_path(std::path::PathBuf::from(&path_for_cleanup));
        }
        let segments = segments_result?;

        Ok(serde_json::json!(segments.iter().map(|s| {
            serde_json::json!({
                "speaker_id": s.speaker_id,
                "start_time": s.start_time,
                "end_time": s.end_time,
            })
        }).collect::<Vec<_>>()))
    }
}

#[tauri::command]
pub fn stt_discard_session_audio(
    state: State<'_, SttState>,
    path: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    return Ok(());

    #[cfg(target_os = "macos")]
    state.discard_session_wav_path(&path)
}
