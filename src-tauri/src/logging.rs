//! Sends `tracing` events to stderr and to a log file.
//!
//! The capture and STT code reports stalls, device changes, silent taps and
//! dropped live-text audio through `warn!`/`error!`. Without a subscriber
//! those events are discarded, so a dropout leaves no trace to diagnose.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

pub const LOG_FILE_NAME: &str = "aileron.log";
/// Past this size the log moves to `aileron.log.1` (replacing any older one)
/// when the app starts, so at most two files of about this size are kept.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub fn open_log_file(dir: &Path) -> io::Result<File> {
    fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE_NAME);
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
        fs::rename(&path, rotated_path(dir))?;
    }
    OpenOptions::new().create(true).append(true).open(path)
}

fn rotated_path(dir: &Path) -> PathBuf {
    dir.join(format!("{LOG_FILE_NAME}.1"))
}

/// Install the global subscriber. Without a usable log file, events still
/// reach stderr.
pub fn init(log_dir: &Path) {
    use tracing_subscriber::fmt::writer::MakeWriterExt;

    let builder = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_ansi(false);
    let result = match open_log_file(log_dir) {
        Ok(file) => builder
            .with_writer(io::stderr.and(std::sync::Mutex::new(file)))
            .try_init(),
        Err(error) => {
            eprintln!("Logging to stderr only; cannot open the log file: {error}");
            builder.with_writer(io::stderr).try_init()
        }
    };
    if let Err(error) = result {
        eprintln!("Logging is not available: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aileron-logging-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn warnings_reach_the_log_file() {
        let dir = temp_dir("write");
        let file = open_log_file(&dir).unwrap();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(file))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!("System-audio drain stall: gap_ms=812");
            tracing::info!("below the level");
        });
        let logged = fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        assert!(logged.contains("System-audio drain stall: gap_ms=812"));
        assert!(!logged.contains("below the level"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_oversized_log_moves_aside_at_startup() {
        let dir = temp_dir("rotate");
        let mut big = File::create(dir.join(LOG_FILE_NAME)).unwrap();
        big.write_all(&vec![b'x'; MAX_LOG_BYTES as usize + 1]).unwrap();
        drop(big);

        let mut file = open_log_file(&dir).unwrap();
        writeln!(file, "fresh").unwrap();

        assert_eq!(fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap(), "fresh\n");
        assert_eq!(fs::metadata(rotated_path(&dir)).unwrap().len(), MAX_LOG_BYTES + 1);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_small_log_keeps_its_history() {
        let dir = temp_dir("append");
        fs::write(dir.join(LOG_FILE_NAME), "earlier\n").unwrap();

        let mut file = open_log_file(&dir).unwrap();
        writeln!(file, "later").unwrap();

        assert_eq!(fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap(), "earlier\nlater\n");
        assert!(!rotated_path(&dir).exists());
        fs::remove_dir_all(dir).ok();
    }
}
