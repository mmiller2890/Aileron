import { useCallback, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import curl2Json from "@bany/curl-to-json";
import { TYPE_PROVIDER } from "@/types";
import { deepVariableReplacer } from "@/lib/functions/common.function";

interface SelectedSttProvider {
  provider: string;
  variables: Record<string, string>;
}

export function isActiveStreamingSession<T>(
  currentSocket: T | null,
  socket: T,
  generation: number,
  isCurrentGeneration: (generation: number) => boolean
): boolean {
  return (
    currentSocket === socket && isCurrentGeneration(generation)
  );
}

function buildStreamingUrl(
  provider: TYPE_PROVIDER,
  selected: SelectedSttProvider
): string {
  if (provider.streamingUrl) {
    return deepVariableReplacer(provider.streamingUrl, selected.variables);
  }
  const curlJson = curl2Json(provider.curl);
  const baseUrl = (curlJson.url as string) || "";
  const replaced = deepVariableReplacer(baseUrl, selected.variables);
  return replaced.replace(/^http/, "ws");
}

/**
 * WebSocket session mechanics for streaming STT providers: open/close the
 * socket, forward raw audio chunks, and surface partial transcripts.
 *
 * What to DO with a final transcript is the caller's decision, delivered via
 * `onFinalTranscriptRef`. Everything the socket handlers read is ref-backed:
 * they are created once per socket, so plain captured state would go stale
 * (the bug class this file's parent has been bitten by before).
 *
 * The two coordination flags are shared with the batch (speech-detected)
 * path: `streamingFinalizedRef` marks that the socket already produced the
 * final text for the current utterance, and
 * `batchProcessedForCurrentUtteranceRef` marks the reverse.
 */
export function useSttStreamSocket({
  selectedSttProviderRef,
  allSttProvidersRef,
  capturedSampleRateRef,
  onFinalTranscriptRef,
  captureGenerationRef,
  isCaptureGenerationCurrentRef,
}: {
  selectedSttProviderRef: MutableRefObject<SelectedSttProvider>;
  allSttProvidersRef: MutableRefObject<TYPE_PROVIDER[]>;
  capturedSampleRateRef: MutableRefObject<number>;
  onFinalTranscriptRef: MutableRefObject<(text: string) => void>;
  captureGenerationRef: MutableRefObject<number>;
  isCaptureGenerationCurrentRef: MutableRefObject<
    (generation: number) => boolean
  >;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const streamingFinalizedRef = useRef<boolean>(false);
  const batchProcessedForCurrentUtteranceRef = useRef<boolean>(false);
  const [partialTranscription, setPartialTranscription] = useState<string>("");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  const openStreamingSocket = useCallback(() => {
    const currentSelected = selectedSttProviderRef.current;
    if (currentSelected.provider === "local-fluidaudio") return;

    const currentProviders = allSttProvidersRef.current;
    const providerConfig = currentProviders.find(
      (p) => p.id === currentSelected.provider
    );
    if (!providerConfig?.streaming) return;

    if (wsRef.current) {
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        return;
      }
    }

    streamingFinalizedRef.current = false;
    batchProcessedForCurrentUtteranceRef.current = false;

    try {
      const wsUrl = buildStreamingUrl(providerConfig, currentSelected);
      const ws = new WebSocket(wsUrl);
      const generation = captureGenerationRef.current;
      ws.binaryType = "arraybuffer";
      const isActive = () =>
        isActiveStreamingSession(
          wsRef.current,
          ws,
          generation,
          isCaptureGenerationCurrentRef.current
        );

      ws.onopen = () => {
        if (!isActive()) return;
        ws.send(
          JSON.stringify({
            sample_rate: capturedSampleRateRef.current,
          })
        );
        setIsStreaming(true);
      };

      ws.onmessage = (event) => {
        if (!isActive()) return;
        try {
          const data = JSON.parse(event.data);
          if (data.error) {
            console.error("[STT-Stream] Server error:", data.error);
            return;
          }
          if (data.is_final) {
            setPartialTranscription("");
            setIsStreaming(false);
            streamingFinalizedRef.current = true;
            onFinalTranscriptRef.current(data.text || "");
            ws.close();
          } else if (data.text) {
            setPartialTranscription(data.text);
          }
        } catch (e) {
          console.error("[STT-Stream] Failed to parse message:", e);
        }
      };

      ws.onerror = (e) => {
        if (!isActive()) return;
        console.error("[STT-Stream] WebSocket error:", e);
        setIsStreaming(false);
      };

      ws.onclose = () => {
        if (!isActive()) return;
        wsRef.current = null;
        setIsStreaming(false);
      };

      wsRef.current = ws;
    } catch (err) {
      console.error("[STT-Stream] Failed to open WebSocket:", err);
    }
  }, [
    selectedSttProviderRef,
    allSttProvidersRef,
    capturedSampleRateRef,
    onFinalTranscriptRef,
    captureGenerationRef,
    isCaptureGenerationCurrentRef,
  ]);

  const closeStreamingSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsStreaming(false);
    setPartialTranscription("");
  }, []);

  const sendAudioChunk = useCallback((base64Audio: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    const binaryString = atob(base64Audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    wsRef.current.send(bytes.buffer);
  }, []);

  return {
    isStreaming,
    partialTranscription,
    openStreamingSocket,
    closeStreamingSocket,
    sendAudioChunk,
    streamingFinalizedRef,
    batchProcessedForCurrentUtteranceRef,
  };
}
