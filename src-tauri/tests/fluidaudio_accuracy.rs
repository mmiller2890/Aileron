#![cfg(target_os = "macos")]

use assistant_lib::stt_diagnostics::word_error_rate;
use fluidaudio_rs::{AsrModelVersion, FluidAudio};
use std::path::PathBuf;

fn prerequisites(fixture: &str) -> (PathBuf, String) {
    let fixture_root = std::env::var_os("FLUIDAUDIO_ACCURACY_FIXTURES")
        .map(PathBuf::from)
        .expect("Set FLUIDAUDIO_ACCURACY_FIXTURES to the opt-in WAV fixture directory");
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
    let audio = fixture_root.join(format!("{fixture}.wav"));
    let transcript = fixture_root.join(format!("{fixture}.txt"));
    assert!(audio.is_file(), "Missing fixture {}", audio.display());
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

fn transcribe_fixture(name: &str) -> (String, String) {
    let (path, reference) = prerequisites(name);
    let audio = FluidAudio::new().expect("FluidAudio bridge must initialize");
    audio
        .init_asr_version(AsrModelVersion::V3)
        .expect("Preinstalled FluidAudio v3 model must load without download");
    let result = audio
        .transcribe_file(path)
        .expect("CoreML transcription must succeed");
    (reference, result.text)
}

#[test]
#[ignore = "requires opt-in fixture and preinstalled CoreML model directories"]
fn short_clear_speech() {
    let (reference, hypothesis) = transcribe_fixture("short-clear");
    assert!(word_error_rate(&reference, &hypothesis) <= 0.5);
}

#[test]
#[ignore = "requires opt-in fixture and preinstalled CoreML model directories"]
fn quiet_onset_speech() {
    let (reference, hypothesis) = transcribe_fixture("quiet-onset");
    assert!(word_error_rate(&reference, &hypothesis) <= 0.5);
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
    assert!(result.duration > 15.0);
    assert!(word_error_rate(&reference, &result.text) <= 0.5);
}
