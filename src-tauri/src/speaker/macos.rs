// Assistant macos speaker input and stream
use super::AudioDevice;
use anyhow::Result;
use ca::aggregate_device_keys as agg_keys;
use cidre::{arc, av, cat, cf, core_audio as ca, ns, os};
use futures_util::Stream;
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};
use tracing::error;

pub fn get_input_devices() -> Result<Vec<AudioDevice>> {
    let mut devices = Vec::new();

    let default_input_uid = ca::System::default_input_device()
        .ok()
        .and_then(|d| d.uid().ok())
        .map(|u| u.to_string());

    let all_devices = ca::System::devices()?;

    for device in all_devices.iter() {
        let input_buffers = device
            .input_stream_cfg()
            .map(|cfg| cfg.number_buffers())
            .unwrap_or(0);

        if input_buffers > 0 {
            let name = device
                .name()
                .map(|n| n.to_string())
                .unwrap_or_else(|_| "Unknown Device".to_string());
            let uid = device
                .uid()
                .map(|u| u.to_string())
                .unwrap_or_else(|_| "macos_input_unknown".to_string());
            let is_default = default_input_uid
                .as_ref()
                .map(|def| def == &uid)
                .unwrap_or(false);

            devices.push(AudioDevice {
                id: uid,
                name,
                is_default,
            });
        }
    }

    Ok(devices)
}

pub fn get_output_devices() -> Result<Vec<AudioDevice>> {
    let mut devices = Vec::new();

    let default_output_uid = ca::System::default_output_device()
        .ok()
        .and_then(|d| d.uid().ok())
        .map(|u| u.to_string());

    let all_devices = ca::System::devices()?;

    for device in all_devices.iter() {
        let output_buffers = device
            .output_stream_cfg()
            .map(|cfg| cfg.number_buffers())
            .unwrap_or(0);

        let input_buffers = device
            .input_stream_cfg()
            .map(|cfg| cfg.number_buffers())
            .unwrap_or(0);

        if output_buffers > 0 {
            let is_primarily_input = input_buffers > 0 && output_buffers == 0;
            if !is_primarily_input {
                let name = device
                    .name()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|_| "Unknown Device".to_string());
                let uid = device
                    .uid()
                    .map(|u| u.to_string())
                    .unwrap_or_else(|_| "macos_output_unknown".to_string());
                let is_default = default_output_uid
                    .as_ref()
                    .map(|def| def == &uid)
                    .unwrap_or(false);

                devices.push(AudioDevice {
                    id: uid,
                    name,
                    is_default,
                });
            }
        }
    }

    Ok(devices)
}

fn find_output_device_by_uid(uid: &str) -> Option<ca::Device> {
    let all_devices = match ca::System::devices() {
        Ok(d) => d,
        Err(e) => {
            error!(
                "[find_output_device_by_uid] Failed to get system devices: {}",
                e
            );
            return None;
        }
    };

    for device in all_devices.into_iter() {
        if let Ok(cfg) = device.output_stream_cfg() {
            if cfg.number_buffers() > 0 {
                if let Ok(device_uid) = device.uid() {
                    if device_uid.to_string() == uid {
                        return Some(device);
                    }
                }
            }
        }
    }

    error!(
        "[find_output_device_by_uid] No matching device found for UID: {}",
        uid
    );
    None
}

/// UID of the current default output device, if it can be read. The capture
/// loop polls this to notice a mid-session device switch (e.g. plugging in
/// AirPods): the tap stays bound to the device it was built on, so after a
/// switch it would silently capture nothing.
pub(crate) fn default_output_uid() -> Option<String> {
    let device = ca::System::default_output_device().ok()?;
    let uid = device.uid().ok()?;
    Some(uid.to_string())
}

pub struct SpeakerInput {
    tap: ca::TapGuard, // Assuming ca::TapGuard from core-audio-rs
    agg_desc: arc::Retained<cf::DictionaryOf<cf::String, cf::Type>>,
}

struct WakerState {
    waker: Option<Waker>,
    has_data: bool,
}

pub struct SpeakerStream {
    consumer: HeapCons<f32>,
    _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
    _ctx: Box<Ctx>,
    _tap: ca::TapGuard,
    waker_state: Arc<Mutex<WakerState>>,
    current_sample_rate: Arc<AtomicU32>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.current_sample_rate.load(Ordering::Acquire)
    }
}

