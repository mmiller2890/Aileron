import { fetchSTT } from "@/lib";
import { UseCompletionReturn } from "@/types";
import { useMicVAD } from "@ricky0123/vad-react";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components";
import { useApp } from "@/contexts";
import { floatArrayToWav } from "@/lib/utils";

interface AutoSpeechVADProps {
  submit: UseCompletionReturn["submit"];
  setState: UseCompletionReturn["setState"];
  setEnableVAD: UseCompletionReturn["setEnableVAD"];
  microphoneDeviceId?: string;
}

const AutoSpeechVADInternal = ({
  submit,
  setState,
  setEnableVAD,
  microphoneDeviceId,
}: AutoSpeechVADProps) => {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const { selectedSttProvider, allSttProviders } = useApp();

  const audioConstraints: MediaTrackConstraints =
    microphoneDeviceId && microphoneDeviceId !== "default"
      ? { deviceId: { exact: microphoneDeviceId } }
      : {};

  const vad = useMicVAD({
    userSpeakingThreshold: 0.6,
    startOnLoad: true,
    additionalAudioConstraints: audioConstraints,
    onSpeechEnd: async (audio) => {
      try {
        // Deferred: only providers that upload the audio need it encoded.
        const audioBlob = () => floatArrayToWav(audio, 16000, "wav");

        let transcription: string;

        // Check if we have a configured speech provider
        if (!selectedSttProvider.provider) {
          console.warn("No speech provider selected");
          setState((prev: any) => ({
            ...prev,
            error:
              "No speech provider selected. Please select one in settings.",
          }));
          return;
        }

        const providerConfig = allSttProviders.find(
          (p) => p.id === selectedSttProvider.provider
        );

        if (!providerConfig) {
          console.warn("Selected speech provider configuration not found");
          setState((prev: any) => ({
            ...prev,
            error:
              "Speech provider configuration not found. Please check your settings.",
          }));
          return;
        }

        setIsTranscribing(true);

        // Use the fetchSTT function for all providers
        transcription = await fetchSTT({
          provider: providerConfig,
          selectedProvider: selectedSttProvider,
          audio: audioBlob,
          // The local provider wants samples, and VAD already handed us the
          // exact 16kHz mono buffer — passing it skips encoding a WAV only to
          // decode it again through the Web Audio API.
          samples: audio,
        });

        if (transcription) {
          submit(transcription);
        }
      } catch (error) {
        console.error("Failed to transcribe audio:", error);
        setState((prev: any) => ({
          ...prev,
          error:
            error instanceof Error ? error.message : "Transcription failed",
        }));
      } finally {
        setIsTranscribing(false);
      }
    },
  });

  // vad-react swallows init failures (mic permission denied, model/wasm CDN
  // fetch failed) into `errored`, and model download time into `loading` —
  // both previously rendered as a dead-looking mic button. Surface them.
  const vadError =
    vad.errored === false || vad.errored == null
      ? null
      : typeof vad.errored === "object" && "message" in (vad.errored as object)
        ? String((vad.errored as { message: unknown }).message)
        : String(vad.errored);

  useEffect(() => {
    if (vadError) {
      console.error("Voice input (VAD) failed to initialize:", vadError);
    }
  }, [vadError]);

  return (
    <>
      <Button
        size="icon"
        title={
          vadError
            ? `Voice input failed: ${vadError}. Click to reset — check mic permission and internet (the voice model loads from a CDN).`
            : vad.loading
              ? "Loading voice detection model…"
              : vad.listening
                ? "Stop voice input"
                : "Start voice input"
        }
        onClick={() => {
          if (vadError) {
            // Unmount + remount (via enableVAD) so the VAD re-initializes.
            setEnableVAD(false);
          } else if (vad.loading) {
            // Init in flight; ignore clicks rather than double-starting.
          } else if (vad.listening) {
            vad.pause();
            setEnableVAD(false);
          } else {
            vad.start();
            setEnableVAD(true);
          }
        }}
        className="cursor-pointer"
      >
        {vadError ? (
          <MicIcon className="h-4 w-4 text-destructive" />
        ) : vad.loading ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : isTranscribing ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin text-primary" />
        ) : vad.userSpeaking ? (
          <LoaderCircleIcon className="h-4 w-4 animate-spin" />
        ) : vad.listening ? (
          <MicOffIcon className="h-4 w-4 animate-pulse text-primary" />
        ) : (
          <MicIcon className="h-4 w-4" />
        )}
      </Button>
    </>
  );
};

export const AutoSpeechVAD = (props: AutoSpeechVADProps) => {
  return <AutoSpeechVADInternal key={props.microphoneDeviceId} {...props} />;
};
