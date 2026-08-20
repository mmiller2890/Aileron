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

export type SttProgressPhase = "listing" | "downloading" | "compiling";

export interface SttModelProgress {
  fractionCompleted: number;
  phase: SttProgressPhase;
  modelName?: string;
}

interface SttModelProgressEvent {
  fraction_completed: number;
  phase: SttProgressPhase;
  model_name?: string;
}

export function advanceSttProgress(
  current: SttModelProgress | null,
  event: SttModelProgressEvent,
): SttModelProgress {
  const fraction = Number.isFinite(event.fraction_completed)
    ? Math.min(1, Math.max(0, event.fraction_completed))
    : 0;
  return {
    fractionCompleted: Math.max(current?.fractionCompleted ?? 0, fraction),
    phase: event.phase,
    modelName: event.model_name,
  };
}

export function formatSttProgressPhase(progress: SttModelProgress): string {
  if (progress.phase === "compiling") {
    return progress.modelName
      ? `Compiling ${progress.modelName} for CoreML`
      : "Compiling speech models for CoreML";
  }
  if (progress.phase === "listing") {
    return "Checking speech model files";
  }
  return "Downloading speech models";
}

export function useSttStatus() {
  const [progress, setProgress] = useState<SttModelProgress | null>(null);
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
    setProgress(null);
    setStatus((prev) => ({ ...prev, isInitializing: true, error: null }));
    try {
      await invoke("stt_init", { modelVersion });
      await refresh();
      setStatus((prev) => ({ ...prev, isInitializing: false }));
      setProgress(null);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus((prev) => ({
        ...prev,
        isInitializing: false,
        error: message,
        asrReady: false,
      }));
      setProgress(null);
      return false;
    }
  }, [refresh]);

  useEffect(() => {
    refresh();
    let unlistenReady: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;

    const setup = async () => {
      unlistenReady = await listen("stt-ready", () => {
        setProgress(null);
        setStatus((prev) => ({
          ...prev,
          asrReady: true,
          isInitializing: false,
          error: null,
        }));
      });
      unlistenError = await listen("stt-error", (event) => {
        setProgress(null);
        setStatus((prev) => ({
          ...prev,
          error: String(event.payload),
          isInitializing: false,
        }));
      });
      unlistenProgress = await listen<SttModelProgressEvent>(
        "stt-model-progress",
        (event) => {
          setProgress((current) => advanceSttProgress(current, event.payload));
        },
      );
    };

    setup();

    return () => {
      if (unlistenReady) unlistenReady();
      if (unlistenError) unlistenError();
      if (unlistenProgress) unlistenProgress();
    };
  }, [refresh]);

  return { ...status, progress, refresh, init };
}
