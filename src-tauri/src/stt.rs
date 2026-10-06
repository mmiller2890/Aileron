#[cfg(target_os = "macos")]
use fluidaudio_rs::{AsrModelVersion, FluidAudio};
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


pub(crate) struct CachedUtterance {
    id: String,
    pub(crate) primary_samples: Vec<f32>,
    pub(crate) comparison_samples: Option<Vec<f32>>,
    pub(crate) source_sample_rate: u32,
    pub(crate) source_duration: f64,
    created_at: Instant,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct TranscriptionVariant {
    raw_text: String,
    normalized_text: String,
    confidence: f32,
    duration: f64,
    processing_time: f64,
    token_timings: Vec<fluidaudio_rs::TokenTiming>,
}

#[cfg(target_os = "macos")]
fn transcription_variant_json(variant: &TranscriptionVariant) -> serde_json::Value {
    serde_json::json!({
        "text": variant.normalized_text,
        "raw_text": variant.raw_text,
        "normalized_text": variant.normalized_text,
        "confidence": variant.confidence,
        "duration": variant.duration,
        "processing_time": variant.processing_time,
        "token_timings": variant.token_timings,
        "itn_applied": variant.normalized_text != variant.raw_text,
    })
}

#[cfg(target_os = "macos")]
struct LocalTranscriptionContext<'a> {
    model_version: &'a str,
    path: &'a str,
    preprocessing: &'a str,
    source_sample_rate: u32,
    source_duration: f64,
    converted_sample_count: usize,
    comparison_converted_sample_count: Option<usize>,
}

