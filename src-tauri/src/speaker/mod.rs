use anyhow::Result;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use std::pin::Pin;

pub mod mic;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux::{SpeakerInput as PlatformSpeakerInput, SpeakerStream as PlatformSpeakerStream};

mod commands;
pub mod preprocessing;

// Re-export commands for tauri handler
pub use commands::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn list_input_devices() -> Result<Vec<AudioDevice>> {
    #[cfg(target_os = "macos")]
    return macos::get_input_devices();

    #[cfg(target_os = "windows")]
    return windows::get_input_devices();

    #[cfg(target_os = "linux")]
    return linux::get_input_devices();
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
pub(crate) fn list_output_devices() -> Result<Vec<AudioDevice>> {
    #[cfg(target_os = "macos")]
    return macos::get_output_devices();

    #[cfg(target_os = "windows")]
    return windows::get_output_devices();

    #[cfg(target_os = "linux")]
    return linux::get_output_devices();
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) fn list_input_devices() -> Result<Vec<AudioDevice>> {
    Ok(vec![])
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) fn list_output_devices() -> Result<Vec<AudioDevice>> {
    Ok(vec![])
}

/// UID of the current default output device, or None where it can't be
/// determined. Used by the capture loop to detect a mid-session output-device
/// switch. Only implemented for macOS today; other platforms return None
/// (no monitoring), which is safe — it just disables the auto-restart.
pub(crate) fn default_output_uid() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        macos::default_output_uid()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

// Assistant speaker input and stream
pub struct SpeakerInput {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    inner: PlatformSpeakerInput,
}

impl SpeakerInput {
    // Creates a new speaker input. Fails on unsupported platforms.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn new() -> Result<Self> {
        let inner = PlatformSpeakerInput::new(None)?;
        Ok(Self { inner })
    }

    // Creates a new speaker input with a specific device ID
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn new_with_device(device_id: Option<String>) -> Result<Self> {
        let inner = PlatformSpeakerInput::new(device_id)?;
        Ok(Self { inner })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn new() -> Result<Self> {
        Err(anyhow::anyhow!(
            "SpeakerInput::new is not supported on this platform"
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn new_with_device(_device_id: Option<String>) -> Result<Self> {
        Err(anyhow::anyhow!(
            "SpeakerInput::new_with_device is not supported on this platform"
        ))
    }

    /// Sample rate without starting the stream, when the platform can know it
    /// in advance (macOS reads the tap format; other platforms only learn the
    /// rate once the capture loop runs, so they report None).
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn sample_rate(&self) -> Option<u32> {
        self.inner.sample_rate()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn sample_rate(&self) -> Option<u32> {
        None
    }

    // Starts the audio stream.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    pub fn stream(self) -> Result<SpeakerStream> {
        let inner = self.inner.stream()?;
        Ok(SpeakerStream { inner })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    pub fn stream(self) -> Result<SpeakerStream> {
        Err(anyhow::anyhow!(
            "SpeakerInput::stream is not supported on this platform"
        ))
    }
}

// Stream of f32 audio samples from the speaker.
pub struct SpeakerStream {
    inner: PlatformSpeakerStream,
}

impl Stream for SpeakerStream {
    type Item = f32;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        {
            Pin::new(&mut self.inner).poll_next(cx)
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            std::task::Poll::Pending
        }
    }
}

impl SpeakerStream {
    // Gets the sample rate (e.g., 16000 Hz on stub, variable on real impls).
    pub fn sample_rate(&self) -> u32 {
        #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
        return self.inner.sample_rate();

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        0
    }
}
