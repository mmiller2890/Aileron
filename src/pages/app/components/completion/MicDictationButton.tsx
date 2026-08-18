import { useEffect } from "react";
import { LoaderCircleIcon, MicIcon, MicOffIcon } from "lucide-react";
import { Button } from "@/components";
import { UseCompletionReturn } from "@/types";
import { useMicDictation } from "@/hooks/useMicDictation";
import { dictationSyncAction } from "@/lib/dictation-sync";

type MicDictationButtonProps = Pick<
  UseCompletionReturn,
  "submit" | "setState" | "enableVAD" | "setEnableVAD"
>;

export const MicDictationButton = ({
  submit,
  setState,
  enableVAD,
  setEnableVAD,
}: MicDictationButtonProps) => {
  const { status, error, start, stop, reset } = useMicDictation({
    submit,
    setState,
  });

  // `enableVAD` is the single source of truth for "voice input is on": the
  // global audio shortcut toggles it without ever touching this button. The
  // task is reconciled against it here so one click — or one hotkey press —
  // both arms and starts, instead of arming a task nothing goes on to start.
  useEffect(() => {
    const action = dictationSyncAction(enableVAD, status, Boolean(error));
    if (action === "start") {
      void start();
    } else if (action === "stop") {
      void stop();
    }
  }, [enableVAD, status, error, start, stop]);

  // Turning voice input off clears a failed start, so re-arming (by button or
  // hotkey) can try again. Without this the error latches and the sync guard
  // above refuses every later start.
  useEffect(() => {
    if (!enableVAD && error) {
      reset();
    }
  }, [enableVAD, error, reset]);

  const title = error
    ? `Voice input failed: ${error}. Click to reset.`
    : status === "starting"
      ? "Starting microphone…"
      : status === "listening"
        ? "Stop voice input"
        : status === "transcribing"
          ? "Transcribing…"
          : "Start voice input";

  return (
    <Button
      size="icon"
      title={title}
      className="cursor-pointer"
      onClick={() => setEnableVAD(!enableVAD)}
    >
      {error ? (
        <MicIcon className="h-4 w-4 text-destructive" />
      ) : status === "starting" ? (
        <LoaderCircleIcon className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : status === "transcribing" ? (
        <LoaderCircleIcon className="h-4 w-4 animate-spin text-primary" />
      ) : status === "listening" ? (
        <MicOffIcon className="h-4 w-4 animate-pulse text-primary" />
      ) : (
        <MicIcon className="h-4 w-4" />
      )}
    </Button>
  );
};
