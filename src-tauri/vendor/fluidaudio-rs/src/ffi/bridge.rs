//! Swift bridge definitions for FluidAudio bindings
//!
//! Using manual FFI instead of swift-bridge to avoid complexity with Vec types.

// Raw FFI functions - called directly from Rust, implemented in Swift
#[link(name = "FluidAudioBridge")]
extern "C" {
    // Constructor / Destructor
    fn fluidaudio_bridge_create() -> *mut std::ffi::c_void;
    fn fluidaudio_bridge_destroy(bridge: *mut std::ffi::c_void);
    fn fluidaudio_bridge_take_last_error(bridge: *mut std::ffi::c_void) -> *mut i8;

    // ASR
    fn fluidaudio_initialize_asr_version(
        bridge: *mut std::ffi::c_void,
        version_code: i32,
        progress_callback: Option<ProgressCallback>,
        progress_context: *mut std::ffi::c_void,
    ) -> i32;
    fn fluidaudio_transcribe_file(
        bridge: *mut std::ffi::c_void,
        path: *const i8,
        out_text: *mut *mut i8,
        out_confidence: *mut f32,
        out_duration: *mut f64,
        out_processing_time: *mut f64,
        out_rtfx: *mut f32,
        out_token_timings_json: *mut *mut i8,
    ) -> i32;
    fn fluidaudio_is_asr_available(bridge: *mut std::ffi::c_void) -> i32;
    fn fluidaudio_transcribe_samples(
        bridge: *mut std::ffi::c_void,
        samples: *const f32,
        sample_count: u32,
        out_text: *mut *mut i8,
        out_confidence: *mut f32,
        out_duration: *mut f64,
        out_processing_time: *mut f64,
        out_rtfx: *mut f32,
        out_token_timings_json: *mut *mut i8,
    ) -> i32;

    // VAD
    fn fluidaudio_initialize_vad(bridge: *mut std::ffi::c_void, threshold: f32) -> i32;
    fn fluidaudio_is_vad_available(bridge: *mut std::ffi::c_void) -> i32;
    fn fluidaudio_vad_reset_stream(bridge: *mut std::ffi::c_void) -> i32;
    fn fluidaudio_vad_process_streaming_samples(
        bridge: *mut std::ffi::c_void,
        samples: *const f32,
        count: u32,
        out_probability: *mut f32,
    ) -> i32;

    // Diarization
    fn fluidaudio_initialize_diarization(bridge: *mut std::ffi::c_void, threshold: f64) -> i32;
    fn fluidaudio_diarize_file(
        bridge: *mut std::ffi::c_void,
        path: *const i8,
        out_speaker_ids: *mut *mut *mut i8,
        out_start_times: *mut *mut f32,
        out_end_times: *mut *mut f32,
        out_quality_scores: *mut *mut f32,
        out_count: *mut u32,
    ) -> i32;
    fn fluidaudio_is_diarization_available(bridge: *mut std::ffi::c_void) -> i32;
    fn fluidaudio_free_diarization_result(
        speaker_ids: *mut *mut i8,
        start_times: *mut f32,
        end_times: *mut f32,
        quality_scores: *mut f32,
        count: u32,
    );

    // System Info
    fn fluidaudio_get_platform(out: *mut *mut i8);
    fn fluidaudio_get_chip_name(out: *mut *mut i8);
    fn fluidaudio_get_memory_gb() -> f64;
    fn fluidaudio_is_apple_silicon() -> i32;
    fn fluidaudio_is_intel_mac() -> i32;

    // VAD processing
    fn fluidaudio_vad_process_file(
        bridge: *mut std::ffi::c_void,
        path: *const i8,
        out_probabilities: *mut *mut f32,
        out_is_voice_active: *mut *mut u8,
        out_processing_times: *mut *mut f64,
        out_count: *mut u32,
    ) -> i32;
    fn fluidaudio_vad_process_samples(
        bridge: *mut std::ffi::c_void,
        samples: *const f32,
        count: u32,
        out_probabilities: *mut *mut f32,
        out_is_voice_active: *mut *mut u8,
        out_processing_times: *mut *mut f64,
        out_count: *mut u32,
    ) -> i32;
    fn fluidaudio_free_vad_result(
        probabilities: *mut f32,
        is_voice_active: *mut u8,
        processing_times: *mut f64,
        count: u32,
    );

    // ITN (Inverse Text Normalization)
    fn fluidaudio_itn_normalize(
        bridge: *mut std::ffi::c_void,
        text: *const i8,
        out_text: *mut *mut i8,
    ) -> i32;
    fn fluidaudio_itn_normalize_sentence(
        bridge: *mut std::ffi::c_void,
        text: *const i8,
        out_text: *mut *mut i8,
    ) -> i32;
    fn fluidaudio_itn_normalize_sentence_max_span(
        bridge: *mut std::ffi::c_void,
        text: *const i8,
        max_span_tokens: u32,
        out_text: *mut *mut i8,
    ) -> i32;
    fn fluidaudio_itn_is_native_available(bridge: *mut std::ffi::c_void) -> i32;

    // Cleanup
    fn fluidaudio_cleanup(bridge: *mut std::ffi::c_void);

    // String free
    fn fluidaudio_free_string(s: *mut i8);
    fn fluidaudio_resample_samples(
        samples: *const f32,
        count: u32,
        input_rate: f64,
        out_samples: *mut *mut f32,
        out_count: *mut u32,
        out_error: *mut *mut i8,
    ) -> i32;
    fn fluidaudio_free_float_array(samples: *mut f32);
}

