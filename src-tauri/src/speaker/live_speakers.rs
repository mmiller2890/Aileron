//! Best-effort speaker labels for each turn.
//!
//! Mirrors `live_text`: a dedicated thread owns the diarizer, the queue is
//! bounded, sends never wait, and nothing here may slow capture down.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::Duration;

/// About two seconds of capture hops, plus room for end-of-turn messages.
pub(crate) const LIVE_SPEAKER_QUEUE_MESSAGES: usize = 96;
/// A slot must be active for this many 80 ms frames to name the turn.
const MIN_SPEAKER_FRAMES: u32 = 3;

pub(crate) type SlotCounts = [u32; 4];

/// The slot that was active longest, if any was active long enough. Ties go
/// to the lower slot (the earlier speaker).
pub(crate) fn dominant_slot(counts: &SlotCounts) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (slot, &count) in counts.iter().enumerate() {
        if count >= MIN_SPEAKER_FRAMES && best.is_none_or(|current| count > counts[current]) {
            best = Some(slot);
        }
    }
    best
}

fn speaker_name(slot: usize) -> String {
    format!("Speaker {}", slot + 1)
}

pub(crate) trait LiveSpeakerModel: Send {
    /// Start a new session: forget every speaker.
    fn reset(&mut self) -> Result<(), String>;
    /// Feed 16 kHz mono samples of the open turn; per-slot activity so far.
    fn feed(&mut self, samples_16k: &[f32]) -> Result<SlotCounts, String>;
    /// Close the open turn; its final per-slot activity.
    fn end_turn(&mut self) -> Result<SlotCounts, String>;
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub(crate) struct SpeakerUpdate {
    pub turn: u64,
    pub speaker: Option<String>,
    #[serde(rename = "final")]
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LiveSpeakerEvent {
    Update(SpeakerUpdate),
    Error(String),
}

enum Message {
    Audio { turn: u64, samples: Vec<f32> },
    End { turn: u64 },
}

pub(crate) struct LiveSpeakerHandle {
    tx: SyncSender<Message>,
    done: Receiver<()>,
    active: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
}

impl LiveSpeakerHandle {
    pub(crate) fn spawn(
        model: Box<dyn LiveSpeakerModel>,
        emit: impl FnMut(LiveSpeakerEvent) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel(LIVE_SPEAKER_QUEUE_MESSAGES);
        let (done_tx, done) = mpsc::channel();
        let active = Arc::new(AtomicBool::new(true));
        let worker_active = active.clone();
        std::thread::Builder::new()
            .name("live-speakers".into())
            .spawn(move || {
                run_worker(model, rx, worker_active, emit);
                let _ = done_tx.send(());
            })
            .expect("failed to spawn the live-speakers thread");
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

    pub(crate) fn end_turn(&self, turn: u64) {
        self.send(Message::End { turn });
    }

    pub(crate) fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    fn send(&self, message: Message) {
        if self.tx.try_send(message).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Let the worker finish what is queued (the last turn's label), up to
    /// the deadline. Returns false if it had not exited by then, in which
    /// case it is muted and left to finish on its own.
    pub(crate) fn stop(self, deadline: Duration) -> bool {
        let Self { tx, done, active, .. } = self;
        drop(tx);
        let finished = done.recv_timeout(deadline).is_ok();
        active.store(false, Ordering::Release);
        finished
    }
}

fn run_worker(
    mut model: Box<dyn LiveSpeakerModel>,
    rx: Receiver<Message>,
    active: Arc<AtomicBool>,
    mut emit: impl FnMut(LiveSpeakerEvent),
) {
    let mut failed = false;
    if let Err(error) = model.reset() {
        failed = true;
        emit(LiveSpeakerEvent::Error(error));
    }
    let mut open_turn: Option<u64> = None;
    let mut provisional: Option<usize> = None;

    // Close `turn` and report its speaker. Returns false after a model error.
    let finish = |model: &mut Box<dyn LiveSpeakerModel>,
                      emit: &mut dyn FnMut(LiveSpeakerEvent),
                      turn: u64|
     -> bool {
        match model.end_turn() {
            Ok(counts) => {
                if active.load(Ordering::Acquire) {
                    emit(LiveSpeakerEvent::Update(SpeakerUpdate {
                        turn,
                        speaker: dominant_slot(&counts).map(speaker_name),
                        is_final: true,
                    }));
                }
                true
            }
            Err(error) => {
                if active.load(Ordering::Acquire) {
                    emit(LiveSpeakerEvent::Error(error));
                }
                false
            }
        }
    };

    while let Ok(message) = rx.recv() {
        if failed || !active.load(Ordering::Acquire) {
            continue;
        }
        match message {
            Message::End { turn } => {
                if open_turn == Some(turn) {
                    open_turn = None;
                    provisional = None;
                    failed = !finish(&mut model, &mut emit, turn);
                }
            }
            Message::Audio { turn, samples } => {
                if open_turn != Some(turn) {
                    // The previous turn's End was dropped: close it here so
                    // its label is still reported and its frames cannot be
                    // counted towards this turn.
                    if let Some(previous) = open_turn.take() {
                        if !finish(&mut model, &mut emit, previous) {
                            failed = true;
                            continue;
                        }
                    }
                    open_turn = Some(turn);
                    provisional = None;
                }
                match model.feed(&samples) {
                    Ok(counts) => {
                        let leader = dominant_slot(&counts);
                        if leader.is_some() && leader != provisional && active.load(Ordering::Acquire) {
                            provisional = leader;
                            emit(LiveSpeakerEvent::Update(SpeakerUpdate {
                                turn,
                                speaker: leader.map(speaker_name),
                                is_final: false,
                            }));
                        }
                    }
                    Err(error) => {
                        failed = true;
                        if active.load(Ordering::Acquire) {
                            emit(LiveSpeakerEvent::Error(error));
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct Script {
        calls: Vec<String>,
        /// Per-feed counts returned in order; the last repeats.
        feeds: Vec<SlotCounts>,
        /// Per-turn final counts returned in order; the last repeats.
        finals: Vec<SlotCounts>,
        fed: usize,
        ended: usize,
        fail_on_feed: Option<usize>,
    }

    struct FakeModel {
        script: Arc<Mutex<Script>>,
        gate: Option<mpsc::Receiver<()>>,
    }

    impl LiveSpeakerModel for FakeModel {
        fn reset(&mut self) -> Result<(), String> {
            self.script.lock().unwrap().calls.push("reset".into());
            Ok(())
        }

        fn feed(&mut self, samples: &[f32]) -> Result<SlotCounts, String> {
            if let Some(gate) = &self.gate {
                let _ = gate.recv();
            }
            let mut script = self.script.lock().unwrap();
            script.fed += 1;
            if script.fail_on_feed == Some(script.fed) {
                return Err("model exploded".into());
            }
            script.calls.push(format!("feed:{}", samples.len()));
            let index = (script.fed - 1).min(script.feeds.len().saturating_sub(1));
            Ok(script.feeds.get(index).copied().unwrap_or([0; 4]))
        }

        fn end_turn(&mut self) -> Result<SlotCounts, String> {
            let mut script = self.script.lock().unwrap();
            script.ended += 1;
            script.calls.push("end".into());
            let index = (script.ended - 1).min(script.finals.len().saturating_sub(1));
            Ok(script.finals.get(index).copied().unwrap_or([0; 4]))
        }
    }

    fn spawn_with(
        script: Arc<Mutex<Script>>,
        gate: Option<mpsc::Receiver<()>>,
    ) -> (LiveSpeakerHandle, mpsc::Receiver<LiveSpeakerEvent>) {
        let (tx, rx) = mpsc::channel();
        let handle = LiveSpeakerHandle::spawn(Box::new(FakeModel { script, gate }), move |event| {
            let _ = tx.send(event);
        });
        (handle, rx)
    }

    fn next(rx: &mpsc::Receiver<LiveSpeakerEvent>) -> LiveSpeakerEvent {
        rx.recv_timeout(Duration::from_secs(2)).expect("expected an event")
    }

    fn update(turn: u64, speaker: Option<&str>, is_final: bool) -> LiveSpeakerEvent {
        LiveSpeakerEvent::Update(SpeakerUpdate {
            turn,
            speaker: speaker.map(str::to_string),
            is_final,
        })
    }

    #[test]
    fn dominant_slot_needs_a_minimum_and_breaks_ties_low() {
        assert_eq!(dominant_slot(&[0, 0, 0, 0]), None);
        assert_eq!(dominant_slot(&[2, 2, 0, 0]), None);
        assert_eq!(dominant_slot(&[3, 0, 0, 0]), Some(0));
        assert_eq!(dominant_slot(&[3, 9, 0, 0]), Some(1));
        assert_eq!(dominant_slot(&[5, 5, 0, 0]), Some(0));
        assert_eq!(dominant_slot(&[0, 0, 4, 12]), Some(3));
    }

    #[test]
    fn the_final_update_carries_the_wire_name_final() {
        let json = serde_json::to_value(SpeakerUpdate {
            turn: 2,
            speaker: Some("Speaker 1".into()),
            is_final: true,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({"turn": 2, "speaker": "Speaker 1", "final": true}));
    }

    #[test]
    fn a_turn_reports_its_leader_on_change_and_its_speaker_at_the_end() {
        let script = Arc::new(Mutex::new(Script {
            feeds: vec![[1, 0, 0, 0], [4, 0, 0, 0], [5, 0, 0, 0], [5, 9, 0, 0]],
            finals: vec![[5, 12, 0, 0]],
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script.clone(), None);

        for _ in 0..4 {
            handle.audio(1, vec![0.0; 4]);
        }
        handle.end_turn(1);

        assert_eq!(next(&rx), update(1, Some("Speaker 1"), false));
        assert_eq!(next(&rx), update(1, Some("Speaker 2"), false));
        assert_eq!(next(&rx), update(1, Some("Speaker 2"), true));
        assert!(handle.stop(Duration::from_secs(2)));
        assert_eq!(script.lock().unwrap().calls[0], "reset");
    }

    #[test]
    fn a_turn_nobody_dominated_ends_without_a_speaker() {
        let script = Arc::new(Mutex::new(Script {
            finals: vec![[1, 2, 0, 0]],
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script, None);
        handle.audio(1, vec![0.0; 4]);
        handle.end_turn(1);
        assert_eq!(next(&rx), update(1, None, true));
        assert!(handle.stop(Duration::from_secs(2)));
    }

    #[test]
    fn an_unclosed_turn_is_closed_when_the_next_one_starts() {
        let script = Arc::new(Mutex::new(Script {
            finals: vec![[6, 0, 0, 0], [0, 6, 0, 0]],
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script.clone(), None);

        handle.audio(1, vec![0.0; 4]);
        // No end_turn(1): its End was dropped.
        handle.audio(2, vec![0.0; 4]);
        handle.end_turn(2);

        assert_eq!(next(&rx), update(1, Some("Speaker 1"), true));
        assert_eq!(next(&rx), update(2, Some("Speaker 2"), true));
        assert!(handle.stop(Duration::from_secs(2)));
        let calls = script.lock().unwrap().calls.clone();
        assert_eq!(calls, vec!["reset", "feed:4", "end", "feed:4", "end"]);
    }

    #[test]
    fn an_end_for_a_turn_that_never_opened_is_ignored() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (handle, rx) = spawn_with(script.clone(), None);
        handle.end_turn(7);
        assert!(handle.stop(Duration::from_secs(2)));
        assert!(rx.try_recv().is_err());
        assert_eq!(script.lock().unwrap().ended, 0);
    }

    #[test]
    fn stop_lets_the_last_turns_label_through() {
        let script = Arc::new(Mutex::new(Script {
            finals: vec![[8, 0, 0, 0]],
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script, None);
        handle.audio(1, vec![0.0; 4]);
        handle.end_turn(1);
        assert!(handle.stop(Duration::from_secs(2)));
        assert_eq!(next(&rx), update(1, Some("Speaker 1"), true));
    }

    #[test]
    fn a_full_queue_drops_audio_without_blocking_the_sender() {
        let script = Arc::new(Mutex::new(Script::default()));
        let (gate_tx, gate_rx) = mpsc::channel();
        let (handle, _rx) = spawn_with(script, Some(gate_rx));

        let started = Instant::now();
        for _ in 0..(LIVE_SPEAKER_QUEUE_MESSAGES * 3) {
            handle.audio(1, vec![0.0; 4]);
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        assert!(handle.dropped() > 0);

        drop(gate_tx);
        assert!(handle.stop(Duration::from_secs(2)));
    }

    #[test]
    fn a_model_error_is_reported_once_and_later_input_is_ignored() {
        let script = Arc::new(Mutex::new(Script {
            fail_on_feed: Some(1),
            ..Script::default()
        }));
        let (handle, rx) = spawn_with(script.clone(), None);
        handle.audio(1, vec![0.0; 4]);
        assert_eq!(next(&rx), LiveSpeakerEvent::Error("model exploded".into()));
        handle.audio(1, vec![0.0; 4]);
        handle.end_turn(1);
        assert!(handle.stop(Duration::from_secs(2)));
        assert!(rx.try_recv().is_err());
        assert_eq!(script.lock().unwrap().ended, 0);
    }

    #[test]
    fn stop_gives_up_at_the_deadline_and_a_detached_worker_stays_silent() {
        let script = Arc::new(Mutex::new(Script {
            feeds: vec![[9, 0, 0, 0]],
            ..Script::default()
        }));
        let (gate_tx, gate_rx) = mpsc::channel();
        let (handle, rx) = spawn_with(script, Some(gate_rx));

        handle.audio(1, vec![0.0; 4]);
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        assert!(!handle.stop(Duration::from_millis(100)));
        assert!(started.elapsed() < Duration::from_secs(1));

        drop(gate_tx);
        std::thread::sleep(Duration::from_millis(100));
        assert!(rx.try_recv().is_err(), "a stopped worker must not emit");
    }
}
