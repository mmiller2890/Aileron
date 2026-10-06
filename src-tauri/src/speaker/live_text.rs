//! Best-effort live text for the turn in progress.
//!
//! The capture loop hands 16 kHz audio to a dedicated thread that owns the
//! streaming model. Nothing here may slow capture down: the queue is bounded,
//! sends never wait, and a worker that will not stop is left behind.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::Duration;

/// About two seconds of capture hops (one message per ~21 ms hop).
pub(crate) const LIVE_TEXT_QUEUE_MESSAGES: usize = 96;

pub(crate) trait LiveTextModel: Send {
    fn reset(&mut self) -> Result<(), String>;
    /// Feed 16 kHz mono samples; returns the text accumulated since `reset`.
    fn feed(&mut self, samples_16k: &[f32]) -> Result<String, String>;
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct LiveTextPartial {
    pub turn: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LiveTextEvent {
    Partial(LiveTextPartial),
    Error(String),
}

enum Message {
    /// Audio carries its turn so a dropped `End` or a dropped first message
    /// can never attach one turn's audio to another turn's text.
    Audio { turn: u64, samples: Vec<f32> },
    End,
}

pub(crate) struct LiveTextHandle {
    tx: SyncSender<Message>,
    done: Receiver<()>,
    active: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
}

impl LiveTextHandle {
    pub(crate) fn spawn(
        model: Box<dyn LiveTextModel>,
        emit: impl FnMut(LiveTextEvent) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel(LIVE_TEXT_QUEUE_MESSAGES);
        let (done_tx, done) = mpsc::channel();
        let active = Arc::new(AtomicBool::new(true));
        let worker_active = active.clone();
        std::thread::Builder::new()
            .name("live-text".into())
            .spawn(move || {
                run_worker(model, rx, worker_active, emit);
                let _ = done_tx.send(());
            })
            .expect("failed to spawn the live-text thread");
        Self {
            tx,
            done,
            active,
            dropped: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) fn audio(&self, turn: u64, samples: Vec<f32>) {
        self.send(Message::Audio { turn, samples });
    }

    pub(crate) fn end_turn(&self) {
        self.send(Message::End);
    }

    /// Messages dropped because the worker was behind.
    pub(crate) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    fn send(&self, message: Message) {
        if self.tx.try_send(message).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Stop the worker. Returns false if it had not exited by the deadline,
    /// in which case it is left to finish on its own and can no longer emit.
    pub(crate) fn stop(self, deadline: Duration) -> bool {
        self.active.store(false, Ordering::Release);
        let Self { tx, done, .. } = self;
        drop(tx);
        done.recv_timeout(deadline).is_ok()
    }
}

fn run_worker(
    mut model: Box<dyn LiveTextModel>,
    rx: Receiver<Message>,
    active: Arc<AtomicBool>,
    mut emit: impl FnMut(LiveTextEvent),
) {
    let mut current_turn: Option<u64> = None;
    let mut last_text = String::new();
    let mut failed = false;

    while let Ok(message) = rx.recv() {
        if failed || !active.load(Ordering::Acquire) {
            continue;
        }
        let (turn, samples) = match message {
            Message::End => {
                current_turn = None;
                continue;
            }
            Message::Audio { turn, samples } => (turn, samples),
        };

        let result = if current_turn != Some(turn) {
            current_turn = Some(turn);
            last_text.clear();
            model.reset().and_then(|()| model.feed(&samples))
        } else {
            model.feed(&samples)
        };

        if !active.load(Ordering::Acquire) {
            continue;
        }
        match result {
            Ok(text) => {
                if !text.is_empty() && text != last_text {
                    last_text = text.clone();
                    emit(LiveTextEvent::Partial(LiveTextPartial { turn, text }));
                }
            }
            Err(error) => {
                failed = true;
                emit(LiveTextEvent::Error(error));
            }
        }
    }
}

/// Turn bookkeeping for the capture loop. Turns are numbered whether or not a
/// worker exists, so `speech-detected` always carries a turn.
pub(crate) struct LiveTextTurns {
    handle: Option<LiveTextHandle>,
    turn: u64,
    in_turn: bool,
}

impl LiveTextTurns {
    pub(crate) fn new(handle: Option<LiveTextHandle>) -> Self {
        Self {
            handle,
            turn: 0,
            in_turn: false,
        }
    }

    /// Start the next turn with the audio that preceded the detection.
    pub(crate) fn begin(&mut self, lead_in_16k: Vec<f32>) -> u64 {
        self.turn += 1;
        self.in_turn = true;
        if !lead_in_16k.is_empty() {
            self.audio(lead_in_16k);
        }
        self.turn
    }

    pub(crate) fn audio(&self, samples_16k: Vec<f32>) {
        if !self.in_turn || samples_16k.is_empty() {
            return;
        }
        if let Some(handle) = &self.handle {
            handle.audio(self.turn, samples_16k);
        }
    }

    pub(crate) fn end(&mut self) {
        if !self.in_turn {
            return;
        }
        self.in_turn = false;
        if let Some(handle) = &self.handle {
            handle.end_turn();
        }
    }

    pub(crate) fn current(&self) -> u64 {
        self.turn
    }

    pub(crate) fn stop(self, deadline: Duration) {
        if let Some(handle) = self.handle {
            handle.stop(deadline);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Script {
        calls: Vec<String>,
        fail_on_feed: Option<usize>,
        feeds: usize,
    }

    /// Returns "t<n>" where n counts feeds since the last reset.
    struct FakeModel {
        script: Arc<Mutex<Script>>,
        since_reset: usize,
        gate: Option<mpsc::Receiver<()>>,
    }

    impl LiveTextModel for FakeModel {
        fn reset(&mut self) -> Result<(), String> {
            self.since_reset = 0;
            self.script.lock().unwrap().calls.push("reset".into());
            Ok(())
        }

        fn feed(&mut self, samples: &[f32]) -> Result<String, String> {
            if let Some(gate) = &self.gate {
                let _ = gate.recv();
            }
            let mut script = self.script.lock().unwrap();
            script.feeds += 1;
            if script.fail_on_feed == Some(script.feeds) {
                return Err("model exploded".into());
            }
            script.calls.push(format!("feed:{}", samples.len()));
            self.since_reset += 1;
            Ok(format!("t{}", self.since_reset))
        }
    }

    fn spawn_with(
        script: Arc<Mutex<Script>>,
        gate: Option<mpsc::Receiver<()>>,
    ) -> (LiveTextHandle, mpsc::Receiver<LiveTextEvent>) {
        let (tx, rx) = mpsc::channel();
        let handle = LiveTextHandle::spawn(
            Box::new(FakeModel { script, since_reset: 0, gate }),
            move |event| {
                let _ = tx.send(event);
            },
        );
        (handle, rx)
    }

    fn next(rx: &mpsc::Receiver<LiveTextEvent>) -> LiveTextEvent {
        rx.recv_timeout(Duration::from_secs(2)).expect("expected an event")
    }

    fn partial(turn: u64, text: &str) -> LiveTextEvent {
        LiveTextEvent::Partial(LiveTextPartial { turn, text: text.into() })
    }

    #[test]
    fn partials_carry_the_turn_and_follow_the_model_text() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (handle, rx) = spawn_with(script.clone(), None);

        handle.audio(1, vec![0.0; 4]);
        handle.audio(1, vec![0.0; 4]);
        assert_eq!(next(&rx), partial(1, "t1"));
        assert_eq!(next(&rx), partial(1, "t2"));
        assert!(handle.stop(Duration::from_secs(2)));
        assert_eq!(script.lock().unwrap().calls[0], "reset");
    }

    #[test]
    fn a_new_turn_resets_the_model_even_when_the_end_was_never_seen() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (handle, rx) = spawn_with(script.clone(), None);

        handle.audio(1, vec![0.0; 4]);
        assert_eq!(next(&rx), partial(1, "t1"));
        // No end_turn(): a dropped End must not leak turn 1 into turn 2.
        handle.audio(2, vec![0.0; 4]);
        assert_eq!(next(&rx), partial(2, "t1"));
        assert!(handle.stop(Duration::from_secs(2)));
        let calls = script.lock().unwrap().calls.clone();
        assert_eq!(calls, vec!["reset", "feed:4", "reset", "feed:4"]);
    }

    #[test]
    fn a_full_queue_drops_audio_without_blocking_the_sender() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (gate_tx, gate_rx) = mpsc::channel();
        let (handle, _rx) = spawn_with(script, Some(gate_rx));

        let started = Instant::now();
        for _ in 0..(LIVE_TEXT_QUEUE_MESSAGES * 3) {
            handle.audio(1, vec![0.0; 4]);
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(handle.dropped() > 0);

        drop(gate_tx); // unblock the model so the worker can exit
        assert!(handle.stop(Duration::from_secs(2)));
    }

    #[test]
    fn a_model_error_is_reported_once_and_later_audio_is_ignored() {
        let script = Arc::new(Mutex::new(Script { fail_on_feed: Some(1), ..Script::default() }));
        let (handle, rx) = spawn_with(script.clone(), None);

        handle.audio(1, vec![0.0; 4]);
        assert_eq!(next(&rx), LiveTextEvent::Error("model exploded".into()));
        handle.audio(1, vec![0.0; 4]);
        handle.audio(2, vec![0.0; 4]);
        assert!(handle.stop(Duration::from_secs(2)));
        assert!(rx.try_recv().is_err());
        assert_eq!(script.lock().unwrap().feeds, 1);
    }

    #[test]
    fn stop_gives_up_at_the_deadline_and_a_detached_worker_stays_silent() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (gate_tx, gate_rx) = mpsc::channel();
        let (handle, rx) = spawn_with(script, Some(gate_rx));

        handle.audio(1, vec![0.0; 4]);
        std::thread::sleep(Duration::from_millis(50)); // worker is now blocked in feed
        let started = Instant::now();
        assert!(!handle.stop(Duration::from_millis(100)));
        assert!(started.elapsed() < Duration::from_secs(1));

        drop(gate_tx); // the model returns after stop
        std::thread::sleep(Duration::from_millis(100));
        assert!(rx.try_recv().is_err(), "a stopped worker must not emit");
    }

    #[test]
    fn turns_number_from_one_and_only_send_audio_inside_a_turn() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (handle, rx) = spawn_with(script.clone(), None);
        let mut turns = LiveTextTurns::new(Some(handle));

        assert_eq!(turns.current(), 0);
        turns.audio(vec![0.0; 9]); // before any turn: ignored
        assert_eq!(turns.begin(vec![0.0; 8]), 1);
        assert_eq!(next(&rx), partial(1, "t1"));
        turns.audio(vec![0.0; 4]);
        assert_eq!(next(&rx), partial(1, "t2"));
        turns.end();
        turns.end(); // idempotent
        turns.audio(vec![0.0; 9]); // between turns: ignored
        assert_eq!(turns.begin(Vec::new()), 2);
        turns.audio(vec![0.0; 4]);
        assert_eq!(next(&rx), partial(2, "t1"));
        turns.stop(Duration::from_secs(2));

        let calls = script.lock().unwrap().calls.clone();
        assert_eq!(calls, vec!["reset", "feed:8", "feed:4", "reset", "feed:4"]);
    }

    #[test]
    fn turns_still_count_without_a_worker() {
        let mut turns = LiveTextTurns::new(None);
        assert_eq!(turns.begin(vec![0.0; 8]), 1);
        turns.audio(vec![0.0; 4]);
        turns.end();
        assert_eq!(turns.begin(Vec::new()), 2);
        turns.stop(Duration::from_millis(10));
    }
}
