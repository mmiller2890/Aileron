//! # fluidaudio-rs
//!
//! Rust bindings for [FluidAudio](https://github.com/FluidInference/FluidAudio) -
//! a Swift library for ASR, VAD, and Speaker Diarization on Apple platforms.
//!
//! ## Features
//!
//! - **ASR (Automatic Speech Recognition)** - High-quality speech-to-text using Parakeet TDT v3
//! - **VAD (Voice Activity Detection)** - Detect speech segments in audio
//! - **Speaker Diarization** - Identify and label different speakers in audio
//!
//! ## Requirements
//!
//! - macOS 14+
//! - Apple Silicon
//!
//! ## Example
//!
//! ```rust,no_run
//! use fluidaudio_rs::FluidAudio;
//!
//! fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let audio = FluidAudio::new()?;
//!
//!     // Transcribe an audio file
//!     audio.init_asr()?;
//!     let result = audio.transcribe_file("audio.wav")?;
//!     println!("Text: {}", result.text);
//!     println!("Confidence: {:.2}%", result.confidence * 100.0);
//!
//!     Ok(())
//! }
//! ```

mod ffi;

use std::path::Path;
use thiserror::Error;

// Re-export FFI types
pub use ffi::{AsrResult, DiarizationSegment, ModelProgress, SystemInfo, TokenTiming, VadFrame};

