//! One turn counter feeding the live-text and speaker-label workers.
//! Turns are numbered whether or not either worker exists, so
//! `speech-detected` always carries a turn.

use super::live_speakers::LiveSpeakerHandle;
use super::live_text::LiveTextHandle;
use std::time::Duration;
use tracing::warn;

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
        self.turn += 1;
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
    fn turns_number_from_one_and_reach_both_workers() {
        let (text_tx, text_rx) = mpsc::channel();
        let (speaker_tx, speaker_rx) = mpsc::channel();
        let text = LiveTextHandle::spawn(Box::new(CountingText(0)), move |event| {
            let _ = text_tx.send(event);
        });
        let speakers = LiveSpeakerHandle::spawn(Box::new(FixedSpeaker), move |event| {
            let _ = speaker_tx.send(event);
        });
        let mut feeds = TurnFeeds::new(Some(text), Some(speakers));

        assert_eq!(feeds.current(), 0);
        feeds.audio(vec![0.0; 9]); // before any turn: ignored
        assert_eq!(feeds.begin(vec![0.0; 8]), 1);
        feeds.audio(vec![0.0; 4]);
        feeds.end();
        feeds.end(); // idempotent
        feeds.audio(vec![0.0; 9]); // between turns: ignored
        assert_eq!(feeds.begin(Vec::new()), 2);
        feeds.audio(vec![0.0; 4]);
        feeds.stop(Duration::from_secs(2)); // closes turn 2

        let texts: Vec<LiveTextEvent> = text_rx.try_iter().collect();
        assert_eq!(
            texts,
            vec![
                LiveTextEvent::Partial(LiveTextPartial { turn: 1, text: "t1".into() }),
                LiveTextEvent::Partial(LiveTextPartial { turn: 1, text: "t2".into() }),
                LiveTextEvent::Partial(LiveTextPartial { turn: 2, text: "t1".into() }),
            ]
        );
        let finals: Vec<LiveSpeakerEvent> = speaker_rx.try_iter().collect();
        let expected = |turn| {
            LiveSpeakerEvent::Update(SpeakerUpdate {
                turn,
                speaker: Some("Speaker 2".into()),
                is_final: true,
            })
        };
        assert_eq!(finals, vec![expected(1), expected(2)]);
    }

    #[test]
    fn turns_still_count_without_workers() {
        let mut feeds = TurnFeeds::new(None, None);
        assert_eq!(feeds.begin(vec![0.0; 8]), 1);
        feeds.audio(vec![0.0; 4]);
        feeds.end();
        assert_eq!(feeds.begin(Vec::new()), 2);
        feeds.stop(Duration::from_millis(10));
    }
}
