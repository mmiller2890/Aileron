export type DictationStatus =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing";

export type DictationSyncAction = "start" | "stop" | "none";

export function dictationStopError(unexpected: boolean): string | null {
  return unexpected
    ? "Microphone input stopped unexpectedly — check your input device, then try again."
    : null;
}

/**
 * Reconcile the armed flag with the native dictation task's real status.
 *
 * The flag is the single source of truth, driven by both the mic button and
 * the global audio shortcut. Keeping the task in sync with it here is what
 * makes one click (or one hotkey press) arm *and* start: previously arming
 * only swapped the button in, leaving a second click to actually begin.
 */
export function dictationSyncAction(
  enabled: boolean,
  status: DictationStatus,
  hasError: boolean,
): DictationSyncAction {
  if (enabled) {
    // A failed start lands on idle with the error set. Auto-restarting on
    // that state spins: start -> fail -> idle -> start. Retry is explicit.
    if (hasError) return "none";
    return status === "idle" ? "start" : "none";
  }

  return status === "idle" ? "none" : "stop";
}