pub fn resample_samples(samples: &[f32], input_rate: f64) -> Result<Vec<f32>, FluidAudioError> {
    ffi::resample_samples(samples, input_rate).map_err(FluidAudioError::from)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsrModelVersion {
    V3,
}

impl AsrModelVersion {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "v3" => Ok(Self::V3),
            _ => Err(format!("Unsupported ASR model version: {value}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::V3 => "v3",
        }
    }

    fn code(self) -> i32 {
        match self {
            Self::V3 => 3,
        }
    }
}

/// Errors that can occur when using FluidAudio
#[derive(Error, Debug)]
pub enum FluidAudioError {
    #[error("FluidAudio not initialized: {0}")]
    NotInitialized(String),

    #[error("Transcription failed: {0}")]
    TranscriptionFailed(String),

    #[error("Processing failed: {0}")]
    ProcessingFailed(String),

    #[error("Audio file not found: {0}")]
    FileNotFound(String),

    #[error("Swift bridge error: {0}")]
    BridgeError(String),
}

impl From<String> for FluidAudioError {
    fn from(s: String) -> Self {
        FluidAudioError::BridgeError(s)
    }
}

/// Main FluidAudio interface for Rust
///
/// Provides access to ASR and VAD functionality.
pub struct FluidAudio {
    bridge: ffi::FluidAudioBridge,
}

impl FluidAudio {
    /// Create a new FluidAudio instance
    pub fn new() -> Result<Self, FluidAudioError> {
        let bridge = ffi::FluidAudioBridge::new()
            .ok_or_else(|| FluidAudioError::BridgeError("Failed to create bridge".to_string()))?;
        Ok(Self { bridge })
    }

    // ========== ASR Methods ==========

    /// Initialize the ASR (Automatic Speech Recognition) engine
    ///
    /// This downloads and loads the ASR models. First run may take 20-30 seconds
    /// as models are compiled for the Neural Engine.
    pub fn init_asr(&self) -> Result<(), FluidAudioError> {
        self.init_asr_version(AsrModelVersion::V3)
    }

    pub fn init_asr_version(&self, version: AsrModelVersion) -> Result<(), FluidAudioError> {
        self.bridge
            .initialize_asr_version(version.code())
            .map_err(FluidAudioError::from)
    }

    pub fn init_asr_version_with_progress<F>(
        &self,
        version: AsrModelVersion,
        progress_callback: F,
    ) -> Result<(), FluidAudioError>
    where
        F: Fn(ModelProgress) + Send + Sync,
    {
        self.bridge
            .initialize_asr_version_with_progress(version.code(), progress_callback)
            .map_err(FluidAudioError::from)
    }

    /// Transcribe an audio file
    ///
    /// # Arguments
    /// * `path` - Path to the audio file (WAV, M4A, MP3, etc.)
    ///
    /// # Returns
    /// * `AsrResult` containing the transcribed text and metadata
    pub fn transcribe_file<P: AsRef<Path>>(&self, path: P) -> Result<AsrResult, FluidAudioError> {
        let path_str = path.as_ref().to_string_lossy();

        if !path.as_ref().exists() {
            return Err(FluidAudioError::FileNotFound(path_str.to_string()));
        }

        self.bridge
            .transcribe_file(&path_str)
            .map_err(FluidAudioError::from)
    }

    /// Transcribe audio samples directly
    ///
    /// This method accepts a complete utterance as raw 16kHz mono audio samples.
    ///
    /// # Arguments
    /// * `samples` - Slice of f32 audio samples (16kHz mono, normalized to -1.0 to 1.0)
    ///
    /// # Returns
    /// * `AsrResult` containing the transcribed text and metadata
    ///
    /// # Example
    /// ```rust,no_run
    /// use fluidaudio_rs::FluidAudio;
    ///
    /// fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let audio = FluidAudio::new()?;
    ///     audio.init_asr()?;
    ///
    ///     // Simulated audio buffer (16kHz mono)
    ///     let samples: Vec<f32> = vec![0.0; 16000]; // 1 second of silence
    ///
    ///     let result = audio.transcribe_samples(&samples)?;
    ///     println!("Text: {}", result.text);
    ///
    ///     Ok(())
    /// }
    /// ```
    pub fn transcribe_samples(&self, samples: &[f32]) -> Result<AsrResult, FluidAudioError> {
        self.bridge
            .transcribe_samples(samples)
            .map_err(FluidAudioError::from)
    }

    /// Check if ASR is initialized and ready
    pub fn is_asr_available(&self) -> bool {
        self.bridge.is_asr_available()
    }

    // ========== VAD Methods ==========

    /// Initialize the VAD (Voice Activity Detection) engine
    ///
    /// # Arguments
    /// * `threshold` - Detection threshold (0.0-1.0; Assistant uses 0.5)
    pub fn init_vad(&self, threshold: f32) -> Result<(), FluidAudioError> {
        self.bridge
            .initialize_vad(threshold)
            .map_err(FluidAudioError::from)
    }

    /// Check if VAD is initialized and ready
    pub fn is_vad_available(&self) -> bool {
        self.bridge.is_vad_available()
    }

    /// Run VAD over an audio file.
    ///
    /// The audio is automatically resampled to 16 kHz mono Float32 and processed
    /// in 4096-sample (256 ms) chunks. One [`VadFrame`] is returned per chunk.
    ///
    /// # Arguments
    /// * `path` - Path to an audio file (WAV, M4A, MP3, etc.)
    ///
    /// # Example
    /// ```rust,no_run
    /// use fluidaudio_rs::FluidAudio;
    ///
    /// fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let audio = FluidAudio::new()?;
    ///     audio.init_vad(0.5)?;
    ///     let frames = audio.vad_process_file("speech.wav")?;
    ///     let voiced = frames.iter().filter(|f| f.is_voice_active).count();
    ///     println!("{} / {} chunks classified as voice", voiced, frames.len());
    ///     Ok(())
    /// }
    /// ```
    pub fn vad_process_file<P: AsRef<Path>>(
        &self,
        path: P,
    ) -> Result<Vec<VadFrame>, FluidAudioError> {
        let path_str = path.as_ref().to_string_lossy();

        if !path.as_ref().exists() {
            return Err(FluidAudioError::FileNotFound(path_str.to_string()));
        }

        self.bridge
            .vad_process_file(&path_str)
            .map_err(FluidAudioError::from)
    }

    /// Run VAD over raw 16 kHz mono Float32 samples.
    ///
    /// One [`VadFrame`] is returned for every 4096-sample (256 ms) chunk; the
    /// trailing partial chunk (if any) is padded internally.
    pub fn vad_process_samples(&self, samples: &[f32]) -> Result<Vec<VadFrame>, FluidAudioError> {
        self.bridge
            .vad_process_samples(samples)
            .map_err(FluidAudioError::from)
    }

    pub fn vad_reset_stream(&self) -> Result<(), FluidAudioError> {
        self.bridge
            .vad_reset_stream()
            .map_err(FluidAudioError::from)
    }

    pub fn vad_process_streaming_samples(&self, samples: &[f32]) -> Result<f32, FluidAudioError> {
        self.bridge
            .vad_process_streaming_samples(samples)
            .map_err(FluidAudioError::from)
    }

    // ========== Diarization Methods ==========

    /// Initialize the speaker diarization engine
    ///
    /// This downloads and loads the diarization models. First run may take
    /// some time as models are compiled for the Neural Engine.
    ///
    /// # Arguments
    /// * `threshold` - Clustering distance threshold ((0.0, 2.0], default 0.6). Lower values
    ///   produce more speakers, higher values merge speakers more aggressively.
    pub fn init_diarization(&self, threshold: f64) -> Result<(), FluidAudioError> {
        self.bridge
            .initialize_diarization(threshold)
            .map_err(FluidAudioError::from)
    }

    /// Diarize an audio file to identify speaker segments
    ///
    /// # Arguments
    /// * `path` - Path to the audio file (WAV, M4A, MP3, etc.)
    ///
    /// # Returns
    /// * `Vec<DiarizationSegment>` containing speaker-labeled time segments
    pub fn diarize_file<P: AsRef<Path>>(
        &self,
        path: P,
    ) -> Result<Vec<DiarizationSegment>, FluidAudioError> {
        let path_str = path.as_ref().to_string_lossy();

        if !path.as_ref().exists() {
            return Err(FluidAudioError::FileNotFound(path_str.to_string()));
        }

        self.bridge
            .diarize_file(&path_str)
            .map_err(FluidAudioError::from)
    }

    /// Check if diarization is initialized and ready
    pub fn is_diarization_available(&self) -> bool {
        self.bridge.is_diarization_available()
    }

    // ========== System Info ==========

    /// Get system information
    pub fn system_info(&self) -> SystemInfo {
        self.bridge.system_info()
    }

    /// Check if running on Apple Silicon
    pub fn is_apple_silicon(&self) -> bool {
        self.bridge.is_apple_silicon()
    }

    /// Check if running on an Intel Mac (x86_64).
    ///
    /// Local Apple-Silicon-only Parakeet models will fail
    /// to load on Intel Macs. Apps can use this to gate UI selection of those
    /// models and steer Intel users to cloud transcription instead.
    pub fn is_intel_mac(&self) -> bool {
        self.bridge.is_intel_mac()
    }

    // ========== ITN (Inverse Text Normalization) ==========

    /// Normalize a short spoken-form expression to written form.
    ///
    /// Examples:
    /// - `"two hundred thirty two"` → `"232"`
    /// - `"five dollars and fifty cents"` → `"$5.50"`
    /// - `"period"` → `"."`
    ///
    /// Intended for short fragments. For full sentences with mixed punctuation
    /// commands and ordinary prose, prefer [`itn_normalize_sentence`](Self::itn_normalize_sentence).
    pub fn itn_normalize(&self, text: &str) -> Result<String, FluidAudioError> {
        self.bridge
            .itn_normalize(text)
            .map_err(FluidAudioError::from)
    }

    /// Sentence-mode normalization with sliding-window span matching.
    ///
    /// Uses Apple's NaturalLanguage framework to disambiguate words like
    /// `"period"` between punctuation commands and ordinary nouns/verbs.
    pub fn itn_normalize_sentence(&self, text: &str) -> Result<String, FluidAudioError> {
        self.bridge
            .itn_normalize_sentence(text)
            .map_err(FluidAudioError::from)
    }

    /// Sentence-mode normalization with a caller-controlled maximum span size
    /// (in tokens). Larger spans catch longer multi-word numbers/dates at the
    /// cost of more work per sentence.
    pub fn itn_normalize_sentence_max_span(
        &self,
        text: &str,
        max_span_tokens: u32,
    ) -> Result<String, FluidAudioError> {
        self.bridge
            .itn_normalize_sentence_max_span(text, max_span_tokens)
            .map_err(FluidAudioError::from)
    }

    /// Whether the underlying native NeMo ITN library is loaded.
    ///
    /// When `false`, the Swift-side normalizer falls back to its
    /// Apple-NaturalLanguage-only path (still functional, but with reduced
    /// coverage on long multi-token expressions).
    pub fn itn_is_native_available(&self) -> bool {
        self.bridge.itn_is_native_available()
    }

    // ========== Cleanup ==========

    /// Release all resources
    pub fn cleanup(&self) {
        self.bridge.cleanup()
    }
}

impl Drop for FluidAudio {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_native_bridge_and_reads_system_info() {
        let audio = FluidAudio::new().expect("Swift bridge must initialize");
        let info = audio.system_info();

        assert_eq!(info.platform, "macOS");
        assert!(!info.chip_name.trim().is_empty());
        assert!(info.memory_gb.is_finite() && info.memory_gb > 0.0);
        assert_eq!(info.is_apple_silicon, audio.is_apple_silicon());
        assert_ne!(audio.is_apple_silicon(), audio.is_intel_mac());
    }
}
