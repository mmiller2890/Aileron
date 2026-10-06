//! Feeds turn recordings through the live diarizer the way the app does and
//! reports the speaker picked for each. Usage:
//!   cargo run --example live_speakers_probe -- a1.wav b1.wav a2.wav b2.wav ...

#[cfg(target_os = "macos")]
fn read_16k(path: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
    let mut reader = hound::WavReader::open(path)?;
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
    Ok(fluidaudio_rs::resample_samples(&mono, spec.sample_rate as f64)?)
}

#[cfg(target_os = "macos")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use fluidaudio_rs::FluidAudio;
    use std::time::Instant;

    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.is_empty() {
        return Err("usage: live_speakers_probe <turn.wav>...".into());
    }
    let audio = FluidAudio::new()?;
    let load_started = Instant::now();
    audio.init_live_diarizer_with_progress(|_| {})?;
    println!("model load: {:.1}s", load_started.elapsed().as_secs_f64());

    const STEP: usize = 5_120; // 320 ms at 16 kHz
    for pass in ["cold", "warm"] {
        audio.live_diarizer_reset()?;
        let mut audio_secs = 0.0_f64;
        let mut worst_ms = 0.0_f64;
        let started = Instant::now();
        let mut picks = Vec::new();
        for path in &paths {
            let samples = read_16k(path)?;
            audio_secs += samples.len() as f64 / 16_000.0;
            for chunk in samples.chunks(STEP) {
                let feed_started = Instant::now();
                audio.live_diarizer_feed(chunk)?;
                worst_ms = worst_ms.max(feed_started.elapsed().as_secs_f64() * 1000.0);
            }
            let counts = audio.live_diarizer_end_turn()?;
            let best = (0..4).max_by_key(|&slot| (counts[slot], std::cmp::Reverse(slot)));
            let pick = best.filter(|&slot| counts[slot] >= 3).map(|slot| slot + 1);
            picks.push(pick);
            println!("{pass} {path}: counts {counts:?} -> {pick:?}");
        }
        let elapsed = started.elapsed().as_secs_f64();
        println!(
            "{pass}: audio {audio_secs:.1}s  processing {elapsed:.2}s  speed {:.1}x real time  worst step {worst_ms:.0} ms  picks {picks:?}",
            audio_secs / elapsed
        );
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("live_speakers_probe requires macOS");
}
