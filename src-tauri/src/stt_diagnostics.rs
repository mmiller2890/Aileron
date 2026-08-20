#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComparisonArgs {
    pub audio_path: std::path::PathBuf,
    pub model: String,
    pub preprocessing: String,
    pub ground_truth: Option<String>,
}

pub fn word_error_rate(reference: &str, hypothesis: &str) -> f64 {
    let normalize = |text: &str| {
        text.split_whitespace()
            .map(|word| {
                word.trim_matches(|character: char| !character.is_alphanumeric())
                    .to_lowercase()
            })
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>()
    };
    let reference = normalize(reference);
    let hypothesis = normalize(hypothesis);
    if reference.is_empty() {
        return if hypothesis.is_empty() { 0.0 } else { 1.0 };
    }

    let mut previous: Vec<usize> = (0..=hypothesis.len()).collect();
    for (reference_index, reference_word) in reference.iter().enumerate() {
        let mut current = vec![reference_index + 1; hypothesis.len() + 1];
        for (hypothesis_index, hypothesis_word) in hypothesis.iter().enumerate() {
            let substitution =
                previous[hypothesis_index] + usize::from(reference_word != hypothesis_word);
            let insertion = current[hypothesis_index] + 1;
            let deletion = previous[hypothesis_index + 1] + 1;
            current[hypothesis_index + 1] = substitution.min(insertion).min(deletion);
        }
        previous = current;
    }
    previous[hypothesis.len()] as f64 / reference.len() as f64
}

pub fn parse_comparison_args(args: &[String]) -> Result<ComparisonArgs, String> {
    let Some(audio_path) = args.first() else {
        return Err("Missing input audio path".to_string());
    };
    let mut parsed = ComparisonArgs {
        audio_path: audio_path.into(),
        model: "v3".to_string(),
        preprocessing: "processed".to_string(),
        ground_truth: None,
    };
    let mut index = 1;
    while index < args.len() {
        let flag = &args[index];
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("Missing value for {flag}"))?;
        match flag.as_str() {
            "--model" if value == "v3" => parsed.model = value.clone(),
            "--model" => return Err(format!("Unsupported model: {value}")),
            "--preprocessing" if value == "processed" || value == "raw" || value == "both" => {
                parsed.preprocessing = value.clone()
            }
            "--preprocessing" => return Err(format!("Unsupported preprocessing mode: {value}")),
            "--ground-truth" => parsed.ground_truth = Some(value.clone()),
            _ => return Err(format!("Unknown argument: {flag}")),
        }
        index += 2;
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_text_has_zero_wer() {
        assert_eq!(word_error_rate("one two", "one two"), 0.0);
    }

    #[test]
    fn counts_insertions_deletions_and_substitutions() {
        assert_eq!(
            word_error_rate("one two three", "one four three"),
            1.0 / 3.0
        );
        assert_eq!(word_error_rate("one two", "one two three"), 0.5);
        assert_eq!(word_error_rate("one two three", "one three"), 1.0 / 3.0);
    }

    #[test]
    fn handles_empty_references() {
        assert_eq!(word_error_rate("", ""), 0.0);
        assert_eq!(word_error_rate("", "speech"), 1.0);
    }

    #[test]
    fn parses_supported_comparison_values() {
        let args = vec![
            "audio.wav".to_string(),
            "--model".to_string(),
            "v3".to_string(),
            "--preprocessing".to_string(),
            "both".to_string(),
        ];
        let parsed = parse_comparison_args(&args).unwrap();
        assert_eq!(parsed.model, "v3");
        assert_eq!(parsed.preprocessing, "both");
    }

    #[test]
    fn rejects_unsupported_comparison_values() {
        assert!(parse_comparison_args(&[
            "audio.wav".to_string(),
            "--model".to_string(),
            "turbo".to_string(),
        ])
        .is_err());
    }
}
