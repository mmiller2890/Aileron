//! Streaming resampler from the capture rate to 16 kHz, for the per-hop
//! path (Silero VAD and live text).
//!
//! The capture loop used to build a new converter in the native bridge for
//! every 21 ms hop. Each call crossed into Swift and allocated a fresh
//! highest-quality converter, and each started from silence, so the 16 kHz
//! stream had a seam every hop. This keeps its filter state across hops.
//! Whole utterances for the final transcript still use the native converter.

pub(crate) const TARGET_RATE: u32 = 16_000;

/// Zero crossings of the sinc on each side of an output sample.
const ZERO_CROSSINGS: f64 = 12.0;
/// Passband edge as a fraction of the 8 kHz output Nyquist frequency.
const CUTOFF: f64 = 0.92;
/// Fractional positions the filter is tabulated at; values in between are
/// interpolated linearly between neighbouring phases.
const PHASES: usize = 512;

pub(crate) struct StreamingResampler {
    input_rate: u32,
    /// Input samples from absolute index `history_start` on.
    history: Vec<f32>,
    history_start: u64,
    /// Output samples produced so far; the next is at input position
    /// `produced * input_rate / TARGET_RATE`.
    produced: u64,
    /// Filter half-width in input samples, and taps either side of center.
    half_width: f64,
    reach: usize,
    /// `table[phase * taps + k]` is the tap for input `floor(center) - reach
    /// + 1 + k` when `center` lies `phase / PHASES` past an input sample.
    table: Vec<f32>,
    taps: usize,
}

impl StreamingResampler {
    pub(crate) fn new(input_rate: u32) -> Self {
        let input_rate = input_rate.max(1);
        // Low-pass below the output Nyquist frequency, or the input's own
        // when upsampling.
        let nyquist = (TARGET_RATE.min(input_rate) as f64) / 2.0;
        let cutoff = CUTOFF * nyquist / input_rate as f64;
        let half_width = ZERO_CROSSINGS / (2.0 * cutoff);
        let reach = half_width.ceil() as usize;
        let taps = 2 * reach;
        let mut table = vec![0.0f32; (PHASES + 1) * taps];
        for phase in 0..=PHASES {
            let frac = phase as f64 / PHASES as f64;
            for k in 0..taps {
                // Input offset relative to floor(center).
                let offset = k as f64 + 1.0 - reach as f64;
                table[phase * taps + k] = tap(cutoff, half_width, frac - offset) as f32;
            }
        }
        Self {
            input_rate,
            history: Vec::new(),
            history_start: 0,
            produced: 0,
            half_width,
            reach,
            table,
            taps,
        }
    }

    /// Resample the next piece of the stream. Output trails input by the
    /// filter half-width (under 1 ms at 48 kHz) and keeps no drift.
    pub(crate) fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        if self.input_rate == TARGET_RATE {
            return samples.to_vec();
        }
        self.history.extend_from_slice(samples);
        let available_end = self.history_start + self.history.len() as u64;
        let step = self.input_rate as f64 / TARGET_RATE as f64;
        let mut out = Vec::with_capacity((samples.len() as f64 / step) as usize + 2);
        loop {
            let center = self.produced as f64 * step;
            let last_needed = center.floor() as u64 + self.reach as u64;
            if last_needed >= available_end {
                break;
            }
            out.push(self.sample_at(center));
            self.produced += 1;
        }
        self.discard_before(self.produced as f64 * step - self.half_width);
        out
    }

    fn sample_at(&self, center: f64) -> f32 {
        let base = center.floor();
        let position = (center - base) * PHASES as f64;
        let phase = position as usize;
        let blend = (position - phase as f64) as f32;
        let low = &self.table[phase * self.taps..(phase + 1) * self.taps];
        let high = &self.table[(phase + 1) * self.taps..(phase + 2) * self.taps];
        let first = base as i64 + 1 - self.reach as i64;
        let mut sum = 0.0f32;
        for k in 0..self.taps {
            let index = first + k as i64;
            if index < self.history_start as i64 {
                continue; // before the stream began: silence
            }
            let sample = self.history[(index as u64 - self.history_start) as usize];
            sum += sample * (low[k] + blend * (high[k] - low[k]));
        }
        sum
    }

    fn discard_before(&mut self, position: f64) {
        let position = position - 1.0; // keep floor(center) - reach + 1
        let keep_from = position.floor().max(0.0) as u64;
        if keep_from > self.history_start {
            let drop = ((keep_from - self.history_start) as usize).min(self.history.len());
            self.history.drain(..drop);
            self.history_start += drop as u64;
        }
    }
}

