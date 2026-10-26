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

/// Capture backlog past which the live workers stop getting audio, and the
/// backlog under which they get it again. They are previews competing with
/// the capture loop for the same CPU and Neural Engine; the final transcript
/// does not depend on them.
const LIVE_PAUSE_BEHIND_SECS: f32 = 1.5;
const LIVE_RESUME_BEHIND_SECS: f32 = 0.5;

/// Whether the live workers should be held back, given whether they were
/// and the capture backlog. Hysteresis keeps them from flapping.
pub(crate) fn live_feeds_behind(was_behind: bool, backlog_samples: usize, sr: u32) -> bool {
    let secs = backlog_samples as f32 / sr as f32;
    if was_behind {
        secs >= LIVE_RESUME_BEHIND_SECS
    } else {
        secs > LIVE_PAUSE_BEHIND_SECS
    }
}

pub(crate) struct TurnFeeds {
    text: Option<LiveTextHandle>,
    speakers: Option<LiveSpeakerHandle>,
    turn: u64,
    in_turn: bool,
    /// The capture loop is behind; set by `set_behind`.
    behind: bool,
    /// The current turn gets no more live audio. Set when the loop falls
    /// behind and kept to the turn's end: resuming mid-turn would feed the
    /// models audio with a hole in it.
    paused: bool,
}

impl TurnFeeds {
    pub(crate) fn new(text: Option<LiveTextHandle>, speakers: Option<LiveSpeakerHandle>) -> Self {
        Self {
            text,
            speakers,
            turn: 0,
            in_turn: false,
            behind: false,
            paused: false,
        }
    }

    /// Report whether the capture loop is behind (see `live_feeds_behind`).
    pub(crate) fn set_behind(&mut self, behind: bool) {
        self.behind = behind;
        if behind {
            self.paused = true;
        }
    }

    /// Start the next turn with the audio that preceded the detection.
    pub(crate) fn begin(&mut self, lead_in_16k: Vec<f32>) -> u64 {
        self.turn = NEXT_TURN.fetch_add(1, Ordering::Relaxed);
        self.in_turn = true;
        self.paused = self.behind;
        self.audio(lead_in_16k);
        self.turn
    }

    pub(crate) fn audio(&self, samples_16k: Vec<f32>) {
        if !self.in_turn || self.paused || samples_16k.is_empty() {
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
    fn falling_behind_pauses_the_rest_of_the_turn_and_catching_up_resumes_at_the_next() {
        let (text_tx, text_rx) = mpsc::channel();
        let text = LiveTextHandle::spawn(Box::new(CountingText(0)), move |event| {
            let _ = text_tx.send(event);
        });
        let mut feeds = TurnFeeds::new(Some(text), None);
        let piece = || vec![0.0; 6_000];

        let first = feeds.begin(piece()); // fed: t1
        feeds.set_behind(true);
        feeds.audio(piece()); // paused
        feeds.set_behind(false);
        feeds.audio(piece()); // still paused: the turn already has a hole
        feeds.end();

        feeds.set_behind(true);
        let second = feeds.begin(piece()); // starts paused while behind
        feeds.audio(piece());
        feeds.end();

        feeds.set_behind(false);
        let third = feeds.begin(piece()); // caught up: fed again
        feeds.stop(Duration::from_secs(2));

        let texts: Vec<LiveTextEvent> = text_rx.try_iter().collect();
        let partial = |turn, text: &str| {
            LiveTextEvent::Partial(LiveTextPartial { turn, text: text.into() })
        };
        assert_eq!(texts, vec![partial(first, "t1"), partial(third, "t1")]);
        assert!(second > first && third > second);
    }

    #[test]
    fn live_feeds_pause_past_a_second_and_a_half_behind_and_resume_under_half() {
        let sr = 48_000;
        assert!(!live_feeds_behind(false, sr * 3 / 2, 48_000));
        assert!(live_feeds_behind(false, sr * 3 / 2 + 1, 48_000));
        // Hysteresis: once behind, stay behind until under half a second.
        assert!(live_feeds_behind(true, sr, 48_000));
        assert!(live_feeds_behind(true, sr / 2, 48_000));
        assert!(!live_feeds_behind(true, sr / 2 - 1, 48_000));
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
