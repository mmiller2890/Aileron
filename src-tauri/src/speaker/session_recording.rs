use hound::{WavSpec, WavWriter};

pub(crate) const SESSION_RECORDING_MAX_SECS: u64 = 3600;

#[derive(Debug)]
pub(crate) enum AppendOutcome {
    Appended,
    Full,
}

pub(crate) struct SessionRecording<W: std::io::Write + std::io::Seek> {
    path: std::path::PathBuf,
    writer: Option<WavWriter<W>>,
    samples_written: usize,
    max_samples: usize,
}

impl SessionRecording<std::fs::File> {
    pub(crate) fn create_file(
        path: std::path::PathBuf,
        sample_rate: u32,
        max_samples: usize,
    ) -> Result<Self, String> {
        let file = open_owner_only_file(&path)?;
        let writer = WavWriter::new(file, wav_spec(sample_rate)).map_err(|e| e.to_string())?;
        Ok(Self {
            path,
            writer: Some(writer),
            samples_written: 0,
            max_samples,
        })
    }
}

impl<W: std::io::Write + std::io::Seek> SessionRecording<W> {
    pub(crate) fn from_writer(
        writer: WavWriter<W>,
        path: std::path::PathBuf,
        max_samples: usize,
    ) -> Self {
        Self {
            path,
            writer: Some(writer),
            samples_written: 0,
            max_samples,
        }
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        &self.path
    }

    pub(crate) fn append(&mut self, samples: &[f32]) -> Result<AppendOutcome, String> {
        if self.writer.is_none() {
            return Err("session recording already closed".to_string());
        }
        let room = self.max_samples.saturating_sub(self.samples_written);
        let accepted_len = samples.len().min(room);
        for &sample in &samples[..accepted_len] {
            let clamped = sample.clamp(-1.0, 1.0);
            if let Err(e) = self
                .writer
                .as_mut()
                .unwrap()
                .write_sample((clamped * i16::MAX as f32) as i16)
            {
                self.close_and_remove();
                return Err(e.to_string());
            }
            self.samples_written += 1;
        }
        if self.samples_written >= self.max_samples {
            self.close_and_remove();
            return Ok(AppendOutcome::Full);
        }
        Ok(AppendOutcome::Appended)
    }

    pub(crate) fn finalize(mut self) -> Result<(), String> {
        let result = match self.writer.take() {
            Some(writer) => writer.finalize().map_err(|e| e.to_string()),
            None => Ok(()),
        };
        if let Err(e) = result {
            self.remove_file();
            return Err(e);
        }
        Ok(())
    }

    pub(crate) fn discard(&mut self) {
        self.close_and_remove();
    }

    fn close_and_remove(&mut self) {
        self.writer = None;
        self.remove_file();
    }