/// Windowed-sinc low-pass tap at `distance` input samples from center,
/// normalized to unity gain at DC; zero beyond the half-width.
fn tap(cutoff: f64, half_width: f64, distance: f64) -> f64 {
    if distance.abs() >= half_width {
        return 0.0;
    }
    let x = 2.0 * cutoff * distance;
    let sinc = if x.abs() < 1e-9 {
        1.0
    } else {
        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
    };
    // Blackman window over the half-width.
    let t = (distance / half_width + 1.0) / 2.0;
    let window = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * t).cos()
        + 0.08 * (4.0 * std::f64::consts::PI * t).cos();
    2.0 * cutoff * sinc * window
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, hz: f64, seconds: f64, amplitude: f64) -> Vec<f32> {
        (0..(rate as f64 * seconds) as usize)
            .map(|i| (amplitude * (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin()) as f32)
            .collect()
    }

    fn resample_in_chunks(rate: u32, input: &[f32], chunk: usize) -> Vec<f32> {
        let mut resampler = StreamingResampler::new(rate);
        input.chunks(chunk).flat_map(|piece| resampler.push(piece)).collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples.iter().map(|&s| (s as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt()
    }

    #[test]
    fn sixteen_kilohertz_input_passes_through_untouched() {
        let input = tone(16_000, 440.0, 0.25, 0.3);
        assert_eq!(resample_in_chunks(16_000, &input, 1024), input);
    }

    #[test]
    fn thirty_seconds_in_hops_comes_out_thirty_seconds_long() {
        let input = vec![0.0f32; 48_000 * 30];
        let output = resample_in_chunks(48_000, &input, 1024);
        let expected = 16_000 * 30;
        // Trails by at most the filter half-width; never drifts.
        assert!(output.len() <= expected && expected - output.len() < 20, "{}", output.len());
    }

    #[test]
    fn a_speech_band_tone_comes_through_unchanged() {
        let output = resample_in_chunks(48_000, &tone(48_000, 1_000.0, 1.0, 0.5), 1024);
        let expected = tone(16_000, 1_000.0, 1.0, 0.5);
        // Output sample n sits at input time n / 16 kHz: no delay to undo.
        let worst = (100..output.len() - 100)
            .map(|n| (output[n] - expected[n]).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 0.005, "worst error {worst}");
    }

    #[test]
    fn frequencies_above_eight_kilohertz_are_removed_not_aliased() {
        let output = resample_in_chunks(48_000, &tone(48_000, 12_000.0, 1.0, 0.5), 1024);
        assert!(rms(&output[100..]) < 0.005, "rms {}", rms(&output[100..]));
    }

    #[test]
    fn output_does_not_depend_on_how_the_input_was_chunked() {
        let input = tone(48_000, 440.0, 0.5, 0.3);
        let whole = resample_in_chunks(48_000, &input, input.len());
        let hops = resample_in_chunks(48_000, &input, 1024);
        let odd = resample_in_chunks(48_000, &input, 777);
        assert_eq!(whole, hops);
        assert_eq!(whole, odd);
    }

    #[test]
    fn non_integer_rates_keep_their_length_and_tone() {
        let output = resample_in_chunks(44_100, &tone(44_100, 1_000.0, 2.0, 0.5), 1024);
        assert!((32_000 - output.len()) < 20, "{}", output.len());
        let expected = tone(16_000, 1_000.0, 2.0, 0.5);
        let worst = (100..output.len() - 100)
            .map(|n| (output[n] - expected[n]).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 0.005, "worst error {worst}");
    }
}
