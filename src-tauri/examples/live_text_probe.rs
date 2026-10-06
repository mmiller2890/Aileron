//! Feeds a WAV through the streaming model in 320 ms steps and reports how
//! fast it runs. Usage: cargo run --release --example live_text_probe -- speech.wav

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use fluidaudio_rs::{resample_samples, FluidAudio};
    use std::time::Instant;

    let path = std::env::args()
        .nth(1)
        .ok_or("usage: live_text_probe <wav>")?;
    let mut reader = hound::WavReader::open(&path)?;
    let spec = reader.spec();
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()?
        }
    };
    let channels = spec.channels.max(1) as usize;
    let mono: Vec<f32> = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect();
    let samples = resample_samples(&mono, spec.sample_rate as f64)?;

    let audio = FluidAudio::new()?;
    let load_started = Instant::now();
    audio.init_streaming_asr_with_progress(|_| {})?;
    println!("model load: {:.1}s", load_started.elapsed().as_secs_f64());
    const STEP: usize = 5_120; // 320 ms at 16 kHz
    let audio_secs = samples.len() as f64 / 16_000.0;
    // Two passes: the first includes the model's one-off first-inference
    // warm-up, the second shows steady-state speed after a reset.
    for pass in ["cold", "warm"] {
        audio.streaming_asr_reset()?;
        let mut worst_ms = 0.0_f64;
        let mut first_ms = 0.0_f64;
        let mut text = String::new();
        let started = Instant::now();
        for (index, chunk) in samples.chunks(STEP).enumerate() {
            let feed_started = Instant::now();
            text = audio.streaming_asr_feed(chunk)?;
            let ms = feed_started.elapsed().as_secs_f64() * 1000.0;
            if index == 0 {
                first_ms = ms;
            } else {
                worst_ms = worst_ms.max(ms);
            }
        }
        let elapsed = started.elapsed().as_secs_f64();
        println!(
            "{pass}: audio {audio_secs:.1}s  processing {elapsed:.2}s  speed {:.1}x real time  first step {first_ms:.0} ms  worst later step {worst_ms:.0} ms",
            audio_secs / elapsed
        );
        println!("{pass} text: {text}");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("live_text_probe requires macOS");
}
