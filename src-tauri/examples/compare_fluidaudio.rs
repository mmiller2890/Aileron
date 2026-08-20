#[cfg(target_os = "macos")]
use assistant_lib::speaker::preprocessing::prepare_utterance;
#[cfg(target_os = "macos")]
use assistant_lib::stt_diagnostics::{parse_comparison_args, word_error_rate, ComparisonArgs};
#[cfg(target_os = "macos")]
use fluidaudio_rs::{resample_samples, AsrModelVersion, FluidAudio};

#[cfg(target_os = "macos")]
fn read_wav(path: &std::path::Path) -> anyhow::Result<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::open(path)?;
    let spec = reader.spec();
    let interleaved = match spec.sample_format {
        hound::SampleFormat::Float => reader.samples::<f32>().collect::<Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = ((1_i64 << (spec.bits_per_sample.saturating_sub(1))) - 1) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    let channels = spec.channels.max(1) as usize;
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect();
    Ok((mono, spec.sample_rate))
}

#[cfg(target_os = "macos")]
fn transcribe_variant(
    audio: &FluidAudio,
    samples: &[f32],
    source_rate: u32,
    model: &str,
    preprocessing: &str,
    ground_truth: Option<&str>,
) -> anyhow::Result<serde_json::Value> {
    let converted = resample_samples(samples, source_rate as f64)?;
    let result = audio.transcribe_samples(&converted)?;
    let normalized = audio
        .itn_normalize_sentence(&result.text)
        .unwrap_or_else(|_| result.text.clone());
    let wer = ground_truth.map(|reference| word_error_rate(reference, &normalized));
    Ok(serde_json::json!({
        "text": normalized,
        "raw_text": result.text,
        "normalized_text": normalized,
        "confidence": result.confidence,
        "duration": result.duration,
        "processing_time": result.processing_time,
        "rtfx": result.rtfx,
        "diagnostics": {
            "model_version": model,
            "preprocessing": preprocessing,
            "source_path": "comparison-file",
            "input_duration_ms": samples.len() as f64 / source_rate as f64 * 1_000.0,
            "input_sample_rate": source_rate,
            "converted_sample_count": converted.len(),
            "transcription_ms": result.processing_time * 1_000.0,
            "itn_applied": normalized != result.text,
        },
        "wer": wer,
    }))
}

#[cfg(target_os = "macos")]
fn run(args: ComparisonArgs) -> anyhow::Result<serde_json::Value> {
    let (source, sample_rate) = read_wav(&args.audio_path)?;
    let prepared = prepare_utterance(&source, 0.0015, true);
    let model = AsrModelVersion::parse(&args.model).map_err(anyhow::Error::msg)?;
    eprintln!("Loading FluidAudio {} model", args.model);
    let audio = FluidAudio::new()?;
    audio.init_asr_version(model)?;

    let mut results = serde_json::Map::new();
    if args.preprocessing == "processed" || args.preprocessing == "both" {
        results.insert(
            "processed".to_string(),
            transcribe_variant(
                &audio,
                &prepared.processed,
                sample_rate,
                &args.model,
                "processed",
                args.ground_truth.as_deref(),
            )?,
        );
    }
    if args.preprocessing == "raw" || args.preprocessing == "both" {
        results.insert(
            "raw".to_string(),
            transcribe_variant(
                &audio,
                &prepared.raw,
                sample_rate,
                &args.model,
                "raw",
                args.ground_truth.as_deref(),
            )?,
        );
    }

    Ok(serde_json::json!({
        "input_path": args.audio_path,
        "source_sample_rate": sample_rate,
        "source_duration": source.len() as f64 / sample_rate as f64,
        "model_version": args.model,
        "results": results,
    }))
}

#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let args = parse_comparison_args(&raw_args).map_err(anyhow::Error::msg)?;
    println!("{}", serde_json::to_string_pretty(&run(args)?)?);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("FluidAudio comparison requires macOS Apple Silicon");
    std::process::exit(1);
}
