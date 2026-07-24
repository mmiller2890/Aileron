import { ChatConversation } from "@/types/completion";

/**
 * Typed contract for cross-window live-session sync. The overlay webview hosts
 * the capture engine; the dashboard mirrors it. Event names and payload shapes
 * live ONLY here — both sides import them, so they cannot drift.
 */

/** Overlay → broadcast: the current session snapshot. */
export const LIVE_SESSION_STATE = "live-session-state";

/** Dashboard → overlay: ask for an immediate snapshot (fresh mount/focus). */
export const LIVE_SESSION_REQUEST = "live-session-request";

/** Dashboard → overlay: run an engine action. */
export const LIVE_SESSION_COMMAND = "live-session-command";

/**
 * Existing Rust-emitted overlay-visibility event, typed here for listeners.
 * Payload is `isHidden`: `true` means the overlay is NOW HIDDEN.
 */
export const TOGGLE_WINDOW_VISIBILITY = "toggle-window-visibility";

/**
 * The snapshot's embedded conversation keeps only the newest messages — the
 * live feed shows the current session; deep history is the DB's job.
 */
export const LIVE_SNAPSHOT_MAX_MESSAGES = 50;

export interface LiveSessionSnapshot {
  capturing: boolean;
  isContinuousMode: boolean;
  isRecordingInContinuousMode: boolean;
  isProcessing: boolean;
  isAIProcessing: boolean;
  error: string;
  setupRequired: boolean;
  isSttInitializing: boolean;
  partialTranscription: string;
  isStreaming: boolean;
  lastAIResponse: string;
  conversation: ChatConversation;
  sessionStartedAt: number | null;
  currentSpeaker: string | null;
  isLabelingSpeakers: boolean;
  sessionSummary: string;
  isSummarizing: boolean;
  audioLevel: number;
  noAudioDetected: boolean;
}

export type LiveSessionCommandAction =
  | "start-capture"
  | "stop-capture"
  | "start-recording"
  | "stop-and-send"
  | "ignore-recording"
  | "answer-last"
  | "new-conversation"
  | "dismiss-summary"
  | "setup"
  | "submit";

/** `submit` carries the typed prompt; every other action is a bare verb. */
export type LiveSessionCommand =
  | { action: Exclude<LiveSessionCommandAction, "submit"> }
  | { action: "submit"; text: string };

export function deriveLiveAnswerDraft(
  snapshot: LiveSessionSnapshot | null
): string | null {
  return snapshot?.isAIProcessing ? snapshot.lastAIResponse : null;
}

/**
 * The one status ladder for rendering session state (word + slate classes).
 * Priority mirrors the overlay's StatusIndicator: error > answering >
 * transcribing > recording/listening > armed (manual, idle) > idle.
 */
export function deriveSessionStatus(snapshot: LiveSessionSnapshot | null): {
  word: string;
  cls: string;
  dot: string;
} {
  if (!snapshot) {
    return { word: "idle", cls: "text-meta", dot: "bg-meta" };
  }
  if (snapshot.error && !snapshot.setupRequired) {
    return { word: "error", cls: "text-destructive", dot: "bg-destructive" };
  }
  if (snapshot.isAIProcessing) {
    return { word: "answering", cls: "text-primary", dot: "bg-primary" };
  }
  if (snapshot.isProcessing) {
    return {
      word: "transcribing",
      cls: "text-muted-foreground",
      dot: "bg-muted-foreground",
    };
  }
  if (snapshot.capturing) {
    if (snapshot.isContinuousMode && !snapshot.isRecordingInContinuousMode) {
      return { word: "armed", cls: "text-warn", dot: "bg-warn" };
    }
    return {
      word: snapshot.isContinuousMode ? "recording" : "listening",
      cls: "text-primary",
      dot: "bg-primary",
    };
  }
  return { word: "idle", cls: "text-meta", dot: "bg-meta" };
}

/** A notice the embedded bar surfaces above its controls. */
export type BarNotice =
  | { kind: "setup"; message: string }
  | { kind: "error"; message: string }
  | { kind: "init"; message: string }
  | null;

/**
 * Turns the snapshot's `setupRequired`/`error`/`isSttInitializing` into a bar
 * notice, in priority order: a missing screen/audio permission (`setupRequired`)
 * outranks a generic error, which outranks the transient "preparing speech
 * models" state. The setup>error rule mirrors `error && !setupRequired` in
 * `deriveSessionStatus` and the overlay's StatusIndicator. Without this the
 * dashboard bar renders none of these and goes silent when capture can't start
 * or while models load.
 */
export function deriveBarNotice(snapshot: LiveSessionSnapshot | null): BarNotice {
  if (!snapshot) return null;
  if (snapshot.setupRequired) {
    return {
      kind: "setup",
      message: "Screen & system audio recording permission needed",
    };
  }
  if (snapshot.error) {
    return { kind: "error", message: snapshot.error };
  }
  if (snapshot.isSttInitializing) {
    return {
      kind: "init",
      message: "Preparing local speech models — first run may take 20–50s",
    };
  }
  return null;
}
