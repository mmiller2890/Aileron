//! Silero VAD where FluidAudio is not available (Linux, Windows).
//!
//! macOS gets Silero through FluidAudio. Elsewhere the capture loops used a
//! loudness threshold, which cannot tell speech from music or room noise.
//! `silero-vad-crs` is a C port of the same Silero model with its weights
//! embedded and no runtime dependencies. Measured against the official ONNX
//! model on 31 s of speech it matched every 512-sample step (largest
//! probability difference under 0.00005).

use super::resample::StreamingResampler;

pub(crate) struct PortableVad {
    input_rate: u32,
    resampler: StreamingResampler,
    model: silero_vad_crs::SileroVad,
}

// SAFETY: `SileroVad` is not `Send` only because it holds a raw pointer to
// its C model. The C port (silero-vad-crs 0.4.0, native/silero_vad.c) keeps
// no global or thread-local state: weights are read-only constants and each
// model allocates its own buffers. Moving a detector to another thread is
// therefore sound; it is never shared (no `Sync`), and each capture loop owns
// its own.
unsafe impl Send for PortableVad {}

impl PortableVad {
    /// A detector for audio at `input_rate`. Fails only if the model cannot
    /// be created; callers fall back to the loudness threshold.
    pub(crate) fn new(input_rate: u32) -> Result<Self, String> {
        Ok(Self {
            input_rate,
            resampler: StreamingResampler::new(input_rate),
            model: silero_vad_crs::SileroVad::new().map_err(|error| error.to_string())?,
        })
    }

    /// Feed one hop of capture audio. Returns the probability of the most
    /// recent 32 ms step it completed, or `None` if it completed none (keep
    /// the previous probability).
    pub(crate) fn process(&mut self, hop: &[f32]) -> Result<Option<f32>, String> {
        let samples_16k = self.resampler.push(hop);
        let probabilities = self
            .model
            .push(&samples_16k)
            .map_err(|error| error.to_string())?;
        Ok(probabilities.last().copied())
    }

    /// Forget all state, as after a skip in the audio.
    pub(crate) fn reset(&mut self) {
        self.model.reset();
        self.resampler = StreamingResampler::new(self.input_rate);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(vad: &mut PortableVad, audio: &[f32]) -> Vec<f32> {
        audio
            .chunks(1024)
            .filter_map(|hop| vad.process(hop).unwrap())
            .collect()
    }

    #[test]
    fn silence_scores_as_no_speech() {
        let mut vad = PortableVad::new(48_000).unwrap();
        let probabilities = run(&mut vad, &vec![0.0; 48_000]);
        assert!(probabilities.iter().all(|&p| p < 0.1), "{probabilities:?}");
    }

    #[test]
    fn a_second_of_capture_yields_a_probability_every_32_ms() {
        let mut vad = PortableVad::new(48_000).unwrap();
        let probabilities = run(&mut vad, &vec![0.0; 48_000]);
        // 16,000 samples at 16 kHz in 512-sample steps; the resampler holds
        // back a few samples, so the last step may not have completed yet.
        assert!((30..=31).contains(&probabilities.len()), "{}", probabilities.len());
    }

    #[test]
    fn a_reset_detector_scores_like_a_new_one() {
        let noise: Vec<f32> = (0..48_000u32)
            .map(|i| ((i.wrapping_mul(2_654_435_761) >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.2)
            .collect();
        let mut used = PortableVad::new(48_000).unwrap();
        run(&mut used, &noise);
        used.reset();
        let mut fresh = PortableVad::new(48_000).unwrap();
        assert_eq!(run(&mut used, &noise), run(&mut fresh, &noise));
    }
}
