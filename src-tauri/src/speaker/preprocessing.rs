#[derive(Debug, Clone, PartialEq)]
pub struct PreparedUtterance {
    pub raw: Vec<f32>,
    pub processed: Vec<f32>,
}

pub fn prepare_utterance(samples: &[f32], threshold: f32, include_raw: bool) -> PreparedUtterance {
    let raw = if include_raw {
        samples.to_vec()
    } else {
        Vec::new()
    };
    let processed = normalize_audio_level(&apply_noise_gate(samples, threshold), 0.1);
    PreparedUtterance { raw, processed }
}

pub fn apply_noise_gate(samples: &[f32], threshold: f32) -> Vec<f32> {
    const KNEE_RATIO: f32 = 3.0;

    samples
        .iter()
        .map(|&sample| {
            let absolute = sample.abs();
            if absolute < threshold {
                sample * (absolute / threshold).powf(1.0 / KNEE_RATIO)
            } else {
                sample
            }
        })
        .collect()
}

pub fn normalize_audio_level(samples: &[f32], target_rms: f32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }

    let sum_squares: f32 = samples.iter().map(|&sample| sample * sample).sum();
    let current_rms = (sum_squares / samples.len() as f32).sqrt();

    if current_rms < 0.001 {
        return samples.to_vec();
    }

    let gain = (target_rms / current_rms).min(10.0);
    samples
        .iter()
        .map(|&sample| {
            let amplified = sample * gain;
            if amplified.abs() > 1.0 {
                amplified.signum() * (1.0 - (-amplified.abs()).exp())
            } else {
                amplified
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_variant_is_unchanged() {
        let raw = vec![-0.2, 0.0, 0.3];
        assert_eq!(prepare_utterance(&raw, 0.0015, true).raw, raw);
    }

    #[test]
    fn disabled_comparison_does_not_copy_raw_samples() {
        let raw = vec![-0.2, 0.0, 0.3];
        let prepared = prepare_utterance(&raw, 0.0015, false);

        assert!(prepared.raw.is_empty());
        assert!(!prepared.processed.is_empty());
    }

    #[test]
    fn empty_input_produces_empty_variants() {
        let prepared = prepare_utterance(&[], 0.0015, true);
        assert!(prepared.raw.is_empty());
        assert!(prepared.processed.is_empty());
    }

    #[test]
    fn processed_variant_matches_one_gate_then_normalization() {
        let raw = vec![0.00075, 0.02, -0.04, 0.03];
        let once = apply_noise_gate(&raw, 0.0015);
        let expected = normalize_audio_level(&once, 0.1);
        assert_eq!(prepare_utterance(&raw, 0.0015, true).processed, expected);
    }

    #[test]
    fn processed_variant_applies_the_gate_once() {
        let raw = vec![0.00075, 0.02, -0.04, 0.03];
        let prepared = prepare_utterance(&raw, 0.0015, true);
        let once = apply_noise_gate(&raw, 0.0015);
        let twice = normalize_audio_level(&apply_noise_gate(&once, 0.0015), 0.1);
        assert_ne!(prepared.processed, twice);
    }

    #[test]
    fn quiet_onset_remains_available_in_the_raw_variant() {
        let raw = vec![0.0001, 0.0002, 0.02];
        let prepared = prepare_utterance(&raw, 0.0015, true);
        assert_eq!(&prepared.raw[..2], &raw[..2]);
        let gated = apply_noise_gate(&raw, 0.0015);
        assert!(gated[0].abs() < prepared.raw[0].abs());
    }
}
