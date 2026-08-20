#![cfg(target_os = "macos")]

use assistant_lib::stt_diagnostics::word_error_rate;
use fluidaudio_rs::{resample_samples, AsrModelVersion, AsrResult, FluidAudio};
use std::collections::HashSet;
use std::path::PathBuf;

fn fixture_root() -> PathBuf {
    std::env::var_os("FLUIDAUDIO_ACCURACY_FIXTURES")
        .map(PathBuf::from)
        .expect("Set FLUIDAUDIO_ACCURACY_FIXTURES to the opt-in WAV fixture directory")
}

fn fixture_wav(fixture: &str) -> PathBuf {
    let audio = fixture_root().join(format!("{fixture}.wav"));
    assert!(audio.is_file(), "Missing fixture {}", audio.display());
    audio
}

fn prerequisites(fixture: &str) -> (PathBuf, String) {
    let model_cache = PathBuf::from(std::env::var_os("HOME").expect("HOME must be set"))
        .join("Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3");
    for required in [
        "Preprocessor.mlmodelc",
        "Encoder.mlmodelc",
        "Decoder.mlmodelc",
        "JointDecisionv3.mlmodelc",
        "parakeet_vocab.json",
    ] {
        assert!(
            model_cache.join(required).exists(),
            "Preinstall the FluidAudio v3 model cache; missing {}",
            model_cache.join(required).display()
        );
    }
    let audio = fixture_wav(fixture);
    let transcript = fixture_root().join(format!("{fixture}.txt"));
    assert!(
        transcript.is_file(),
        "Missing ground truth {}",
        transcript.display()
    );
    (
        audio,
        std::fs::read_to_string(transcript)
            .expect("Ground-truth transcript must be readable")
            .trim()
            .to_string(),
    )
}

fn read_mono_wav(path: &std::path::Path) -> (Vec<f32>, u32) {
    let mut reader = hound::WavReader::open(path).expect("Fixture must be a readable WAV file");
    let spec = reader.spec();
    let interleaved = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .expect("Float WAV samples must be readable"),
        hound::SampleFormat::Int => {
            let scale = ((1_i64 << spec.bits_per_sample.saturating_sub(1)) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()
                .expect("PCM WAV samples must be readable")
        }
    };
    let channels = spec.channels.max(1) as usize;
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    (mono, spec.sample_rate)
}

fn assert_asr_metadata(result: &AsrResult) {
    assert!(result.confidence.is_finite());
    assert!(result.duration.is_finite() && result.duration > 0.0);
    assert!(result.processing_time.is_finite() && result.processing_time >= 0.0);
    assert!(result.rtfx.is_finite() && result.rtfx >= 0.0);
    if !result.text.trim().is_empty() {
        assert!(!result.token_timings.is_empty());
    }
    for timing in &result.token_timings {
        assert!(timing.start_time.is_finite() && timing.start_time >= 0.0);
        assert!(timing.end_time.is_finite() && timing.end_time >= timing.start_time);
        assert!(timing.confidence.is_finite());
    }
}

fn transcribe_fixture(name: &str) -> (String, AsrResult) {
    let (path, reference) = prerequisites(name);
    let audio = FluidAudio::new().expect("FluidAudio bridge must initialize");
    audio
        .init_asr_version(AsrModelVersion::V3)
        .expect("Preinstalled FluidAudio v3 model must load without download");
    let result = audio
        .transcribe_file(path)
        .expect("CoreML transcription must succeed");
    assert_asr_metadata(&result);
    (reference, result)
}

#[test]
#[ignore = "requires opt-in fixture and preinstalled CoreML model directories"]
fn short_clear_speech() {
    let (reference, result) = transcribe_fixture("short-clear");
    assert!(word_error_rate(&reference, &result.text) <= 0.5);
}

#[test]
#[ignore = "requires opt-in fixture and preinstalled CoreML model directories"]
fn quiet_onset_speech() {
    let (reference, result) = transcribe_fixture("quiet-onset");
    assert!(word_error_rate(&reference, &result.text) <= 0.5);
}