struct Ctx {
    format: arc::R<av::AudioFormat>,
    producer: HeapProd<f32>,
    waker_state: Arc<Mutex<WakerState>>,
    current_sample_rate: Arc<AtomicU32>,
    /// Samples the full ring could not take. Read and reset by the capture
    /// loop, which reports them; the callback itself never logs.
    dropped_samples: Arc<AtomicU64>,
    should_terminate: Arc<AtomicBool>,
    channel_count: usize,
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let output_device = match device_id {
            Some(ref uid) if !uid.is_empty() && uid != "default" => {
                match find_output_device_by_uid(uid) {
                    Some(device) => device,
                    None => ca::System::default_output_device()
                        .map_err(|e| anyhow::anyhow!("No default output device found: {}", e))?,
                }
            }
            _ => ca::System::default_output_device()?,
        };

        let output_uid = output_device.uid()?;

        let sub_device = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[output_uid.as_type_ref()],
        );

        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;

        let tap_uid = tap.uid()?;
        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap_uid.as_type_ref()],
        );

        let agg_desc = cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::is_stacked(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::main_sub_device(),
                agg_keys::uid(),
                agg_keys::sub_device_list(),
                agg_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::Boolean::value_true(),
                cf::str!(c"system-audio-tap"), // Simplified name
                &output_uid,
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_device.as_ref()]),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        Ok(Self { tap, agg_desc })
    }

    fn start_device(
        &self,
        ctx: &mut Box<Ctx>,
    ) -> Result<ca::hardware::StartedDevice<ca::AggregateDevice>> {
        extern "C" fn proc(
            device: ca::Device,
            _now: &cat::AudioTimeStamp,
            input_data: &cat::AudioBufList<1>,
            _input_time: &cat::AudioTimeStamp,
            _output_data: &mut cat::AudioBufList<1>,
            _output_time: &cat::AudioTimeStamp,
            ctx: Option<&mut Ctx>,
        ) -> os::Status {
            let ctx = ctx.unwrap();
            if ctx.should_terminate.load(Ordering::Acquire) {
                return os::Status::NO_ERR;
            }

            ctx.current_sample_rate.store(
                device
                    .actual_sample_rate()
                    .unwrap_or(ctx.format.absd().sample_rate) as u32,
                Ordering::Release,
            );

            if let Some(view) =
                av::AudioPcmBuf::with_buf_list_no_copy(&ctx.format, input_data, None)
            {
                if let Some(data) = view.data_f32_at(0) {
                    process_audio_data(ctx, data);
                }
            } else if ctx.format.common_format() == av::audio::CommonFormat::PcmF32 {
                let first_buffer = &input_data.buffers[0];
                let byte_count = first_buffer.data_bytes_size as usize;
                let float_count = byte_count / std::mem::size_of::<f32>();

                if float_count > 0 && !first_buffer.data.is_null() {
                    let data = unsafe {
                        std::slice::from_raw_parts(first_buffer.data as *const f32, float_count)
                    };
                    process_audio_data(ctx, data);
                }
            }

            os::Status::NO_ERR
        }

        let agg_device = ca::AggregateDevice::with_desc(&self.agg_desc)?;
        let proc_id = agg_device.create_io_proc_id(proc, Some(ctx))?;
        let started_device = ca::device_start(agg_device, Some(proc_id))?;

        Ok(started_device)
    }

    /// Sample rate of the tap's format. Reading it does not start the
    /// aggregate-device tap; `stream()` is what starts the device.
    pub fn sample_rate(&self) -> Option<u32> {
        self.tap.asbd().ok().map(|asbd| asbd.sample_rate as u32)
    }

    pub fn stream(self) -> Result<SpeakerStream> {
        let asbd = self
            .tap
            .asbd()
            .map_err(|e| anyhow::anyhow!("Failed to read tap format: {}", e))?;

        let format = av::AudioFormat::with_asbd(&asbd)
            .ok_or_else(|| anyhow::anyhow!("Failed to create audio format from tap format"))?;

        let rb = HeapRb::<f32>::new(capture_buffer_capacity(asbd.sample_rate));
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
        }));

        let current_sample_rate = Arc::new(AtomicU32::new(asbd.sample_rate as u32));

        let channel_count = format.channel_count() as usize;

        let mut ctx = Box::new(Ctx {
            format,
            producer,
            waker_state: waker_state.clone(),
            current_sample_rate: current_sample_rate.clone(),
            dropped_samples: Arc::new(AtomicU64::new(0)),
            should_terminate: Arc::new(AtomicBool::new(false)),
            channel_count: channel_count.max(1),
        });

        let device = self.start_device(&mut ctx)?;

        Ok(SpeakerStream {
            consumer,
            _device: device,
            _ctx: ctx,
            _tap: self.tap,
            waker_state,
            current_sample_rate,
        })
    }
}

