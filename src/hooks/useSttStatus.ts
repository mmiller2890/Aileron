import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FluidAudioModel } from "@/lib/fluidaudio-model";

export interface SttStatus {
  asrReady: boolean;
  modelVersion: FluidAudioModel | null;
  vadReady: boolean;
  diarizationReady: boolean;
  isSupported: boolean;
  isInitializing: boolean;
  error: string | null;
}

export function useSttStatus() {
  const [status, setStatus] = useState<SttStatus>({
    asrReady: false,
    modelVersion: null,
    vadReady: false,
    diarizationReady: false,
    isSupported: false,
    isInitializing: false,
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const result = await invoke<{
        asr_ready: boolean;
        model_version: FluidAudioModel | null;
        vad_ready: boolean;
        diarization_ready: boolean;
        is_supported: boolean;
      }>("stt_get_status");
      setStatus((prev) => ({
        ...prev,
        asrReady: result.asr_ready,
        modelVersion: result.model_version,
        vadReady: result.vad_ready,
        diarizationReady: result.diarization_ready,
        isSupported: result.is_supported,
        error: null,
      }));
      return result.is_supported;
    } catch (e) {
      setStatus((prev) => ({
        ...prev,
        isSupported: false,
        error: String(e),
      }));
      return false;
    }
  }, []);

  const init = useCallback(async (modelVersion: FluidAudioModel = "v3") => {
    setStatus((prev) => ({ ...prev, isInitializing: true, error: null }));
    try {
      await invoke("stt_init", { modelVersion });
      await refresh();
      setStatus((prev) => ({ ...prev, isInitializing: false }));
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus((prev) => ({
        ...prev,
        isInitializing: false,
        error: message,
        asrReady: false,
      }));
      return false;
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    let unlistenReady: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;

    const setup = async () => {
      unlistenReady = await listen("stt-ready", () => {
        setStatus((prev) => ({
          ...prev,
          asrReady: true,
          isInitializing: false,
          error: null,
        }));
      });
      unlistenError = await listen("stt-error", (event) => {
        setStatus((prev) => ({
          ...prev,
          error: String(event.payload),
          isInitializing: false,
        }));
      });
    };

    setup();

    return () => {
      if (unlistenReady) unlistenReady();
      if (unlistenError) unlistenError();
    };
  }, [refresh]);

  return { ...status, refresh, init };
}