#[test]
#[ignore = "requires opt-in fixture and preinstalled CoreML model directories"]
fn consecutive_utterances() {
    let (first_path, first_reference) = prerequisites("consecutive-1");
    let (second_path, second_reference) = prerequisites("consecutive-2");
    let audio = FluidAudio::new().expect("FluidAudio bridge must initialize");
    audio
        .init_asr_version(AsrModelVersion::V3)
        .expect("Preinstalled FluidAudio v3 model must load without download");

    let first = audio
        .transcribe_file(first_path)
        .expect("First CoreML transcription must succeed");
    let second = audio
        .transcribe_file(second_path)
        .expect("Second CoreML transcription must succeed");

    assert_asr_metadata(&first);
    assert_asr_metadata(&second);
    assert!(word_error_rate(&first_reference, &first.text) <= 0.5);
    assert!(word_error_rate(&second_reference, &second.text) <= 0.5);
    assert_ne!(first.text, second.text);
}

#[test]
#[ignore = "requires opt-in fixture and preinstalled CoreML model directories"]
fn speech_longer_than_fifteen_seconds() {
    let (path, reference) = prerequisites("long-15s");
    let reader = hound::WavReader::open(&path).expect("Long fixture must be a WAV file");
    let duration = reader.duration() as f64 / reader.spec().sample_rate as f64;
    assert!(duration > 15.0, "Long fixture must exceed 15 seconds");
    let audio = FluidAudio::new().expect("FluidAudio bridge must initialize");
    audio
        .init_asr_version(AsrModelVersion::V3)
        .expect("Preinstalled FluidAudio v3 model must load without download");
    let result = audio
        .transcribe_file(path)
        .expect("Long-form CoreML transcription must succeed");
    assert_asr_metadata(&result);
    assert!(result.duration > 15.0);
    assert!(word_error_rate(&reference, &result.text) <= 0.5);
}

#[test]
#[ignore = "requires opt-in fixture and preinstalled CoreML model directories"]
fn streaming_vad_detects_speech_and_reset_is_deterministic() {
    let (path, _) = prerequisites("short-clear");
    let (samples, sample_rate) = read_mono_wav(&path);
    let samples = resample_samples(&samples, sample_rate as f64)
        .expect("Fixture audio must resample to 16 kHz");
    let frames: Vec<&[f32]> = samples.chunks_exact(4096).collect();
    assert!(
        !frames.is_empty(),
        "VAD fixture must contain a complete frame"
    );

    let audio = FluidAudio::new().expect("FluidAudio bridge must initialize");
    audio
        .init_vad(0.5)
        .expect("Preinstalled FluidAudio VAD model must load");
    let probabilities: Vec<f32> = frames
        .iter()
        .map(|frame| {
            audio
                .vad_process_streaming_samples(frame)
                .expect("Streaming VAD inference must succeed")
        })
        .collect();
    assert!(probabilities
        .iter()
        .all(|probability| probability.is_finite() && (0.0..=1.0).contains(probability)));
    assert!(probabilities.iter().any(|probability| *probability >= 0.5));

    audio.vad_reset_stream().expect("VAD reset must succeed");
    let first_after_reset = audio
        .vad_process_streaming_samples(frames[0])
        .expect("VAD inference after reset must succeed");
    audio
        .vad_reset_stream()
        .expect("Second VAD reset must succeed");
    let repeated_after_reset = audio
        .vad_process_streaming_samples(frames[0])
        .expect("Repeated VAD inference after reset must succeed");
    assert!((first_after_reset - repeated_after_reset).abs() <= 1e-6);
}

#[test]
#[ignore = "requires opt-in two-speaker fixture and preinstalled CoreML model directories"]
fn two_speaker_diarization_returns_sane_quality_segments() {
    let path = fixture_wav("two-speaker");
    let audio = FluidAudio::new().expect("FluidAudio bridge must initialize");
    audio
        .init_diarization(0.6)
        .expect("Preinstalled FluidAudio diarization models must load");
    let segments = audio
        .diarize_file(path)
        .expect("Offline diarization must succeed");

    assert!(!segments.is_empty());
    assert!(segments.iter().all(|segment| {
        !segment.speaker_id.is_empty()
            && segment.start_time.is_finite()
            && segment.start_time >= 0.0
            && segment.end_time.is_finite()
            && segment.end_time > segment.start_time
            && segment.quality_score.is_finite()
            && (0.0..=1.0).contains(&segment.quality_score)
    }));
    let speakers: HashSet<&str> = segments
        .iter()
        .map(|segment| segment.speaker_id.as_str())
        .collect();
    assert!(speakers.len() >= 2);
}