/// How much mono audio the capture ring holds while the consumer is stalled.
/// The capture loop skips ahead long before the ring fills (see
/// `catch_up_skip` in commands.rs); a full ring drops the newest audio and
/// counts it, and capture carries on.
const CAPTURE_BUFFER_SECS: usize = 60;

fn capture_buffer_capacity(sample_rate: f64) -> usize {
    (sample_rate as usize).clamp(8_000, 96_000) * CAPTURE_BUFFER_SECS
}

fn process_audio_data(ctx: &mut Ctx, data: &[f32]) {
    if ctx.should_terminate.load(Ordering::Acquire) {
        return;
    }

    // Real-time thread: push straight from the device buffer, without
    // allocating. A full ring drops what does not fit; losing audio under
    // overload is recoverable, ending the capture is not.
    let (offered, pushed) = if ctx.channel_count <= 1 {
        (data.len(), ctx.producer.push_slice(data))
    } else {
        let channels = ctx.channel_count;
        let frames = data
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32);
        (data.len().div_ceil(channels), ctx.producer.push_iter(frames))
    };
    if pushed < offered {
        ctx.dropped_samples
            .fetch_add((offered - pushed) as u64, Ordering::Relaxed);
    }

    // Wake up consumer if we have new data
    let should_wake = {
        let mut waker_state = ctx.waker_state.lock().unwrap_or_else(|e| e.into_inner());
        if !waker_state.has_data || ctx.should_terminate.load(Ordering::Acquire) {
            waker_state.has_data = true;
            waker_state.waker.take()
        } else {
            None
        }
    };

    if let Some(waker) = should_wake {
        waker.wake();
    }
}

/// Next buffered sample, or end-of-stream once termination is latched and
/// the buffer is empty. A terminated producer rejects further audio, so the
/// drain is bounded by the ring capacity. The pop after the termination check
/// covers a producer that pushed and latched between the two.
fn pop_or_end(consumer: &mut HeapCons<f32>, should_terminate: &AtomicBool) -> Option<Option<f32>> {
    if let Some(sample) = consumer.try_pop() {
        return Some(Some(sample));
    }
    if should_terminate.load(Ordering::Acquire) {
        return Some(consumer.try_pop());
    }
    None
}

fn poll_audio_sample(
    consumer: &mut HeapCons<f32>,
    should_terminate: &AtomicBool,
    waker_state: &Mutex<WakerState>,
    cx: &mut std::task::Context<'_>,
) -> Poll<Option<f32>> {
    if let Some(next) = pop_or_end(consumer, should_terminate) {
        return Poll::Ready(next);
    }

    {
        let mut state = waker_state.lock().unwrap_or_else(|e| e.into_inner());
        state.has_data = false;
        state.waker = Some(cx.waker().clone());
    }

    // Re-check after registering the waker: a push or a termination that
    // landed before the registration saw a stale waker state.
    match pop_or_end(consumer, should_terminate) {
        Some(next) => Poll::Ready(next),
        None => Poll::Pending,
    }
}

impl Stream for SpeakerStream {
    type Item = f32;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> Poll<Option<Self::Item>> {
        let stream = self.get_mut();
        poll_audio_sample(
            &mut stream.consumer,
            &stream._ctx.should_terminate,
            &stream.waker_state,
            cx,
        )
    }
}

/// Samples dropped since the last call.
fn take_dropped(dropped: &AtomicU64) -> u64 {
    dropped.swap(0, Ordering::Relaxed)
}

impl SpeakerStream {
    /// Captured samples waiting to be read.
    pub fn backlog_samples(&self) -> usize {
        self.consumer.occupied_len()
    }

    /// Discard up to `count` of the oldest waiting samples; returns how many.
    pub fn skip_samples(&mut self, count: usize) -> usize {
        self.consumer.skip(count)
    }