#[cfg(target_os = "macos")]
fn build_local_transcription_result(
    primary: TranscriptionVariant,
    comparison: Option<(Result<TranscriptionVariant, String>, f64)>,
    context: LocalTranscriptionContext<'_>,
) -> serde_json::Value {
    let LocalTranscriptionContext {
        model_version,
        path,
        preprocessing,
        source_sample_rate,
        source_duration,
        converted_sample_count,
        comparison_converted_sample_count,
    } = context;
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
        "token_timings": primary.token_timings,
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
    #[cfg(target_os = "macos")]
    use super::{
        build_local_transcription_result, resolve_transcription_model,
        LocalTranscriptionContext, TranscriptionVariant,
    };
    use super::{try_lock_stt_inner, SttInner, SttState, UtteranceStore, MAX_CACHED_UTTERANCES};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    #[cfg(target_os = "macos")]
    #[test]
    fn model_contract_accepts_only_v3() {
        assert_eq!(AsrModelVersion::parse("v3"), Ok(AsrModelVersion::V3));
        assert!(AsrModelVersion::parse("v2").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_unknown_asr_model_versions() {
        assert!(AsrModelVersion::parse("turbo").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sample_fallback_reuses_v3_when_no_version_is_requested() {
        assert_eq!(
            resolve_transcription_model(Some(AsrModelVersion::V3), None).unwrap(),
            AsrModelVersion::V3,
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn direct_sample_transcription_rejects_explicit_v2() {
        assert!(
            resolve_transcription_model(Some(AsrModelVersion::V3), Some("v2".to_string()),)
                .is_err()
        );
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

    #[cfg(target_os = "macos")]
    #[test]
    fn comparison_failure_keeps_the_primary_result() {
        let primary = TranscriptionVariant {
            raw_text: "one two".to_string(),
            normalized_text: "1 2".to_string(),
            confidence: 0.9,
            duration: 1.0,
            processing_time: 0.2,
            token_timings: Vec::new(),
        };

        let result = build_local_transcription_result(
            primary,
            Some((Err("comparison failed".to_string()), 0.05)),
            LocalTranscriptionContext {
                model_version: "v3",
                path: "utterance-cache",
                preprocessing: "processed",
                source_sample_rate: 48_000,
                source_duration: 1.25,
                converted_sample_count: 16_000,
                comparison_converted_sample_count: None,
            },
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

    #[cfg(target_os = "macos")]
    #[test]
    fn local_transcription_preserves_token_timings() {
        let primary = TranscriptionVariant {
            raw_text: "hello".to_string(),
            normalized_text: "hello".to_string(),
            confidence: 0.9,
            duration: 0.5,
            processing_time: 0.1,
            token_timings: vec![fluidaudio_rs::TokenTiming {
                token: "hello".to_string(),
                token_id: 42,
                start_time: 0.1,
                end_time: 0.4,
                confidence: 0.8,
            }],
        };

        let result = build_local_transcription_result(
            primary,
            None,
            LocalTranscriptionContext {
                model_version: "v3",
                path: "sample-ipc",
                preprocessing: "processed",
                source_sample_rate: 16_000,
                source_duration: 0.5,
                converted_sample_count: 8_000,
                comparison_converted_sample_count: None,
            },
        );

        assert_eq!(result["token_timings"][0]["token"], "hello");
        assert_eq!(result["token_timings"][0]["token_id"], 42);
        assert_eq!(result["token_timings"][0]["start_time"], 0.1);
        assert_eq!(result["token_timings"][0]["end_time"], 0.4);
        let confidence = result["token_timings"][0]["confidence"].as_f64().unwrap();
        assert!((confidence - 0.8).abs() < 0.000_001);
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

    #[test]
    fn live_speakers_lock_is_independent_of_asr_and_live_text() {
        let state = SttState::default();
        let _asr = state.inner.lock().unwrap();
        let _text = state.live_text.lock().unwrap();
        assert!(state.live_speakers.try_lock().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn live_speaker_model_is_absent_until_initialised() {
        let state = SttState::default();
        assert!(state.live_speaker_model().is_none());
    }

    #[test]
    fn status_reports_live_speakers_as_not_ready_by_default() {
        let state = SttState::default();
        let _asr = state.inner.lock().unwrap();
        let status = state.get_status().unwrap();
        assert_eq!(status["live_speakers_ready"], serde_json::json!(false));
    }

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
        // Holding the ASR lock makes the status fall back to its default
        // snapshot, so this does not have to create a native bridge.
        let _asr = state.inner.lock().unwrap();
        let status = state.get_status().unwrap();
        assert_eq!(status["live_text_ready"], serde_json::json!(false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn vad_lock_remains_available_while_asr_is_busy() {
        let state = SttState::default();
        let _asr = state.inner.lock().unwrap();

        assert!(state.streaming_vad.try_lock().is_ok());
        assert!(state.mic_vad.try_lock().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn streaming_vad_lock_remains_available_while_mic_vad_is_busy() {
        let state = SttState::default();
        let _mic = state.mic_vad.lock().unwrap();

        assert!(state.streaming_vad.try_lock().is_ok());
    }
}

#[derive(Default)]
pub struct SttInner {
    #[cfg(target_os = "macos")]
    audio: Option<FluidAudio>,
    #[cfg(target_os = "macos")]
    model_version: Option<AsrModelVersion>,
    asr_ready: bool,
}

#[derive(Default)]
struct VadInner {
    #[cfg(target_os = "macos")]
    audio: Option<FluidAudio>,
    ready: bool,
}

#[derive(Default)]
struct LiveTextInner {
    #[cfg(target_os = "macos")]
    audio: Option<FluidAudio>,
    ready: bool,
}

#[derive(Default)]
struct LiveSpeakersInner {
    #[cfg(target_os = "macos")]
    audio: Option<FluidAudio>,
    ready: bool,
}

#[derive(Default)]
pub struct SttState {
    pub inner: Arc<Mutex<SttInner>>,
    streaming_vad: Arc<Mutex<VadInner>>,
    mic_vad: Arc<Mutex<VadInner>>,
    live_text: Arc<Mutex<LiveTextInner>>,
    live_speakers: Arc<Mutex<LiveSpeakersInner>>,
    last_status: Mutex<Option<serde_json::Value>>,
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

#[cfg(target_os = "macos")]
fn resolve_transcription_model(
    loaded: Option<AsrModelVersion>,
    requested: Option<String>,
) -> Result<AsrModelVersion, String> {
    match requested {
        Some(version) => AsrModelVersion::parse(&version),
        None => Ok(loaded.unwrap_or(AsrModelVersion::V3)),
    }
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
        let progress_app = app.clone();
        guard
            .audio
            .as_ref()
            .ok_or("STT not initialized")?
            .init_asr_version_with_progress(model_version, move |progress| {
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
    fn init_live_text_inner(
        inner: Arc<Mutex<LiveTextInner>>,
        app: AppHandle,
    ) -> Result<(), String> {
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
        let audio = guard.audio.as_ref().ok_or("Live text not initialized")?;
        let progress_app = app.clone();
        audio
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
        // The model's first inference after loading stalls for about half a
        // second. Pay that here, during setup, not in the first spoken turn.
        audio
            .streaming_asr_feed(&[0.0; 16_000])
            .and_then(|_| audio.streaming_asr_reset())
            .map_err(|e| e.to_string())?;
        guard.ready = true;
        Ok(())
    }

    /// The streaming model for one capture session, if it is loaded.
    #[cfg(target_os = "macos")]
    pub(crate) fn live_text_model(
        &self,
    ) -> Option<Box<dyn crate::speaker::live_text::LiveTextModel>> {
        // try_lock: the first load holds this lock for the whole download,
        // and a capture start must not wait behind it. Busy means not ready.
        let ready = self
            .live_text
            .try_lock()
            .map(|guard| guard.ready)
            .unwrap_or(false);
        ready.then(|| {
            Box::new(FluidLiveTextModel {
                inner: self.live_text.clone(),
            }) as Box<dyn crate::speaker::live_text::LiveTextModel>
        })
    }

    #[cfg(target_os = "macos")]
    fn init_live_speakers_inner(
        inner: Arc<Mutex<LiveSpeakersInner>>,
        app: AppHandle,
    ) -> Result<(), String> {
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
        let audio = guard
            .audio
            .as_ref()
            .ok_or("Speaker labels not initialized")?;
        let progress_app = app.clone();
        audio
            .init_live_diarizer_with_progress(move |progress| {
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
        // The model's first inference after loading stalls for seconds. Pay
        // that here, during setup, not in the first spoken turn.
        audio
            .live_diarizer_feed(&[0.0; 16_000])
            .and_then(|_| audio.live_diarizer_reset())
            .map_err(|e| e.to_string())?;
        guard.ready = true;
        Ok(())
    }

    /// The live diarizer for one capture session, if it is loaded.
    #[cfg(target_os = "macos")]
    pub(crate) fn live_speaker_model(
        &self,
    ) -> Option<Box<dyn crate::speaker::live_speakers::LiveSpeakerModel>> {
        // try_lock, for the same reason as `live_text_model`.
        let ready = self
            .live_speakers
            .try_lock()
            .map(|guard| guard.ready)
            .unwrap_or(false);
        ready.then(|| {
            Box::new(FluidLiveSpeakerModel {
                inner: self.live_speakers.clone(),
            }) as Box<dyn crate::speaker::live_speakers::LiveSpeakerModel>
        })
    }

    #[cfg(target_os = "macos")]
    pub fn mic_vad_process_streaming_samples(&self, samples: &[f32]) -> Result<f32, String> {
        let guard = self.mic_vad.try_lock().map_err(|error| match error {
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
    pub fn is_mic_vad_ready(&self) -> bool {
        self.mic_vad
            .lock()
            .map(|guard| guard.ready && guard.audio.is_some())
            .unwrap_or(false)
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
    pub fn reset_mic_vad_stream(&self) -> Result<(), String> {
        let guard = self.mic_vad.lock().map_err(|e| e.to_string())?;
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
            token_timings: result.token_timings,
        })
    }

    fn transcribe_samples_inner(
        inner: Arc<Mutex<SttInner>>,
        samples: &[f32],
        requested_model: Option<String>,
    ) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "macos"))]
        return Err(not_supported());

        #[cfg(target_os = "macos")]
        {
            let mut guard = inner.lock().map_err(|e| e.to_string())?;
            let model_version = resolve_transcription_model(guard.model_version, requested_model)?;
            Self::ensure_asr(&mut guard, model_version)?;
            let audio = guard.audio.as_ref().ok_or("STT not initialized")?;
            let primary = Self::transcribe_variant(audio, samples)?;
            Ok(build_local_transcription_result(
                primary,
                None,
                LocalTranscriptionContext {
                    model_version: guard.model_version.unwrap_or(AsrModelVersion::V3).as_str(),
                    path: "sample-ipc",
                    preprocessing: "processed",
                    source_sample_rate: 16_000,
                    source_duration: samples.len() as f64 / 16_000.0,
                    converted_sample_count: samples.len(),
                    comparison_converted_sample_count: None,
                },
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
                LocalTranscriptionContext {
                    model_version: guard.model_version.unwrap_or(AsrModelVersion::V3).as_str(),
                    path: "utterance-cache",
                    preprocessing: "processed",
                    source_sample_rate: cached.source_sample_rate,
                    source_duration: cached.source_duration,
                    converted_sample_count: cached.primary_samples.len(),
                    comparison_converted_sample_count,
                },
            ))
        }
    }

    fn cached_status(&self) -> Result<serde_json::Value, String> {
        if let Ok(guard) = self.last_status.lock() {
            if let Some(snapshot) = guard.as_ref() {
                return Ok(snapshot.clone());
            }
        }
        #[cfg(target_arch = "aarch64")]
        let (is_apple_silicon, is_intel) = (true, false);
        #[cfg(not(target_arch = "aarch64"))]
        let (is_apple_silicon, is_intel) = (false, true);
        Ok(serde_json::json!({
            "asr_ready": false,
            "model_version": serde_json::Value::Null,
            "vad_ready": false,
            "live_text_ready": false,
            "live_speakers_ready": false,
            "is_apple_silicon": is_apple_silicon,
            "is_intel": is_intel,
            "is_supported": is_apple_silicon && !is_intel,
        }))
    }

    pub fn get_status(&self) -> Result<serde_json::Value, String> {
        #[cfg(not(target_os = "macos"))]
        {
            return Ok(serde_json::json!({
                "asr_ready": false,
                "model_version": serde_json::Value::Null,
                "vad_ready": false,
                "live_text_ready": false,
                "live_speakers_ready": false,
                "is_apple_silicon": false,
                "is_intel": false,
                "is_supported": false,
            }));
        }

        #[cfg(target_os = "macos")]
        {
            // init_asr_inner holds `inner` across the whole ASR model download
            // and transcriptions hold it for their duration, so a blocking
            // lock here can pin a tokio worker for minutes. Status polls are
            // advisory: serve the last snapshot instead of waiting.
            let guard = match self.inner.try_lock() {
                Ok(guard) => guard,
                Err(_) => return self.cached_status(),
            };
            let streaming_vad_guard = match self.streaming_vad.try_lock() {
                Ok(guard) => guard,
                Err(_) => return self.cached_status(),
            };
            let mic_vad_guard = match self.mic_vad.try_lock() {
                Ok(guard) => guard,
                Err(_) => return self.cached_status(),
            };
            // The live-text worker holds this lock only for single feeds, but
            // the first model load holds it for the whole download.
            let live_text_guard = match self.live_text.try_lock() {
                Ok(guard) => guard,
                Err(_) => return self.cached_status(),
            };
            let live_speakers_guard = match self.live_speakers.try_lock() {
                Ok(guard) => guard,
                Err(_) => return self.cached_status(),
            };

            let (is_apple_silicon, is_intel) = if let Some(audio) = guard.audio.as_ref() {
                (audio.is_apple_silicon(), audio.is_intel_mac())
            } else {
                match FluidAudio::new() {
                    Ok(audio) => (audio.is_apple_silicon(), audio.is_intel_mac()),
                    Err(_) => (false, false),
                }
            };

            let status = serde_json::json!({
                "asr_ready": guard.asr_ready,
                "model_version": guard.model_version.map(AsrModelVersion::as_str),
                "vad_ready": streaming_vad_guard.ready && mic_vad_guard.ready,
                "live_text_ready": live_text_guard.ready,
                "live_speakers_ready": live_speakers_guard.ready,
                "is_apple_silicon": is_apple_silicon,
                "is_intel": is_intel,
                "is_supported": is_apple_silicon && !is_intel,
            });
            if let Ok(mut snapshot) = self.last_status.lock() {
                *snapshot = Some(status.clone());
            }
            Ok(status)
        }
    }
}

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

/// Adapter that lets the speaker-label worker drive the live diarizer.
#[cfg(target_os = "macos")]
struct FluidLiveSpeakerModel {
    inner: Arc<Mutex<LiveSpeakersInner>>,
}

#[cfg(target_os = "macos")]
impl FluidLiveSpeakerModel {
    fn with_audio<T>(
        &self,
        call: impl FnOnce(&FluidAudio) -> Result<T, fluidaudio_rs::FluidAudioError>,
    ) -> Result<T, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        let audio = guard
            .audio
            .as_ref()
            .ok_or("Speaker labels not initialized")?;
        call(audio).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
impl crate::speaker::live_speakers::LiveSpeakerModel for FluidLiveSpeakerModel {
    fn reset(&mut self) -> Result<(), String> {
        self.with_audio(|audio| audio.live_diarizer_reset())
    }

    fn feed(
        &mut self,
        samples_16k: &[f32],
    ) -> Result<crate::speaker::live_speakers::SlotCounts, String> {
        self.with_audio(|audio| audio.live_diarizer_feed(samples_16k))
    }

    fn end_turn(&mut self) -> Result<crate::speaker::live_speakers::SlotCounts, String> {
        self.with_audio(|audio| audio.live_diarizer_end_turn())
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
    // Bound the payload the webview can hand us: 10 minutes at 16 kHz.
    const MAX_TRANSCRIBE_SAMPLES: usize = 16_000 * 60 * 10;
    if samples.len() > MAX_TRANSCRIBE_SAMPLES {
        return Err(format!(
            "Speech sample count {} exceeds the {} sample limit",
            samples.len(),
            MAX_TRANSCRIBE_SAMPLES
        ));
    }

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
    let (streaming_vad, mic_vad) = {
        let state = app.state::<SttState>();
        (state.streaming_vad.clone(), state.mic_vad.clone())
    };
    let app_for_task = app.clone();
    tokio::task::spawn_blocking(move || {
        SttState::init_vad_inner(streaming_vad, app_for_task.clone(), threshold)?;
        SttState::init_vad_inner(mic_vad, app_for_task, threshold)
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

#[tauri::command]
pub async fn stt_init_live_speakers(
    state: State<'_, SttState>,
    app: AppHandle,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, app);
        return Err(not_supported());
    }

    #[cfg(target_os = "macos")]
    {
        let inner = state.live_speakers.clone();
        tokio::task::spawn_blocking(move || SttState::init_live_speakers_inner(inner, app))
            .await
            .map_err(|e| e.to_string())?
    }
}
