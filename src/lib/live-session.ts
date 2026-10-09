import { ChatConversation, ChatMessage } from "@/types/completion";

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
 * Overlay → broadcast: the bar's own conversation (typed questions and voice
 * input). It lives outside the capture engine, so it has its own snapshot.
 */
export const LIVE_CHAT_STATE = "live-chat-state";

/** Dashboard → overlay: act on the bar's conversation. */
export const LIVE_CHAT_COMMAND = "live-chat-command";

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
  lastAIResponse: string;
  partialTranscription: string;
  partialSpeaker: string | null;
  conversation: ChatConversation;
  sessionStartedAt: number | null;
  currentSpeaker: string | null;
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

/** The bar's conversation as the dashboard mirrors it. */
export interface LiveChatSnapshot {
  /** Voice input is switched on. */
  listening: boolean;
  answering: boolean;
  answerDraft: string;
  error: string;
  conversation: ChatConversation;
}

export type LiveChatCommand =
  | { action: "submit"; text: string }
  | { action: "new-conversation" };

/**
 * Builds the bar's snapshot from its completion state. Saved history only
 * gains a question and its answer once the answer has finished and been
 * written, so the exchange in flight is added here: the question while the
 * answer streams, and the finished pair until the save lands.
 */
export function buildLiveChatSnapshot({
  conversationId,
  history,
  input,
  response,
  isLoading,
  error,
  listening,
  now = Date.now(),
}: {
  conversationId: string | null;
  history: ChatMessage[];
  input: string;
  response: string;
  isLoading: boolean;
  error: string | null;
  listening: boolean;
  now?: number;
}): LiveChatSnapshot {
  const messages = [...history];
  const last = messages[messages.length - 1];
  const pendingAt = Math.max(now, (last?.timestamp ?? 0) + 1);
  const saved = last?.role === "assistant" && last.content === response;
  if (isLoading || (response && !saved)) {
    if (input.trim()) {
      messages.push({
        id: "pending-user",
        role: "user",
        content: input,
        timestamp: pendingAt,
      });
    }
    if (!isLoading) {
      messages.push({
        id: "pending-assistant",
        role: "assistant",
        content: response,
        timestamp: pendingAt + 1,
      });
    }
  }
  return {
    listening,
    answering: isLoading,
    answerDraft: isLoading ? response : "",
    error: error ?? "",
    conversation: {
      id: conversationId ?? "",
      title: "",
      messages: messages.slice(-LIVE_SNAPSHOT_MAX_MESSAGES),
      createdAt: messages[0]?.timestamp ?? 0,
      updatedAt: messages[messages.length - 1]?.timestamp ?? 0,
    },
  };
}

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

/**
 * Which face the dashboard shows. "home" is the quiet starting screen; the
 * transcript layout takes over as soon as there is a session to look at and
 * stays until the conversation is cleared ("New session").
 */
export function deriveDashboardView(
  snapshot: LiveSessionSnapshot | null,
): "home" | "session" {
  if (!snapshot) return "home";
  if (
    snapshot.capturing ||
    snapshot.isProcessing ||
    snapshot.isAIProcessing ||
    snapshot.conversation.messages.length > 0
  ) {
    return "session";
  }
  return "home";
}

/**
 * Which conversation the dashboard shows: the capture session ("engine"), the
 * bar's own conversation ("chat"), or neither ("home"). Whatever is running
 * wins; with both idle, the conversation that changed last does.
 */
export function deriveDashboardSource(
  snapshot: LiveSessionSnapshot | null,
  chat: LiveChatSnapshot | null,
): "home" | "engine" | "chat" {
  const engineHasMessages =
    !!snapshot && snapshot.conversation.messages.length > 0;
  const chatHasMessages = !!chat && chat.conversation.messages.length > 0;
  if (
    snapshot?.capturing ||
    snapshot?.isProcessing ||
    snapshot?.isAIProcessing
  ) {
    return "engine";
  }
  if (chat?.listening || chat?.answering) return "chat";
  if (engineHasMessages && chatHasMessages) {
    return chat.conversation.updatedAt > snapshot.conversation.updatedAt
      ? "chat"
      : "engine";
  }
  if (engineHasMessages) return "engine";
  if (chatHasMessages) return "chat";
  return "home";
}

/** The status ladder for the bar's conversation, shaped like the session's. */
export function deriveChatStatus(chat: LiveChatSnapshot | null): {
  word: string;
  cls: string;
  dot: string;
} {
  if (chat?.error) {
    return { word: "error", cls: "text-destructive", dot: "bg-destructive" };
  }
  if (chat?.answering) {
    return { word: "answering", cls: "text-primary", dot: "bg-primary" };
  }
  if (chat?.listening) {
    return { word: "listening", cls: "text-primary", dot: "bg-primary" };
  }
  return { word: "idle", cls: "text-meta", dot: "bg-meta" };
}

/** Time-of-day greeting for the dashboard home (hour is 0–23, local). */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
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