    /// Samples the full ring dropped since the last call.
    pub fn take_dropped_samples(&self) -> u64 {
        take_dropped(&self._ctx.dropped_samples)
    }
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        self._ctx.should_terminate.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_buffer() -> (Ctx, HeapCons<f32>) {
        let (producer, consumer) = HeapRb::<f32>::new(4).split();
        let ctx = Ctx {
            format: av::AudioFormat::standard_with_sample_rate_and_channels(48_000.0, 1).unwrap(),
            producer,
            waker_state: Arc::new(Mutex::new(WakerState {
                waker: None,
                has_data: false,
            })),
            current_sample_rate: Arc::new(AtomicU32::new(48_000)),
            dropped_samples: Arc::new(AtomicU64::new(0)),
            should_terminate: Arc::new(AtomicBool::new(false)),
            channel_count: 1,
        };
        (ctx, consumer)
    }

    #[test]
    fn capture_buffer_holds_a_minute_at_the_tap_sample_rate() {
        assert_eq!(capture_buffer_capacity(48_000.0), 48_000 * 60);
        assert_eq!(capture_buffer_capacity(44_100.0), 44_100 * 60);
        // A bogus tap format must not size the ring to nothing or to gigabytes.
        assert_eq!(capture_buffer_capacity(0.0), 8_000 * 60);
        assert_eq!(capture_buffer_capacity(f64::NAN), 8_000 * 60);
        assert_eq!(capture_buffer_capacity(1e12), 96_000 * 60);
    }

    #[test]
    fn sustained_overflow_keeps_capturing_and_counts_what_it_drops() {
        let (mut ctx, mut consumer) = test_buffer();
        for _ in 0..100 {
            process_audio_data(&mut ctx, &[0.5; 8]);
        }
        // Overload loses audio, never the capture.
        assert!(!ctx.should_terminate.load(Ordering::Acquire));
        // The 4-sample ring keeps the first 4; the other 796 are counted.
        assert_eq!(take_dropped(&ctx.dropped_samples), 796);
        assert_eq!(take_dropped(&ctx.dropped_samples), 0);
        while consumer.try_pop().is_some() {}
        process_audio_data(&mut ctx, &[0.25; 2]);
        assert_eq!(consumer.try_pop(), Some(0.25));
    }

    #[test]
    fn a_consumer_can_measure_and_skip_its_backlog() {
        let (mut ctx, mut consumer) = test_buffer();
        process_audio_data(&mut ctx, &[0.1, 0.2, 0.3, 0.4]);
        assert_eq!(consumer.occupied_len(), 4);
        assert_eq!(consumer.skip(3), 3);
        assert_eq!(consumer.try_pop(), Some(0.4));
    }

    #[test]
    fn terminated_consumer_drains_buffered_audio_then_ends() {
        let (mut ctx, mut consumer) = test_buffer();
        process_audio_data(&mut ctx, &[0.5; 4]);
        ctx.should_terminate.store(true, Ordering::Release);
        // A terminated producer adds nothing, so the drain is bounded.
        process_audio_data(&mut ctx, &[0.25; 4]);
        let mut cx = std::task::Context::from_waker(Waker::noop());
        for _ in 0..4 {
            assert_eq!(
                poll_audio_sample(
                    &mut consumer,
                    &ctx.should_terminate,
                    &ctx.waker_state,
                    &mut cx
                ),
                Poll::Ready(Some(0.5))
            );
        }
        assert_eq!(
            poll_audio_sample(
                &mut consumer,
                &ctx.should_terminate,
                &ctx.waker_state,
                &mut cx
            ),
            Poll::Ready(None)
        );
    }

    #[test]
    fn live_consumer_drains_audio_and_registers_for_wakeup() {
        let (mut ctx, mut consumer) = test_buffer();
        let mut cx = std::task::Context::from_waker(Waker::noop());
        assert_eq!(
            poll_audio_sample(
                &mut consumer,
                &ctx.should_terminate,
                &ctx.waker_state,
                &mut cx
            ),
            Poll::Pending
        );
        process_audio_data(&mut ctx, &[0.5]);
        assert!(ctx.waker_state.lock().unwrap().waker.is_none());
        assert_eq!(
            poll_audio_sample(
                &mut consumer,
                &ctx.should_terminate,
                &ctx.waker_state,
                &mut cx
            ),
            Poll::Ready(Some(0.5))
        );
    }
}
