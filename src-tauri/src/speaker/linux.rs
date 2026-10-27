// Assistant linux speaker input and stream
use super::AudioDevice;
use anyhow::{anyhow, Result};
use futures_util::Stream;
use libpulse_binding as pulse;
use libpulse_simple_binding as psimple;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};
use std::thread;
use std::time::Duration;
use tracing::error;

use psimple::Simple;
use pulse::context::introspect::Introspector;
use pulse::context::Context;
use pulse::mainloop::standard::Mainloop;
use pulse::sample::{Format, Spec};
use pulse::stream::Direction;

const DEFAULT_SAMPLE_RATE: u32 = 44_100;

/// How much audio the capture queue holds while the reader is stalled. The
/// capture loop skips ahead long before it fills (see `catch_up_skip` in
/// commands.rs); a full queue drops the oldest audio, counts it, and capture
/// carries on.
const CAPTURE_QUEUE_SECS: usize = 60;

fn capture_queue_capacity(sample_rate: u32) -> usize {
    sample_rate as usize * CAPTURE_QUEUE_SECS
}

/// Whether a saved output device (a PulseAudio sink name) is still present.
/// A sink that was unplugged would otherwise be tapped as `<name>.monitor`
/// and fail to open; the caller can follow the default instead.
pub(crate) fn device_listed(uid: &str, devices: &[AudioDevice]) -> bool {
    devices.iter().any(|device| device.id == uid)
}

/// Append captured samples, dropping the oldest past `capacity` and adding
/// how many to `dropped`. The reader reports drops; this never logs, so a
/// stall cannot flood the log.
fn queue_captured(
    queue: &Mutex<VecDeque<f32>>,
    samples: &[f32],
    capacity: usize,
    dropped: &AtomicU64,
) {
    let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
    queue.extend(samples.iter());
    if queue.len() > capacity {
        let excess = queue.len() - capacity;
        queue.drain(..excess);
        dropped.fetch_add(excess as u64, Ordering::Relaxed);
    }
}

pub fn get_input_devices() -> Result<Vec<AudioDevice>> {
    let devices = Rc::new(RefCell::new(Vec::new()));
    let done = Rc::new(RefCell::new(false));

    let mut mainloop =
        Mainloop::new().ok_or_else(|| anyhow!("Failed to create PulseAudio mainloop"))?;
    let mut context = Context::new(&mainloop, "assistant-device-enum")
        .ok_or_else(|| anyhow!("Failed to create PulseAudio context"))?;

    context
        .connect(None, pulse::context::FlagSet::NOFLAGS, None)
        .map_err(|_| anyhow!("Failed to connect to PulseAudio"))?;

    loop {
        match mainloop.iterate(true) {
            pulse::mainloop::standard::IterateResult::Success(_) => {}
            _ => return Err(anyhow!("Failed to iterate mainloop")),
        }

        match context.get_state() {
            pulse::context::State::Ready => break,
            pulse::context::State::Failed | pulse::context::State::Terminated => {
                return Err(anyhow!("PulseAudio context failed"));
            }
            _ => {}
        }
    }

    let default_source: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let default_source_clone = default_source.clone();
    let done_clone = done.clone();

    let introspector = context.introspect();

    let op = introspector.get_server_info(move |info| {
        if let Some(name) = &info.default_source_name {
            *default_source_clone.borrow_mut() = Some(name.to_string());
        }
        *done_clone.borrow_mut() = true;
    });

    while !*done.borrow() {
        match mainloop.iterate(true) {
            pulse::mainloop::standard::IterateResult::Success(_) => {}
            _ => break,
        }
    }
    drop(op);

    *done.borrow_mut() = false;
    let devices_clone = devices.clone();
    let done_clone = done.clone();
    let default_source_name = default_source.borrow().clone();

    let op = introspector.get_source_info_list(move |result| match result {
        pulse::callbacks::ListResult::Item(info) => {
            if let Some(name) = &info.name {
                if !name.contains(".monitor") {
                    let device_name = info
                        .description
                        .as_ref()
                        .map(|d| d.to_string())
                        .unwrap_or_else(|| name.to_string());
                    let device_id = name.to_string();
                    let is_default = default_source_name
                        .as_ref()
                        .map(|def| def == &device_id)
                        .unwrap_or(false);

                    devices_clone.borrow_mut().push(AudioDevice {
                        id: device_id,
                        name: device_name,
                        is_default,
                    });
                }
            }
        }
        pulse::callbacks::ListResult::End => {
            *done_clone.borrow_mut() = true;
        }
        pulse::callbacks::ListResult::Error => {
            *done_clone.borrow_mut() = true;
        }
    });

    while !*done.borrow() {
        match mainloop.iterate(true) {
            pulse::mainloop::standard::IterateResult::Success(_) => {}
            _ => break,
        }
    }
    drop(op);

    context.disconnect();
    mainloop.quit(pulse::def::Retval(0));

    Ok(Rc::try_unwrap(devices).unwrap().into_inner())
}