use std::ffi::{CStr, CString};

type ProgressCallback = unsafe extern "C" fn(*mut std::ffi::c_void, f64, i32, *const i8);

/// Safe wrapper for the FluidAudio bridge
pub struct FluidAudioBridge {
    ptr: *mut std::ffi::c_void,
}

#[cfg(test)]
mod tests {
    use super::select_error_message;

    #[test]
    fn swift_error_detail_wins_over_the_fallback() {
        assert_eq!(
            select_error_message(
                Some("CoreML model compilation failed".to_string()),
                "ASR init failed"
            ),
            "CoreML model compilation failed"
        );
    }

    #[test]
    fn missing_or_empty_swift_error_uses_the_fallback() {
        assert_eq!(
            select_error_message(None, "ASR init failed"),
            "ASR init failed"
        );
        assert_eq!(
            select_error_message(Some("  ".to_string()), "ASR init failed"),
            "ASR init failed"
        );
    }
}

pub fn resample_samples(samples: &[f32], input_rate: f64) -> Result<Vec<f32>, String> {
    if samples.is_empty() {
        return Ok(Vec::new());
    }
    let mut output_ptr = std::ptr::null_mut();
    let mut output_count = 0;
    let mut error_ptr = std::ptr::null_mut();
    let result = unsafe {
        fluidaudio_resample_samples(
            samples.as_ptr(),
            samples.len() as u32,
            input_rate,
            &mut output_ptr,
            &mut output_count,
            &mut error_ptr,
        )
    };
    if result != 0 || output_ptr.is_null() {
        if !output_ptr.is_null() {
            unsafe { fluidaudio_free_float_array(output_ptr) };
        }
        let detail = if error_ptr.is_null() {
            None
        } else {
            Some(unsafe { take_c_string(error_ptr) })
        };
        return Err(select_error_message(detail, "Failed to resample audio"));
    }
    if !error_ptr.is_null() {
        unsafe { fluidaudio_free_string(error_ptr) };
    }
    let output = unsafe { std::slice::from_raw_parts(output_ptr, output_count as usize).to_vec() };
    unsafe { fluidaudio_free_float_array(output_ptr) };
    Ok(output)
}

unsafe impl Send for FluidAudioBridge {}