    fn remove_file(&self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn wav_spec(sample_rate: u32) -> WavSpec {
    WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    }
}

pub(crate) fn open_owner_only_file(path: &std::path::Path) -> Result<std::fs::File, String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    options.open(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_wav_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "aileron-session-recording-{}-{}.wav",
            tag,
            uuid::Uuid::new_v4()
        ))
    }

    struct FailingWriter {
        fail: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl std::io::Write for FailingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
                Err(std::io::Error::other("disk I/O error"))
            } else {
                Ok(buf.len())
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl std::io::Seek for FailingWriter {
        fn seek(&mut self, _pos: std::io::SeekFrom) -> std::io::Result<u64> {
            Ok(0)
        }
    }

    fn read_back_samples(path: &std::path::Path) -> (u32, Vec<i16>) {
        let mut reader = hound::WavReader::open(path).unwrap();
        let spec = reader.spec();
        let samples = reader
            .samples::<i16>()
            .collect::<Result<Vec<i16>, _>>()
            .unwrap();
        (spec.sample_rate, samples)
    }

    #[test]
    fn late_samples_beyond_the_manual_duration_stay_available_for_diarization() {
        let sample_rate = 1_000u32;
        let manual_limit_samples = 180 * sample_rate as usize;
        let session_limit_samples = 3600 * sample_rate as usize;
        let path = temp_wav_path("late");

        let mut recording =
            SessionRecording::create_file(path.clone(), sample_rate, session_limit_samples)
                .unwrap();

        let chunk = vec![0.5; sample_rate as usize];
        for _ in 0..manual_limit_samples / sample_rate as usize {
            assert!(matches!(recording.append(&chunk), Ok(AppendOutcome::Appended)));
        }
        assert!(matches!(recording.append(&chunk), Ok(AppendOutcome::Appended)));

        recording.finalize().unwrap();

        let (rate, samples) = read_back_samples(&path);
        assert_eq!(rate, sample_rate);
        assert_eq!(samples.len(), manual_limit_samples + sample_rate as usize);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn finalized_wav_is_valid_with_round_tripped_samples() {
        let sample_rate = 8_000u32;
        let path = temp_wav_path("valid");
        let mut recording =
            SessionRecording::create_file(path.clone(), sample_rate, 10 * sample_rate as usize)
                .unwrap();

        let samples: Vec<f32> = (0..sample_rate)
            .map(|i| ((i as f32 / 100.0).sin()) * 0.5)
            .collect();
        assert!(matches!(recording.append(&samples), Ok(AppendOutcome::Appended)));

        recording.finalize().unwrap();

        let (rate, read_back) = read_back_samples(&path);
        assert_eq!(rate, sample_rate);
        assert_eq!(read_back.len(), samples.len());
        let expected = (samples[7].clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        assert_eq!(read_back[7], expected);
        std::fs::remove_file(&path).ok();
    }

    #[cfg(unix)]
    #[test]
    fn session_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_wav_path("perms");
        let recording =
            SessionRecording::create_file(path.clone(), 8_000, 8_000).unwrap();
        recording.finalize().unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn write_failure_removes_the_partial_file() {
        let path = temp_wav_path("failing");
        std::fs::write(&path, b"").unwrap();
        let fail = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let writer =
            WavWriter::new(FailingWriter { fail: fail.clone() }, wav_spec(8_000)).unwrap();
        let mut recording = SessionRecording::from_writer(writer, path.clone(), 10_000);

        fail.store(true, std::sync::atomic::Ordering::SeqCst);
        let error = recording
            .append(&[0.5, -0.5, 0.25])
            .expect_err("failing writer must propagate the error");
        assert!(error.contains("disk I/O error"));

        assert!(!path.exists());
    }

    #[test]
    fn create_failure_on_an_unwritable_path_is_reported() {
        let path = std::env::temp_dir()
            .join(format!("aileron-missing-dir-{}", uuid::Uuid::new_v4()))
            .join("session.wav");

        let result = SessionRecording::create_file(path, 8_000, 1_000);

        assert!(result.is_err());
    }

    #[test]
    fn ceiling_removes_the_partial_file_and_reports_full() {
        let path = temp_wav_path("ceiling");
        let writer =
            WavWriter::new(std::fs::File::create(&path).unwrap(), wav_spec(8_000)).unwrap();
        let mut recording = SessionRecording::from_writer(writer, path.clone(), 5);

        assert!(matches!(recording.append(&[0.1; 3]), Ok(AppendOutcome::Appended)));
        assert!(matches!(recording.append(&[0.1; 3]), Ok(AppendOutcome::Full)));
        assert!(!path.exists());

        recording.finalize().unwrap();
    }

    #[test]
    fn appending_after_close_is_an_error() {
        let path = temp_wav_path("closed");
        let mut recording =
            SessionRecording::create_file(path.clone(), 8_000, 100).unwrap();
        recording.discard();

        assert!(recording.append(&[0.1]).is_err());
    }

    #[test]
    fn seek_round_trip_keeps_the_writer_position_consistent() {
        let path = temp_wav_path("seek");
        let file = std::fs::File::create(&path).unwrap();
        let writer = WavWriter::new(file, wav_spec(8_000)).unwrap();
        let mut recording = SessionRecording::from_writer(writer, path.clone(), 1_000);
        recording.append(&[0.5; 10]).unwrap();
        recording.finalize().unwrap();

        let (_, samples) = read_back_samples(&path);
        assert_eq!(samples.len(), 10);
        std::fs::remove_file(&path).ok();
    }
}