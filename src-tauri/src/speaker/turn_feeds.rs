//! One turn counter feeding the live-text and speaker-label workers.
//! Turns are numbered whether or not either worker exists, so
//! `speech-detected` always carries a turn.
//!
//! Turn numbers are unique for the life of the process, not per capture: the
//! frontend keys labels and provisional text by turn, and a capture restarted
//! mid-session (mode switch, device change) must not reuse an earlier turn's
//! number.

use super::live_speakers::LiveSpeakerHandle;
use super::live_text::LiveTextHandle;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tracing::warn;

static NEXT_TURN: AtomicU64 = AtomicU64::new(1);

pub(crate) struct TurnFeeds {
    text: Option<LiveTextHandle>,
    speakers: Option<LiveSpeakerHandle>,
    turn: u64,
    in_turn: bool,
}

impl TurnFeeds {
    pub(crate) fn new(text: Option<LiveTextHandle>, speakers: Option<LiveSpeakerHandle>) -> Self {
        Self {
            text,
            speakers,
            turn: 0,
            in_turn: false,
        }
    }

    /// Start the next turn with the audio that preceded the detection.
    pub(crate) fn begin(&mut self, lead_in_16k: Vec<f32>) -> u64 {
        self.turn = NEXT_TURN.fetch_add(1, Ordering::Relaxed);
        self.in_turn = true;
        self.audio(lead_in_16k);
        self.turn
    }

    pub(crate) fn audio(&self, samples_16k: Vec<f32>) {
        if !self.in_turn || samples_16k.is_empty() {
            return;
        }
        match (&self.text, &self.speakers) {
            (Some(text), Some(speakers)) => {
                text.audio(self.turn, samples_16k.clone());
                speakers.audio(self.turn, samples_16k);
            }
            (Some(text), None) => text.audio(self.turn, samples_16k),
            (None, Some(speakers)) => speakers.audio(self.turn, samples_16k),
            (None, None) => {}
        }
    }

    pub(crate) fn end(&mut self) {
        if !self.in_turn {
            return;
        }
        self.in_turn = false;
        if let Some(text) = &self.text {
            text.end_turn();
        }
        if let Some(speakers) = &self.speakers {
            speakers.end_turn(self.turn);
        }
    }

    pub(crate) fn current(&self) -> u64 {
        self.turn
    }

    /// Close any open turn and stop both workers, each within `deadline`.
    pub(crate) fn stop(mut self, deadline: Duration) {
        self.end();
        if let Some(text) = self.text.take() {
            let dropped = text.dropped();
            if dropped > 0 {
                warn!("Live text fell behind and skipped {dropped} audio messages this capture");
            }
            if !text.stop(deadline) {
                warn!("Live-text worker did not stop within the deadline; left to finish muted");
            }
        }
        if let Some(speakers) = self.speakers.take() {
            let dropped = speakers.dropped();
            if dropped > 0 {
                warn!("Speaker labels fell behind and skipped {dropped} audio messages this capture");
            }
            if !speakers.stop(deadline) {
                warn!("Speaker-label worker did not stop within the deadline; left to finish muted");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speaker::live_speakers::{LiveSpeakerEvent, LiveSpeakerModel, SlotCounts, SpeakerUpdate};
    use crate::speaker::live_text::{LiveTextEvent, LiveTextModel, LiveTextPartial};
    use std::sync::mpsc;

    struct CountingText(usize);
    impl LiveTextModel for CountingText {
        fn reset(&mut self) -> Result<(), String> {
            self.0 = 0;
            Ok(())
        }
        fn feed(&mut self, _samples: &[f32]) -> Result<String, String> {
            self.0 += 1;
            Ok(format!("t{}", self.0))
        }
    }

    struct FixedSpeaker;
    impl LiveSpeakerModel for FixedSpeaker {
        fn reset(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn feed(&mut self, _samples: &[f32]) -> Result<SlotCounts, String> {
            Ok([0; 4])
        }
        fn end_turn(&mut self) -> Result<SlotCounts, String> {
            Ok([0, 7, 0, 0])
        }
    }

    #[test]
    fn turns_are_numbered_uniquely_and_reach_both_workers() {
        let (text_tx, text_rx) = mpsc::channel();
        let (speaker_tx, speaker_rx) = mpsc::channel();
        let text = LiveTextHandle::spawn(Box::new(CountingText(0)), move |event| {
            let _ = text_tx.send(event);
        });
        let speakers = LiveSpeakerHandle::spawn(Box::new(FixedSpeaker), move |event| {
            let _ = speaker_tx.send(event);
        });
        let mut feeds = TurnFeeds::new(Some(text), Some(speakers));
        // Each buffer is larger than a worker batch, so each is fed at once.
        let piece = || vec![0.0; 6_000];

        assert_eq!(feeds.current(), 0);
        feeds.audio(piece()); // before any turn: ignored
        let first = feeds.begin(piece());
        assert_eq!(feeds.current(), first);
        feeds.audio(piece());
        feeds.end();
        feeds.end(); // idempotent
        feeds.audio(piece()); // between turns: ignored
        let second = feeds.begin(Vec::new());
        assert!(second > first);
        feeds.audio(piece());
        feeds.stop(Duration::from_secs(2)); // closes the second turn

        let texts: Vec<LiveTextEvent> = text_rx.try_iter().collect();
        let partial = |turn, text: &str| {
            LiveTextEvent::Partial(LiveTextPartial { turn, text: text.into() })
        };
        assert_eq!(
            texts,
            vec![partial(first, "t1"), partial(first, "t2"), partial(second, "t1")]
        );
        let finals: Vec<LiveSpeakerEvent> = speaker_rx.try_iter().collect();
        let expected = |turn| {
            LiveSpeakerEvent::Update(SpeakerUpdate {
                turn,
                speaker: Some("Speaker 2".into()),
                is_final: true,
            })
        };
        assert_eq!(finals, vec![expected(first), expected(second)]);
    }

    #[test]
    fn a_new_capture_never_reuses_an_earlier_turn_number() {
        let mut earlier = TurnFeeds::new(None, None);
        let last_of_earlier = earlier.begin(Vec::new());
        earlier.stop(Duration::from_millis(10));

        let mut restarted = TurnFeeds::new(None, None);
        assert!(restarted.begin(Vec::new()) > last_of_earlier);
        restarted.stop(Duration::from_millis(10));
    }

    #[test]
    fn turns_still_count_without_workers() {
        let mut feeds = TurnFeeds::new(None, None);
        let first = feeds.begin(vec![0.0; 8]);
        feeds.audio(vec![0.0; 4]);
        feeds.end();
        assert!(feeds.begin(Vec::new()) > first);
        feeds.stop(Duration::from_millis(10));
    }
}