pub fn get_output_devices() -> Result<Vec<AudioDevice>> {
    let devices = Rc::new(RefCell::new(Vec::new()));
    let done = Rc::new(RefCell::new(false));

    let mut mainloop =
        Mainloop::new().ok_or_else(|| anyhow!("Failed to create PulseAudio mainloop"))?;
    let mut context = Context::new(&mainloop, "assistant-device-enum")
        .ok_or_else(|| anyhow!("Failed to create PulseAudio context"))?;

    context
        .connect(None, pulse::context::FlagSet::NOFLAGS, None)
        .map_err(|_| anyhow!("Failed to connect to PulseAudio"))?;

    loop {
        match mainloop.iterate(true) {
            pulse::mainloop::standard::IterateResult::Success(_) => {}
            _ => return Err(anyhow!("Failed to iterate mainloop")),
        }

        match context.get_state() {
            pulse::context::State::Ready => break,
            pulse::context::State::Failed | pulse::context::State::Terminated => {
                return Err(anyhow!("PulseAudio context failed"));
            }
            _ => {}
        }
    }

    // Get default sink for comparison
    let default_sink: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let default_sink_clone = default_sink.clone();
    let done_clone = done.clone();

    let introspector = context.introspect();

    let op = introspector.get_server_info(move |info| {
        if let Some(name) = &info.default_sink_name {
            *default_sink_clone.borrow_mut() = Some(name.to_string());
        }
        *done_clone.borrow_mut() = true;
    });

    while !*done.borrow() {
        match mainloop.iterate(true) {
            pulse::mainloop::standard::IterateResult::Success(_) => {}
            _ => break,
        }
    }
    drop(op);

    *done.borrow_mut() = false;
    let devices_clone = devices.clone();
    let done_clone = done.clone();
    let default_sink_name = default_sink.borrow().clone();

    let op = introspector.get_sink_info_list(move |result| match result {
        pulse::callbacks::ListResult::Item(info) => {
            if let Some(name) = &info.name {
                let device_name = info
                    .description
                    .as_ref()
                    .map(|d| d.to_string())
                    .unwrap_or_else(|| name.to_string());
                let device_id = name.to_string();
                let is_default = default_sink_name
                    .as_ref()
                    .map(|def| def == &device_id)
                    .unwrap_or(false);

                devices_clone.borrow_mut().push(AudioDevice {
                    id: device_id,
                    name: device_name,
                    is_default,
                });
            }
        }
        pulse::callbacks::ListResult::End => {
            *done_clone.borrow_mut() = true;
        }
        pulse::callbacks::ListResult::Error => {
            *done_clone.borrow_mut() = true;
        }
    });

    while !*done.borrow() {
        match mainloop.iterate(true) {
            pulse::mainloop::standard::IterateResult::Success(_) => {}
            _ => break,
        }
    }
    drop(op);

    context.disconnect();
    mainloop.quit(pulse::def::Retval(0));

    Ok(Rc::try_unwrap(devices).unwrap().into_inner())
}