fn select_error_message(detail: Option<String>, fallback: &str) -> String {
    detail
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

impl FluidAudioBridge {
    fn last_error_message(&self, fallback: &str) -> String {
        let detail = unsafe {
            let ptr = fluidaudio_bridge_take_last_error(self.ptr);
            if ptr.is_null() {
                None
            } else {
                Some(take_c_string(ptr))
            }
        };
        select_error_message(detail, fallback)
    }

    pub fn new() -> Option<Self> {
        let ptr = unsafe { fluidaudio_bridge_create() };
        if ptr.is_null() {
            None
        } else {
            Some(Self { ptr })
        }
    }

    pub fn initialize_asr_version(&self, version_code: i32) -> Result<(), String> {
        let result = unsafe {
            fluidaudio_initialize_asr_version(self.ptr, version_code, None, std::ptr::null_mut())
        };
        if result == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to initialize requested ASR model"))
        }
    }

    pub fn initialize_asr_version_with_progress<F>(
        &self,
        version_code: i32,
        progress_callback: F,
    ) -> Result<(), String>
    where
        F: Fn(ModelProgress) + Send + Sync,
    {
        unsafe extern "C" fn trampoline<F>(
            context: *mut std::ffi::c_void,
            fraction_completed: f64,
            phase_code: i32,
            model_name: *const i8,
        ) where
            F: Fn(ModelProgress) + Send + Sync,
        {
            let callback = &*(context as *const F);
            let model_name = if model_name.is_null() {
                None
            } else {
                Some(CStr::from_ptr(model_name).to_string_lossy().into_owned())
            };
            let phase = match phase_code {
                0 => "listing",
                1 => "downloading",
                2 => "compiling",
                _ => "unknown",
            };
            let progress = ModelProgress {
                fraction_completed: fraction_completed.clamp(0.0, 1.0),
                phase,
                model_name,
            };
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(progress)));
        }

        let context = &progress_callback as *const F as *mut std::ffi::c_void;
        let result = unsafe {
            fluidaudio_initialize_asr_version(
                self.ptr,
                version_code,
                Some(trampoline::<F>),
                context,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to initialize requested ASR model"))
        }
    }

    pub fn transcribe_file(&self, path: &str) -> Result<AsrResult, String> {
        let c_path = CString::new(path).map_err(|_| "Invalid path")?;

        let mut text_ptr: *mut i8 = std::ptr::null_mut();
        let mut confidence: f32 = 0.0;
        let mut duration: f64 = 0.0;
        let mut processing_time: f64 = 0.0;
        let mut rtfx: f32 = 0.0;
        let mut token_timings_ptr: *mut i8 = std::ptr::null_mut();

        let result = unsafe {
            fluidaudio_transcribe_file(
                self.ptr,
                c_path.as_ptr(),
                &mut text_ptr,
                &mut confidence,
                &mut duration,
                &mut processing_time,
                &mut rtfx,
                &mut token_timings_ptr,
            )
        };

        if result != 0 {
            if !text_ptr.is_null() {
                unsafe { fluidaudio_free_string(text_ptr) };
            }
            if !token_timings_ptr.is_null() {
                unsafe { fluidaudio_free_string(token_timings_ptr) };
            }
            return Err(self.last_error_message("Transcription failed"));
        }

        let text = if text_ptr.is_null() {
            String::new()
        } else {
            let text = unsafe { CStr::from_ptr(text_ptr) }
                .to_string_lossy()
                .into_owned();
            unsafe { fluidaudio_free_string(text_ptr) };
            text
        };
        let token_timings = unsafe { take_token_timings(token_timings_ptr)? };

        Ok(AsrResult {
            text,
            confidence,
            duration,
            processing_time,
            rtfx,
            token_timings,
        })
    }

    pub fn transcribe_samples(&self, samples: &[f32]) -> Result<AsrResult, String> {
        let mut text_ptr: *mut i8 = std::ptr::null_mut();
        let mut confidence: f32 = 0.0;
        let mut duration: f64 = 0.0;
        let mut processing_time: f64 = 0.0;
        let mut rtfx: f32 = 0.0;
        let mut token_timings_ptr: *mut i8 = std::ptr::null_mut();

        let result = unsafe {
            fluidaudio_transcribe_samples(
                self.ptr,
                samples.as_ptr(),
                samples.len() as u32,
                &mut text_ptr,
                &mut confidence,
                &mut duration,
                &mut processing_time,
                &mut rtfx,
                &mut token_timings_ptr,
            )
        };

        if result != 0 {
            if !text_ptr.is_null() {
                unsafe { fluidaudio_free_string(text_ptr) };
            }
            if !token_timings_ptr.is_null() {
                unsafe { fluidaudio_free_string(token_timings_ptr) };
            }
            return Err(self.last_error_message("Transcription failed"));
        }

        let text = if text_ptr.is_null() {
            String::new()
        } else {
            let text = unsafe { CStr::from_ptr(text_ptr) }
                .to_string_lossy()
                .into_owned();
            unsafe { fluidaudio_free_string(text_ptr) };
            text
        };
        let token_timings = unsafe { take_token_timings(token_timings_ptr)? };

        Ok(AsrResult {
            text,
            confidence,
            duration,
            processing_time,
            rtfx,
            token_timings,
        })
    }

    pub fn is_asr_available(&self) -> bool {
        unsafe { fluidaudio_is_asr_available(self.ptr) != 0 }
    }

    pub fn initialize_vad(&self, threshold: f32) -> Result<(), String> {
        let result = unsafe { fluidaudio_initialize_vad(self.ptr, threshold) };
        if result == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to initialize VAD"))
        }
    }

    pub fn is_vad_available(&self) -> bool {
        unsafe { fluidaudio_is_vad_available(self.ptr) != 0 }
    }

    pub fn vad_reset_stream(&self) -> Result<(), String> {
        let result = unsafe { fluidaudio_vad_reset_stream(self.ptr) };
        if result == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to reset VAD stream"))
        }
    }

    pub fn vad_process_streaming_samples(&self, samples: &[f32]) -> Result<f32, String> {
        let mut probability = 0.0;
        let result = unsafe {
            fluidaudio_vad_process_streaming_samples(
                self.ptr,
                samples.as_ptr(),
                samples.len() as u32,
                &mut probability,
            )
        };
        if result == 0 {
            Ok(probability)
        } else {
            Err(self.last_error_message("Failed to process VAD stream chunk"))
        }
    }

    pub fn initialize_diarization(&self, threshold: f64) -> Result<(), String> {
        let result = unsafe { fluidaudio_initialize_diarization(self.ptr, threshold) };
        if result == 0 {
            Ok(())
        } else {
            Err(self.last_error_message("Failed to initialize diarization"))
        }
    }

    pub fn diarize_file(&self, path: &str) -> Result<Vec<DiarizationSegment>, String> {
        let c_path = CString::new(path).map_err(|_| "Invalid path")?;

        let mut speaker_ids_ptr: *mut *mut i8 = std::ptr::null_mut();
        let mut start_times_ptr: *mut f32 = std::ptr::null_mut();
        let mut end_times_ptr: *mut f32 = std::ptr::null_mut();
        let mut quality_scores_ptr: *mut f32 = std::ptr::null_mut();
        let mut count: u32 = 0;

        let result = unsafe {
            fluidaudio_diarize_file(
                self.ptr,
                c_path.as_ptr(),
                &mut speaker_ids_ptr,
                &mut start_times_ptr,
                &mut end_times_ptr,
                &mut quality_scores_ptr,
                &mut count,
            )
        };

        if result != 0 {
            unsafe {
                fluidaudio_free_diarization_result(
                    speaker_ids_ptr,
                    start_times_ptr,
                    end_times_ptr,
                    quality_scores_ptr,
                    count,
                )
            };
            return Err(self.last_error_message("Diarization failed"));
        }

        let mut segments = Vec::with_capacity(count as usize);

        if count == 0 {
            unsafe {
                fluidaudio_free_diarization_result(
                    speaker_ids_ptr,
                    start_times_ptr,
                    end_times_ptr,
                    quality_scores_ptr,
                    count,
                )
            };
        } else if speaker_ids_ptr.is_null()
            || start_times_ptr.is_null()
            || end_times_ptr.is_null()
            || quality_scores_ptr.is_null()
        {
            unsafe {
                fluidaudio_free_diarization_result(
                    speaker_ids_ptr,
                    start_times_ptr,
                    end_times_ptr,
                    quality_scores_ptr,
                    count,
                )
            };
            return Err("Diarization returned incomplete native result arrays".to_string());
        } else {
            for i in 0..count as usize {
                let id_ptr = unsafe { *speaker_ids_ptr.add(i) };
                let speaker_id = if id_ptr.is_null() {
                    String::new()
                } else {
                    unsafe { CStr::from_ptr(id_ptr) }
                        .to_string_lossy()
                        .into_owned()
                };
                segments.push(DiarizationSegment {
                    speaker_id,
                    start_time: unsafe { *start_times_ptr.add(i) },
                    end_time: unsafe { *end_times_ptr.add(i) },
                    quality_score: unsafe { *quality_scores_ptr.add(i) },
                });
            }

            unsafe {
                fluidaudio_free_diarization_result(
                    speaker_ids_ptr,
                    start_times_ptr,
                    end_times_ptr,
                    quality_scores_ptr,
                    count,
                )
            };
        }

        Ok(segments)
    }

    pub fn is_diarization_available(&self) -> bool {
        unsafe { fluidaudio_is_diarization_available(self.ptr) != 0 }
    }

    pub fn system_info(&self) -> SystemInfo {
        let mut platform_ptr: *mut i8 = std::ptr::null_mut();
        let mut chip_ptr: *mut i8 = std::ptr::null_mut();

        unsafe {
            fluidaudio_get_platform(&mut platform_ptr);
            fluidaudio_get_chip_name(&mut chip_ptr);
        }

        let platform = unsafe {
            if platform_ptr.is_null() {
                "unknown".to_string()
            } else {
                let s = CStr::from_ptr(platform_ptr).to_string_lossy().into_owned();
                fluidaudio_free_string(platform_ptr);
                s
            }
        };

        let chip_name = unsafe {
            if chip_ptr.is_null() {
                "unknown".to_string()
            } else {
                let s = CStr::from_ptr(chip_ptr).to_string_lossy().into_owned();
                fluidaudio_free_string(chip_ptr);
                s
            }
        };

        let memory_gb = unsafe { fluidaudio_get_memory_gb() };
        let is_apple_silicon = unsafe { fluidaudio_is_apple_silicon() != 0 };

        SystemInfo {
            platform,
            chip_name,
            memory_gb,
            is_apple_silicon,
        }
    }

    pub fn is_apple_silicon(&self) -> bool {
        unsafe { fluidaudio_is_apple_silicon() != 0 }
    }

    pub fn is_intel_mac(&self) -> bool {
        unsafe { fluidaudio_is_intel_mac() != 0 }
    }

    pub fn vad_process_file(&self, path: &str) -> Result<Vec<VadFrame>, String> {
        let c_path = CString::new(path).map_err(|_| "Invalid path")?;

        let mut probs_ptr: *mut f32 = std::ptr::null_mut();
        let mut voice_ptr: *mut u8 = std::ptr::null_mut();
        let mut times_ptr: *mut f64 = std::ptr::null_mut();
        let mut count: u32 = 0;

        let status = unsafe {
            fluidaudio_vad_process_file(
                self.ptr,
                c_path.as_ptr(),
                &mut probs_ptr,
                &mut voice_ptr,
                &mut times_ptr,
                &mut count,
            )
        };

        if status != 0 {
            unsafe { fluidaudio_free_vad_result(probs_ptr, voice_ptr, times_ptr, count) };
            return Err(self.last_error_message("VAD process file failed"));
        }

        Ok(unsafe { collect_vad_frames(probs_ptr, voice_ptr, times_ptr, count) })
    }

    pub fn vad_process_samples(&self, samples: &[f32]) -> Result<Vec<VadFrame>, String> {
        let mut probs_ptr: *mut f32 = std::ptr::null_mut();
        let mut voice_ptr: *mut u8 = std::ptr::null_mut();
        let mut times_ptr: *mut f64 = std::ptr::null_mut();
        let mut count: u32 = 0;

        let status = unsafe {
            fluidaudio_vad_process_samples(
                self.ptr,
                samples.as_ptr(),
                samples.len() as u32,
                &mut probs_ptr,
                &mut voice_ptr,
                &mut times_ptr,
                &mut count,
            )
        };

        if status != 0 {
            unsafe { fluidaudio_free_vad_result(probs_ptr, voice_ptr, times_ptr, count) };
            return Err(self.last_error_message("VAD process samples failed"));
        }

        Ok(unsafe { collect_vad_frames(probs_ptr, voice_ptr, times_ptr, count) })
    }

    pub fn itn_normalize(&self, text: &str) -> Result<String, String> {
        let c_text = CString::new(text).map_err(|_| "Invalid text (NUL byte)")?;
        let mut out_ptr: *mut i8 = std::ptr::null_mut();
        let status = unsafe { fluidaudio_itn_normalize(self.ptr, c_text.as_ptr(), &mut out_ptr) };
        if status != 0 {
            return Err(self.last_error_message("ITN normalize failed"));
        }
        Ok(unsafe { take_c_string(out_ptr) })
    }

    pub fn itn_normalize_sentence(&self, text: &str) -> Result<String, String> {
        let c_text = CString::new(text).map_err(|_| "Invalid text (NUL byte)")?;
        let mut out_ptr: *mut i8 = std::ptr::null_mut();
        let status =
            unsafe { fluidaudio_itn_normalize_sentence(self.ptr, c_text.as_ptr(), &mut out_ptr) };
        if status != 0 {
            return Err(self.last_error_message("ITN normalize_sentence failed"));
        }
        Ok(unsafe { take_c_string(out_ptr) })
    }

    pub fn itn_normalize_sentence_max_span(
        &self,
        text: &str,
        max_span_tokens: u32,
    ) -> Result<String, String> {
        let c_text = CString::new(text).map_err(|_| "Invalid text (NUL byte)")?;
        let mut out_ptr: *mut i8 = std::ptr::null_mut();
        let status = unsafe {
            fluidaudio_itn_normalize_sentence_max_span(
                self.ptr,
                c_text.as_ptr(),
                max_span_tokens,
                &mut out_ptr,
            )
        };
        if status != 0 {
            return Err(self.last_error_message("ITN normalize_sentence_max_span failed"));
        }
        Ok(unsafe { take_c_string(out_ptr) })
    }

    pub fn itn_is_native_available(&self) -> bool {
        unsafe { fluidaudio_itn_is_native_available(self.ptr) != 0 }
    }

    pub fn cleanup(&self) {
        unsafe { fluidaudio_cleanup(self.ptr) };
    }
}

