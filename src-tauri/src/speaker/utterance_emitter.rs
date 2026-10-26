//! Finished utterances leave the capture loop through one worker thread.
//!
//! Preparing an utterance (gain, resampling the whole turn for the local
//! model, caching it) takes about half a second for a long turn. Done inline,
//! the capture loop stopped reading audio for that long at the end of every
//! long turn. One thread keeps utterances in order; the loop only queues them.

use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

pub(crate) struct UtteranceEmitter<J: Send + 'static> {
    tx: Option<mpsc::Sender<J>>,
    worker: Option<JoinHandle<()>>,
    /// Signalled when the worker has emitted everything and exited.
    done: Option<mpsc::Receiver<()>>,
}

impl<J: Send + 'static> UtteranceEmitter<J> {
    pub(crate) fn spawn(mut handle: impl FnMut(J) + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel::<J>();
        let (done_tx, done) = mpsc::channel::<()>();
        let worker = std::thread::Builder::new()
            .name("utterance-emitter".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    handle(job);
                }
                let _ = done_tx.send(());
            })
            .ok();
        if worker.is_none() {
            tracing::error!("Could not start the utterance thread; utterances will be dropped");
        }
        Self {
            tx: worker.as_ref().map(|_| tx),
            done: worker.as_ref().map(|_| done),
            worker,
        }
    }

    /// Queue an utterance. Never waits for earlier ones to finish.
    pub(crate) fn send(&self, job: J) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(job);
        }
    }

    /// Emit everything queued, then stop. Blocks, so call it off the async
    /// runtime.
    #[cfg(test)]
    pub(crate) fn finish(mut self) {
        self.tx.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }

    /// Stop taking utterances and wait up to `deadline` for the queued ones
    /// to go out. Past the deadline the thread is left to finish them on its
    /// own, so a stop under heavy load returns on time. Returns whether
    /// everything went out in time. Blocks: call it off the async runtime.
    pub(crate) fn finish_within(mut self, deadline: Duration) -> bool {
        self.tx.take();
        let finished = self
            .done
            .take()
            .is_none_or(|done| done.recv_timeout(deadline).is_ok());
        if finished {
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
        finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    #[test]
    fn utterances_are_handled_in_the_order_they_were_queued() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let emitter = UtteranceEmitter::spawn(move |turn: u32| sink.lock().unwrap().push(turn));
        for turn in 1..=50 {
            emitter.send(turn);
        }
        emitter.finish();
        assert_eq!(*seen.lock().unwrap(), (1..=50).collect::<Vec<_>>());
    }

    #[test]
    fn queueing_does_not_wait_for_a_slow_utterance() {
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let emitter = UtteranceEmitter::spawn(move |_: u32| {
            let _ = gate_rx.recv();
        });
        let started = Instant::now();
        for turn in 0..10 {
            emitter.send(turn);
        }
        assert!(started.elapsed() < Duration::from_millis(50));
        for _ in 0..10 {
            gate_tx.send(()).unwrap();
        }
        emitter.finish();
    }

    #[test]
    fn finishing_gives_up_at_its_deadline_and_the_rest_still_goes_out() {
        let seen = Arc::new(Mutex::new(0));
        let sink = seen.clone();
        let emitter = UtteranceEmitter::spawn(move |_: u32| {
            std::thread::sleep(Duration::from_millis(100));
            *sink.lock().unwrap() += 1;
        });
        for turn in 0..10 {
            emitter.send(turn);
        }
        let started = Instant::now();
        assert!(!emitter.finish_within(Duration::from_millis(250)));
        assert!(started.elapsed() < Duration::from_millis(400));
        // Left running, the thread still emits everything queued.
        std::thread::sleep(Duration::from_millis(1_200));
        assert_eq!(*seen.lock().unwrap(), 10);
    }

    #[test]
    fn finishing_emits_what_is_still_queued() {
        let seen = Arc::new(Mutex::new(0));
        let sink = seen.clone();
        let emitter = UtteranceEmitter::spawn(move |_: u32| {
            std::thread::sleep(Duration::from_millis(20));
            *sink.lock().unwrap() += 1;
        });
        for turn in 0..5 {
            emitter.send(turn);
        }
        emitter.finish();
        assert_eq!(*seen.lock().unwrap(), 5);
    }
}