pub struct SpeakerInput {
    source_name: Option<String>,
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        // For Linux, device_id is the PulseAudio sink name for output devices
        let source_name = match device_id {
            Some(ref id) if !id.is_empty() && id != "default" => {
                let monitor = format!("{}.monitor", id);
                Some(monitor)
            }
            _ => None,
        };
        Ok(Self { source_name })
    }

    // The rate is only known once the capture loop opens the device.
    pub fn sample_rate(&self) -> Option<u32> {
        None
    }

    pub fn stream(self) -> Result<SpeakerStream> {
        let sample_queue = Arc::new(Mutex::new(VecDeque::new()));
        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
            shutdown: false,
        }));
        let (init_tx, init_rx) = std::sync::mpsc::channel();

        let dropped = Arc::new(AtomicU64::new(0));
        let queue_clone = sample_queue.clone();
        let waker_clone = waker_state.clone();
        let dropped_clone = dropped.clone();
        let source_name = self.source_name;

        let mut capture_thread = Some(thread::spawn(move || {
            if let Err(e) = SpeakerStream::capture_audio_loop(
                queue_clone,
                waker_clone,
                dropped_clone,
                source_name.as_deref(),
                init_tx,
            ) {
                tracing::warn!("Audio capture loop failed: {}", e);
            }
        }));

        let init_result = init_rx.recv_timeout(Duration::from_secs(5));
        let (sample_rate, init_error) = match init_result {
            Ok(Ok(sr)) => (sr, None),
            Ok(Err(e)) => {
                let msg = format!("Audio initialization failed: {}", e);
                tracing::warn!("{}", msg);
                (DEFAULT_SAMPLE_RATE, Some(msg))
            }
            Err(e) => {
                let msg = format!("Failed to receive audio init signal: {}", e);
                tracing::warn!("{}", msg);
                (DEFAULT_SAMPLE_RATE, Some(msg))
            }
        };

        if let Some(err) = init_error {
            {
                let mut state = waker_state.lock().unwrap_or_else(|e| e.into_inner());
                state.shutdown = true;
                if let Some(waker) = state.waker.take() {
                    drop(state);
                    waker.wake();
                }
            }

            if let Some(handle) = capture_thread.take() {
                let _ = handle.join();
            }

            return Err(anyhow!(err));
        }

        Ok(SpeakerStream {
            sample_queue,
            waker_state,
            dropped,
            capture_thread,
            sample_rate,
        })
    }
}

struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
    shutdown: bool,
}

pub struct SpeakerStream {
    sample_queue: Arc<Mutex<VecDeque<f32>>>,
    waker_state: Arc<Mutex<WakerState>>,
    dropped: Arc<AtomicU64>,
    capture_thread: Option<thread::JoinHandle<()>>,
    sample_rate: u32,
}

/// Ends a capture stream from outside the task reading it.
pub(crate) struct StreamStopper {
    waker_state: Arc<Mutex<WakerState>>,
}

