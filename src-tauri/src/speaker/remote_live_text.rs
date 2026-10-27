//! Live text from a local transcription server, where FluidAudio's streaming
//! model is not available (Linux and Windows with `parakeet_server.py`).
//!
//! Each update re-transcribes the turn so far: on an RTX 3080, Parakeet takes
//! 50 ms for 7 s of speech and about 100 ms for 30 s, so the whole turn fits
//! comfortably between updates and partials have the final model's quality.
//! The audio goes straight from Rust to the server, at 16 kHz.

use super::live_text::LiveTextModel;
use std::time::{Duration, Instant};

/// Shortest gap between requests. The worker feeds 320 ms batches, so this
/// sends about one request per batch.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(300);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const SAMPLE_RATE: u32 = 16_000;

/// Whether `url` is an http endpoint on this machine. Turn audio is only ever
/// sent to a server the user runs locally, so the address is parsed rather
/// than prefix-matched: `http://127.0.0.1:8001@evil.com/x` starts with a local
/// prefix but connects to `evil.com`.
pub(crate) fn is_local_endpoint(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    if parsed.scheme() != "http" {
        return false;
    }
    matches!(
        parsed.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1")
    )
}

pub(crate) struct RemoteLiveTextModel {
    endpoint: String,
    client: reqwest::Client,
    samples: Vec<f32>,
    last_request: Option<Instant>,
    last_text: String,
}

impl RemoteLiveTextModel {
    pub(crate) fn new(endpoint: String) -> Result<Self, String> {
        if !is_local_endpoint(&endpoint) {
            return Err(format!("Live text only uses a local server, not {endpoint}"));
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            endpoint,
            client,
            samples: Vec::new(),
            last_request: None,
            last_text: String::new(),
        })
    }

    fn transcribe(&self) -> Result<String, String> {
        const BOUNDARY: &str = "aileron-live-text-boundary";
        let mut body = format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"turn.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(&wav_16k(&self.samples));
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

        let request = self
            .client
            .post(&self.endpoint)
            .header("Content-Type", format!("multipart/form-data; boundary={BOUNDARY}"))
            .body(body);
        // Sending needs a Tokio runtime; the live-text worker is a plain
        // thread, so run the request on Tauri's.
        tauri::async_runtime::block_on(async move {
            let response = request.send().await.map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("Live text server returned {}", response.status()));
            }
            let value: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
            Ok(value["text"].as_str().unwrap_or_default().trim().to_string())
        })
    }
}

impl LiveTextModel for RemoteLiveTextModel {
    fn reset(&mut self) -> Result<(), String> {
        self.samples.clear();
        self.last_request = None;
        self.last_text.clear();
        Ok(())
    }

    fn feed(&mut self, samples_16k: &[f32]) -> Result<String, String> {
        self.samples.extend_from_slice(samples_16k);
        if self
            .last_request
            .is_some_and(|sent| sent.elapsed() < MIN_REQUEST_INTERVAL)
        {
            return Ok(self.last_text.clone());
        }
        self.last_request = Some(Instant::now());
        self.last_text = self.transcribe()?;
        Ok(self.last_text.clone())
    }
}

/// 16-bit mono PCM WAV at 16 kHz.
fn wav_16k(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + data_len as usize);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for &sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        wav.extend_from_slice(&value.to_le_bytes());
    }
    wav
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// A local server answering every request with `{"text": "<n> requests"}`
    /// and recording each request's body length and first WAV bytes.
    fn fake_server() -> (String, Arc<Mutex<Vec<(usize, Vec<u8>)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/audio/transcriptions", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                    if line == "\r\n" {
                        break;
                    }
                }
                let mut body = vec![0u8; length];
                reader.read_exact(&mut body).unwrap();
                let riff = body.windows(4).position(|w| w == b"RIFF").unwrap();
                let count = {
                    let mut log = log.lock().unwrap();
                    log.push((length, body[riff..riff + 44].to_vec()));
                    log.len()
                };
                let json = format!("{{\"text\": \" {count} requests \"}}");
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                    json.len()
                )
                .unwrap();
            }
        });
        (url, seen)
    }

    #[test]
    fn only_servers_on_this_machine_are_accepted() {
        assert!(is_local_endpoint("http://127.0.0.1:8001/v1/audio/transcriptions"));
        assert!(is_local_endpoint("http://localhost:8001/v1/audio/transcriptions"));
        assert!(is_local_endpoint("http://[::1]:8001/v1/audio/transcriptions"));
        assert!(!is_local_endpoint("https://api.example.com/v1/audio/transcriptions"));
        assert!(!is_local_endpoint("http://127.0.0.1.example.com:8001/"));
        assert!(RemoteLiveTextModel::new("https://api.example.com/x".into()).is_err());
    }

    #[test]
    fn a_local_looking_address_cannot_smuggle_another_host() {
        // Userinfo, not a host: this reaches evil.com, so the guard must miss it.
        assert!(!is_local_endpoint("http://127.0.0.1:8001@evil.com/x"));
        assert!(!is_local_endpoint("http://localhost@evil.com/x"));
        assert!(RemoteLiveTextModel::new("http://127.0.0.1:1@evil.com/x".into()).is_err());
    }

    #[test]
    fn only_http_is_accepted() {
        assert!(!is_local_endpoint("https://localhost:8001/x"));
        assert!(!is_local_endpoint("file:///tmp/socket"));
        assert!(!is_local_endpoint("not a url"));
    }

    #[test]
    fn a_feed_returns_the_servers_transcript_of_the_turn_as_16k_wav() {
        let (url, seen) = fake_server();
        let mut model = RemoteLiveTextModel::new(url).unwrap();
        assert_eq!(model.feed(&vec![0.1; 5_120]).unwrap(), "1 requests");
        let seen = seen.lock().unwrap();
        let header = &seen[0].1;
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(header[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 5_120 * 2);
    }

    #[test]
    fn feeds_closer_than_the_interval_reuse_the_last_transcript() {
        let (url, seen) = fake_server();
        let mut model = RemoteLiveTextModel::new(url).unwrap();
        assert_eq!(model.feed(&vec![0.1; 160]).unwrap(), "1 requests");
        assert_eq!(model.feed(&vec![0.1; 160]).unwrap(), "1 requests");
        assert_eq!(seen.lock().unwrap().len(), 1);
        std::thread::sleep(MIN_REQUEST_INTERVAL);
        assert_eq!(model.feed(&vec![0.1; 160]).unwrap(), "2 requests");
        // The second request carries the whole turn so far.
        let data_len = |i: usize| u32::from_le_bytes(seen.lock().unwrap()[i].1[40..44].try_into().unwrap());
        assert_eq!(data_len(1), 160 * 3 * 2);
    }

    #[test]
    fn a_reset_starts_the_next_turn_from_fresh_audio() {
        let (url, seen) = fake_server();
        let mut model = RemoteLiveTextModel::new(url).unwrap();
        model.feed(&vec![0.1; 8_000]).unwrap();
        model.reset().unwrap();
        model.feed(&vec![0.1; 160]).unwrap();
        let data_len = u32::from_le_bytes(seen.lock().unwrap()[1].1[40..44].try_into().unwrap());
        assert_eq!(data_len, 160 * 2);
    }

    #[test]
    fn an_unreachable_server_is_an_error_not_a_hang() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/x", listener.local_addr().unwrap());
        drop(listener);
        let mut model = RemoteLiveTextModel::new(url).unwrap();
        assert!(model.feed(&[0.0; 160]).is_err());
    }
}
