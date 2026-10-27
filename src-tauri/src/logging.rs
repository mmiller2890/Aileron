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

/// The app's own events from info up (session starts and stops, why a
/// capture ended); dependencies only from warnings up.
fn subscriber<W>(writer: W) -> impl tracing::Subscriber + Send + Sync
where
    W: for<'writer> tracing_subscriber::fmt::MakeWriter<'writer> + Send + Sync + 'static,
{
    use tracing_subscriber::{layer::SubscriberExt, Layer};

    let levels = tracing_subscriber::filter::Targets::new()
        .with_default(tracing::Level::WARN)
        .with_target("assistant_lib", tracing::Level::INFO);
    tracing_subscriber::registry().with(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(writer)
            .with_filter(levels),
    )
}

/// Install the global subscriber. Without a usable log file, events still
/// reach stderr.
pub fn init(log_dir: &Path) {
    use tracing_subscriber::fmt::writer::MakeWriterExt;

    let result = match open_log_file(log_dir) {
        Ok(file) => tracing::subscriber::set_global_default(subscriber(
            io::stderr.and(std::sync::Mutex::new(file)),
        )),
        Err(error) => {
            eprintln!("Logging to stderr only; cannot open the log file: {error}");
            tracing::subscriber::set_global_default(subscriber(io::stderr))
        }
    };
    if let Err(error) = result {
        eprintln!("Logging is not available: {error}");
    }
}

/// Longest UI message kept, so a runaway string cannot flood the log.
const MAX_UI_MESSAGE_CHARS: usize = 500;

/// Record an error or notice the UI showed, so the log explains what the
/// user saw. Logged as a warning under `assistant_lib::ui`. With level
/// `"info"` it records UI state instead (such as which provider a window is
/// on), at info.
#[tauri::command]
pub fn log_ui_message(message: String, level: Option<String>) {
    let message: String = message.chars().take(MAX_UI_MESSAGE_CHARS).collect();
    if level.as_deref() == Some("info") {
        tracing::info!(target: "assistant_lib::ui", "UI state: {message}");
    } else {
        tracing::warn!(target: "assistant_lib::ui", "UI showed: {message}");
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
    fn the_app_logs_info_and_dependencies_only_warnings() {
        let dir = temp_dir("write");
        let file = open_log_file(&dir).unwrap();
        tracing::subscriber::with_default(subscriber(std::sync::Mutex::new(file)), || {
            tracing::warn!(target: "assistant_lib::speaker", "System-audio drain stall: gap_ms=812");
            tracing::info!(target: "assistant_lib::speaker", "System-audio capture started");
            tracing::debug!(target: "assistant_lib::shortcuts", "Registered shortcut");
            tracing::info!(target: "sqlx::query", "chatty dependency");
            tracing::warn!(target: "sqlx::query", "slow statement");
        });
        let logged = fs::read_to_string(dir.join(LOG_FILE_NAME)).unwrap();
        assert!(logged.contains("System-audio drain stall: gap_ms=812"));
        assert!(logged.contains("System-audio capture started"));
        assert!(logged.contains("slow statement"));
        assert!(!logged.contains("Registered shortcut"));
        assert!(!logged.contains("chatty dependency"));
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
