import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeLocalStorage } from "@/lib";

export interface VadConfig {
  enabled: boolean;
  hop_size: number;
  sensitivity_rms: number;
  peak_threshold: number;
  silence_chunks: number;
  min_speech_chunks: number;
  pre_speech_chunks: number;
  noise_gate_threshold: number;
  max_recording_duration_secs: number;
  emit_chunks?: boolean;
  chunk_interval_ms?: number;
}

const DEFAULT_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.006,
  peak_threshold: 0.020,
  // Tunables are sample-rate-dependent, tuned for 48 kHz (hop_size 1024 =
  // 21.3 ms/hop). silence_chunks 100 = ~2.1s (tolerates thinking pauses);
  // pre_speech_chunks 30 = ~0.64s, covering 2+ Silero refresh periods so the
  // word onset survives until VAD triggers.
  silence_chunks: 100,
  min_speech_chunks: 12,
  pre_speech_chunks: 30,
  noise_gate_threshold: 0.0015,
  max_recording_duration_secs: 180,
  emit_chunks: false,
  chunk_interval_ms: 1000,
};

// Bumped when default tunables change so stale saved configs (with the old
// values) are ignored instead of silently overriding the tuned defaults.
const VAD_CONFIG_STORAGE_KEY = "vad_config_v2";

export function useVadConfig() {
  const [vadConfig, setVadConfig] = useState<VadConfig>(DEFAULT_VAD_CONFIG);

  useEffect(() => {
    const savedVadConfig = safeLocalStorage.getItem(VAD_CONFIG_STORAGE_KEY);
    if (savedVadConfig) {
      try {
        const parsed = JSON.parse(savedVadConfig);
        setVadConfig(parsed);
      } catch (error) {
        console.error("Failed to load VAD config:", error);
      }
    }
  }, []);

  const updateVadConfiguration = useCallback(async (config: VadConfig) => {
    try {
      setVadConfig(config);
      safeLocalStorage.setItem(VAD_CONFIG_STORAGE_KEY, JSON.stringify(config));
      await invoke("update_vad_config", { config });
    } catch (error) {
      console.error("Failed to update VAD config:", error);
    }
  }, []);

  return { vadConfig, updateVadConfiguration };
}
