import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetchSTT } from "@/lib";
import { useApp } from "@/contexts";
import type { DictationStatus } from "@/lib/dictation-sync";

/**
 * Native mic dictation (macOS): drives the Rust cpal + Silero pipeline via
 * start/stop_mic_dictation and turns each `dictation-detected` utterance into
 * text through the exact downstream the JS VAD used — fetchSTT → submit().
 */
export function useMicDictation({
  submit,
  setState,
}: {
  submit: (text: string) => void;
  setState: React.Dispatch<React.SetStateAction<any>>;
}) {
  const { selectedSttProvider, allSttProviders, selectedAudioDevices } =
    useApp();
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const selectedSttProviderRef = useRef(selectedSttProvider);
  const allSttProvidersRef = useRef(allSttProviders);
  const submitRef = useRef(submit);
  const statusRef = useRef(status);
  selectedSttProviderRef.current = selectedSttProvider;
  allSttProvidersRef.current = allSttProviders;
  submitRef.current = submit;
  statusRef.current = status;

  useEffect(() => {
    const unlistenDetected = listen<{ audio: string }>(
      "dictation-detected",
      async (event) => {
        const b64 = event.payload?.audio;
        if (!b64 || b64.length < 100) return;
        const provider = allSttProvidersRef.current.find(
          (p) => p.id === selectedSttProviderRef.current.provider
        );
        if (!provider) {
          setState((prev: any) => ({
            ...prev,
            error: "Speech provider configuration not found.",
          }));
          return;
        }
        try {
          setStatus("transcribing");
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const audioBlob = new Blob([bytes], { type: "audio/wav" });
          const transcription = await fetchSTT({
            provider,
            selectedProvider: selectedSttProviderRef.current,
            audio: audioBlob,
          });
          if (transcription) {
            submitRef.current(transcription);
          }
        } catch (err) {
          console.error("Dictation transcription failed:", err);
          setState((prev: any) => ({
            ...prev,
            error:
              err instanceof Error ? err.message : "Transcription failed",
          }));
        } finally {
          setStatus((s) => (s === "transcribing" ? "listening" : s));
        }
      }
    );
    const unlistenStopped = listen("dictation-stopped", () => {
      setStatus("idle");
    });
    return () => {
      unlistenDetected.then((fn) => fn());
      unlistenStopped.then((fn) => fn());
      if (statusRef.current !== "idle") {
        invoke("stop_mic_dictation").catch(() => {});
      }
    };
  }, [setState]);

  const start = useCallback(async () => {
    setError(null);
    setStatus("starting");
    try {
      // Rust matches cpal devices by NAME; the stored id is a CoreAudio UID.
      const deviceName = selectedAudioDevices.input.name;
      await invoke("start_mic_dictation", {
        deviceId: !deviceName || deviceName === "default" ? null : deviceName,
      });
      setStatus("listening");
    } catch (err) {
      setStatus("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedAudioDevices.input.name]);

  const stop = useCallback(async () => {
    try {
      await invoke("stop_mic_dictation");
    } catch (err) {
      console.error("Failed to stop dictation:", err);
    }
    setStatus("idle");
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setStatus("idle");
  }, []);

  return { status, error, start, stop, reset };
}