impl StreamStopper {
    pub(crate) fn stop(&self) {
        let waker = {
            let mut state = self.waker_state.lock().unwrap_or_else(|e| e.into_inner());
            state.shutdown = true;
            state.waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub(crate) fn stopper(&self) -> StreamStopper {
        StreamStopper {
            waker_state: self.waker_state.clone(),
        }
    }

    /// Captured samples waiting to be read.
    pub fn backlog_samples(&self) -> usize {
        self.sample_queue.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Discard up to `count` of the oldest waiting samples; returns how many.
    pub fn skip_samples(&mut self, count: usize) -> usize {
        let mut queue = self.sample_queue.lock().unwrap_or_else(|e| e.into_inner());
        let skipped = count.min(queue.len());
        queue.drain(..skipped);
        skipped
    }

    /// Samples the full queue dropped since the last call.
    pub fn take_dropped_samples(&self) -> u64 {
        self.dropped.swap(0, Ordering::Relaxed)
    }

    fn capture_audio_loop(
        sample_queue: Arc<Mutex<VecDeque<f32>>>,
        waker_state: Arc<Mutex<WakerState>>,
        dropped: Arc<AtomicU64>,
        source_name: Option<&str>,
        init_tx: std::sync::mpsc::Sender<Result<u32>>,
    ) -> Result<()> {
        let spec = Spec {
            format: Format::F32le,
            channels: 1,
            rate: 44100, // Fixed: Use 44100 Hz to match macOS/Windows
        };

        if !spec.is_valid() {
            error!("[capture_audio_loop] Invalid audio specification");
            return Err(anyhow!("Invalid audio specification"));
        }

        let final_source = source_name
            .map(|s| s.to_string())
            .or_else(get_default_monitor_source);

        let init_result: Result<(Simple, u32)> = (|| {
            let simple = Simple::new(
                None,                    // Use default server
                "assistant",             // Application name
                Direction::Record,       // Record direction
                final_source.as_deref(), // Source name (monitor)
                "System Audio Capture",  // Stream description
                &spec,                   // Sample specification
                None,                    // Channel map (use default)
                None,                    // Buffer attributes (use default)
            )
            .map_err(|e| {
                error!(
                    "[capture_audio_loop] Failed to create PulseAudio connection: {}",
                    e
                );
                anyhow!("Failed to create PulseAudio simple connection: {}", e)
            })?;

            Ok((simple, spec.rate))
        })();

        match init_result {
            Ok((simple, sample_rate)) => {
                let _ = init_tx.send(Ok(sample_rate));

                // Buffer for reading audio data (1024 samples * 4 bytes/sample)
                let mut buffer = vec![0u8; 4096];

                loop {
                    if waker_state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .shutdown
                    {
                        break;
                    }

                    match simple.read(&mut buffer) {
                        Ok(_) => {
                            // Convert byte buffer to f32 samples
                            let samples: Vec<f32> = buffer
                                .chunks_exact(4)
                                .map(|chunk| {
                                    f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
                                })
                                .collect();

                            if !samples.is_empty() {
                                queue_captured(
                                    &sample_queue,
                                    &samples,
                                    capture_queue_capacity(sample_rate),
                                    &dropped,
                                );

                                // Wake up consumer
                                {
                                    let mut state =
                                        waker_state.lock().unwrap_or_else(|e| e.into_inner());
                                    if !state.has_data {
                                        state.has_data = true;
                                        if let Some(waker) = state.waker.take() {
                                            drop(state);
                                            waker.wake();
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            error!("[capture_audio_loop] PulseAudio read error: {}", e);
                            thread::sleep(std::time::Duration::from_millis(100));
                        }
                    }
                }
            }
            Err(e) => {
                error!("[capture_audio_loop] PulseAudio init failed: {}", e);
                let _ = init_tx.send(Err(e));
            }
        }
        Ok(())
    }
}

fn get_default_monitor_source() -> Option<String> {
    Some("@DEFAULT_MONITOR@".to_string())
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        {
            let mut state = self.waker_state.lock().unwrap_or_else(|e| e.into_inner());
            state.shutdown = true;
            if let Some(waker) = state.waker.take() {
                waker.wake();
            }
        }
        if let Some(thread) = self.capture_thread.take() {
            let _ = thread.join();
        }
    }
}

impl Stream for SpeakerStream {
    type Item = f32;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let mut queue = self.sample_queue.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sample) = queue.pop_front() {
            return Poll::Ready(Some(sample));
        }

        let mut state = self.waker_state.lock().unwrap_or_else(|e| e.into_inner());
        if state.shutdown {
            return Poll::Ready(None);
        }

        state.has_data = false;
        state.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream_parts() -> (Arc<Mutex<VecDeque<f32>>>, Arc<Mutex<WakerState>>) {
        (
            Arc::new(Mutex::new(VecDeque::new())),
            Arc::new(Mutex::new(WakerState {
                waker: None,
                has_data: false,
                shutdown: false,
            })),
        )
    }

    #[test]
    fn a_full_queue_drops_the_oldest_audio_and_counts_it() {
        let (queue, _) = stream_parts();
        let dropped = AtomicU64::new(0);
        queue_captured(&queue, &[0.1, 0.2, 0.3], 4, &dropped);
        queue_captured(&queue, &[0.4, 0.5, 0.6], 4, &dropped);
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
        let kept: Vec<f32> = queue.lock().unwrap().iter().copied().collect();
        assert_eq!(kept, vec![0.3, 0.4, 0.5, 0.6]);
    }

    fn sink(id: &str) -> AudioDevice {
        AudioDevice {
            id: id.into(),
            name: id.into(),
            is_default: false,
        }
    }

    #[test]
    fn a_saved_sink_that_is_gone_is_not_listed() {
        let devices = vec![sink("alsa_output.hdmi-stereo"), sink("alsa_output.analog")];
        assert!(device_listed("alsa_output.analog", &devices));
        assert!(!device_listed("alsa_output.usb-gone", &devices));
        assert!(!device_listed("", &devices));
        assert!(!device_listed("alsa_output.analog.monitor", &devices));
    }

    #[test]
    fn the_queue_holds_a_minute_at_the_capture_rate() {
        assert_eq!(capture_queue_capacity(44_100), 44_100 * 60);
        assert_eq!(capture_queue_capacity(48_000), 48_000 * 60);
    }

    #[test]
    fn a_stop_wakes_a_parked_reader_and_ends_the_stream() {
        let (queue, waker_state) = stream_parts();
        waker_state.lock().unwrap().waker = Some(Waker::noop().clone());
        let stopper = StreamStopper {
            waker_state: waker_state.clone(),
        };
        stopper.stop();
        let state = waker_state.lock().unwrap();
        assert!(state.shutdown);
        assert!(state.waker.is_none(), "reader was not woken");
        drop(state);
        assert!(queue.lock().unwrap().is_empty());
    }
}
