//! Speaker labels from a local transcription server, where FluidAudio's
//! streaming diarizer is not available (Linux and Windows).
//!
//! The server owns Sortformer's streaming state, so a slot stays bound to the
//! same voice across turns. Each update asks it for the activity of the turn in
//! progress, counted in the model's own 80 ms frames.

use super::live_speakers::{LiveSpeakerModel, SlotCounts};
use super::remote_live_text::{is_local_endpoint, wav_16k};
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const BOUNDARY: &str = "aileron-speaker-boundary";

pub(crate) struct RemoteLiveSpeakerModel {
    base_url: String,
    client: reqwest::Client,
}

impl RemoteLiveSpeakerModel {
    /// `base_url` is the server's speaker root, e.g.
    /// `http://localhost:8001/v1/speakers`.
    pub(crate) fn new(base_url: String) -> Result<Self, String> {
        if !is_local_endpoint(&base_url) {
            return Err(format!(
                "Speaker labels only use a local server, not {base_url}"
            ));
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { base_url, client })
    }

    fn post(&self, path: &str, body: Option<Vec<u8>>) -> Result<SlotCounts, String> {
        let url = format!("{}{path}", self.base_url.trim_end_matches('/'));
        let request = self.client.post(url);
        let request = match body {
            Some(body) => request
                .header(
                    "Content-Type",
                    format!("multipart/form-data; boundary={BOUNDARY}"),
                )
                .body(body),
            None => request,
        };
        // Sending needs a Tokio runtime; the speaker worker is a plain thread.
        tauri::async_runtime::block_on(async move {
            let response = request.send().await.map_err(|error| error.to_string())?;
            if !response.status().is_success() {
                return Err(format!("Speaker server returned {}", response.status()));
            }
            let value: serde_json::Value =
                response.json().await.map_err(|error| error.to_string())?;
            slot_counts_from(&value)
        })
    }
}

impl LiveSpeakerModel for RemoteLiveSpeakerModel {
    fn reset(&mut self) -> Result<(), String> {
        self.post("/reset", None).map(|_| ())
    }

    fn feed(&mut self, samples_16k: &[f32]) -> Result<SlotCounts, String> {
        self.post("/feed", Some(multipart(samples_16k)))
    }

    fn end_turn(&mut self) -> Result<SlotCounts, String> {
        self.post("/end_turn", None)
    }
}

fn slot_counts_from(value: &serde_json::Value) -> Result<SlotCounts, String> {
    let array = value["counts"]
        .as_array()
        .ok_or("Speaker server sent no counts")?;
    if array.len() != 4 {
        return Err(format!(
            "Speaker server sent {} counts, expected 4",
            array.len()
        ));
    }
    let mut counts = [0u32; 4];
    for (slot, count) in array.iter().enumerate() {
        let count = count
            .as_u64()
            .ok_or("Speaker server sent a non-numeric count")?;
        counts[slot] = count.min(u32::MAX as u64) as u32;
    }
    Ok(counts)
}

fn multipart(samples_16k: &[f32]) -> Vec<u8> {
    let mut body = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"turn.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(&wav_16k(samples_16k));
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// Answers every request with `{"counts":<counts>}` and records the path
    /// and body length it was asked for.
    fn fake_server(counts: &'static str) -> (String, Arc<Mutex<Vec<(String, usize)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!(
            "http://{}/v1/speakers",
            listener.local_addr().unwrap()
        );
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let path = request_line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let mut length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap_or(0);
                    }
                    if line == "\r\n" {
                        break;
                    }
                }
                let mut body = vec![0u8; length];
                reader.read_exact(&mut body).unwrap();
                log.lock().unwrap().push((path, body.len()));
                let json = format!("{{\"counts\":{counts}}}");
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                    json.len()
                )
                .unwrap();
            }
        });
        (base, seen)
    }

    #[test]
    fn a_feed_returns_the_servers_counts() {
        let (base, _) = fake_server("[1,2,3,4]");
        let mut model = RemoteLiveSpeakerModel::new(base).unwrap();
        assert_eq!(model.feed(&vec![0.1; 5_120]).unwrap(), [1, 2, 3, 4]);
    }

    #[test]
    fn each_call_reaches_its_own_endpoint() {
        let (base, seen) = fake_server("[0,0,0,2]");
        let mut model = RemoteLiveSpeakerModel::new(base).unwrap();
        model.reset().unwrap();
        model.feed(&vec![0.1; 512]).unwrap();
        assert_eq!(model.end_turn().unwrap(), [0, 0, 0, 2]);
        let paths: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(path, _)| path.clone())
            .collect();
        assert_eq!(paths, vec!["/v1/speakers/reset", "/v1/speakers/feed", "/v1/speakers/end_turn"]);
    }

    #[test]
    fn the_fed_chunk_carries_a_16k_wav() {
        let (base, seen) = fake_server("[0,0,0,0]");
        let mut model = RemoteLiveSpeakerModel::new(base).unwrap();
        model.feed(&vec![0.0; 1_600]).unwrap();
        let seen = seen.lock().unwrap();
        let (path, length) = &seen[0];
        assert_eq!(path, "/v1/speakers/feed");
        // Header + multipart framing + 1600 samples of 2-byte PCM.
        assert!(*length > 3_200, "{length}");
    }

    #[test]
    fn a_server_that_sends_the_wrong_number_of_slots_is_an_error() {
        let (base, _) = fake_server("[1,2]");
        let mut model = RemoteLiveSpeakerModel::new(base).unwrap();
        assert!(model.feed(&vec![0.0; 160]).is_err());
    }

    #[test]
    fn only_a_local_server_is_accepted() {
        assert!(RemoteLiveSpeakerModel::new("https://api.example.com/v1/speakers".into()).is_err());
        assert!(RemoteLiveSpeakerModel::new("http://127.0.0.1:1@evil.com/v1/speakers".into()).is_err());
        assert!(RemoteLiveSpeakerModel::new("http://localhost:8001/v1/speakers".into()).is_ok());
    }

    #[test]
    fn an_unreachable_server_is_an_error_not_a_hang() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/v1/speakers", listener.local_addr().unwrap());
        drop(listener);
        let mut model = RemoteLiveSpeakerModel::new(base).unwrap();
        assert!(model.reset().is_err());
    }
}