/// SAFETY: caller must guarantee the four pointers came from a successful
/// `fluidaudio_vad_process_*` call with the matching `count`. Pointers are
/// freed via `fluidaudio_free_vad_result` before returning.
unsafe fn collect_vad_frames(
    probs_ptr: *mut f32,
    voice_ptr: *mut u8,
    times_ptr: *mut f64,
    count: u32,
) -> Vec<VadFrame> {
    if count == 0 || probs_ptr.is_null() || voice_ptr.is_null() || times_ptr.is_null() {
        // Even when count==0 the Swift side may pass NULL pointers; free safely.
        fluidaudio_free_vad_result(probs_ptr, voice_ptr, times_ptr, count);
        return Vec::new();
    }

    let probs = std::slice::from_raw_parts(probs_ptr, count as usize);
    let voice = std::slice::from_raw_parts(voice_ptr, count as usize);
    let times = std::slice::from_raw_parts(times_ptr, count as usize);

    let frames: Vec<VadFrame> = probs
        .iter()
        .zip(voice.iter())
        .zip(times.iter())
        .map(|((&probability, &is_voice), &processing_time)| VadFrame {
            probability,
            is_voice_active: is_voice != 0,
            processing_time,
        })
        .collect();

    fluidaudio_free_vad_result(probs_ptr, voice_ptr, times_ptr, count);
    frames
}

/// SAFETY: `ptr` must be either NULL or a C string allocated by the Swift bridge
/// via `strdup`. Freed via `fluidaudio_free_string` before returning.
unsafe fn take_c_string(ptr: *mut i8) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let s = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    fluidaudio_free_string(ptr);
    s
}

unsafe fn take_token_timings(ptr: *mut i8) -> Result<Vec<TokenTiming>, String> {
    let json = take_c_string(ptr);
    if json.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&json).map_err(|error| format!("Invalid ASR token timings: {error}"))
}

impl Drop for FluidAudioBridge {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { fluidaudio_bridge_destroy(self.ptr) };
        }
    }
}

// Result types
#[derive(Debug, Clone)]
pub struct AsrResult {
    pub text: String,
    pub confidence: f32,
    pub duration: f64,
    pub processing_time: f64,
    pub rtfx: f32,
    pub token_timings: Vec<TokenTiming>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct TokenTiming {
    pub token: String,
    #[serde(alias = "tokenId")]
    pub token_id: i64,
    #[serde(alias = "startTime")]
    pub start_time: f64,
    #[serde(alias = "endTime")]
    pub end_time: f64,
    pub confidence: f32,
}

#[derive(Debug, Clone)]
pub struct ModelProgress {
    pub fraction_completed: f64,
    pub phase: &'static str,
    pub model_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SystemInfo {
    pub platform: String,
    pub chip_name: String,
    pub memory_gb: f64,
    pub is_apple_silicon: bool,
}

/// A speaker segment from diarization
#[derive(Debug, Clone)]
pub struct DiarizationSegment {
    /// Speaker identifier (e.g. "SPEAKER_00", "SPEAKER_01")
    pub speaker_id: String,
    /// Start time in seconds
    pub start_time: f32,
    /// End time in seconds
    pub end_time: f32,
    /// Quality score (0.0-1.0)
    pub quality_score: f32,
}

impl DiarizationSegment {
    /// Duration of this segment in seconds
    pub fn duration(&self) -> f32 {
        self.end_time - self.start_time
    }
}

/// A single per-chunk VAD frame.
///
/// VAD processes audio in 4096-sample chunks (256 ms at 16 kHz). One `VadFrame`
/// is produced per chunk.
#[derive(Debug, Clone, Copy)]
pub struct VadFrame {
    /// Raw model probability that this chunk contains voice (0.0–1.0).
    pub probability: f32,
    /// Whether `probability` crossed the configured threshold (i.e. the chunk
    /// is classified as voice-active).
    pub is_voice_active: bool,
    /// Wall-clock processing time for this chunk in seconds.
    pub processing_time: f64,
}
