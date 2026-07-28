import { ChatMessage, Message } from "@/types/completion";

/**
 * Cap on how many prior messages are sent as AI context. Without a window, an
 * hour-long session grows the prompt without bound (cost, latency, and
 * eventually context-window overflow).
 */
export const MAX_AI_HISTORY_MESSAGES = 12;

/**
 * Build the AI context window from conversation state.
 *
 * The model needs messages **oldest-first** (chronological). This drops the
 * message currently being answered (so it isn't duplicated as both history and
 * the live user turn), sorts by timestamp, and keeps the most recent
 * `MAX_AI_HISTORY_MESSAGES`.
 *
 * Ordering-agnostic by design: the live-session state holds messages
 * newest-first while the overlay chat holds them oldest-first, and both call
 * this. Sorting *before* the window is what makes that safe — slicing first
 * would keep the oldest messages for an oldest-first caller.
 *
 * Regression guard: an earlier version sent the full history newest-first, so
 * the model saw the entire conversation reversed.
 */
export function buildAIHistory(
  messages: ChatMessage[],
  excludeMessageId?: string
): Message[] {
  return messages
    .filter((m) => m.id !== excludeMessageId)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-MAX_AI_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Character budget for the post-session summary transcript. The summary sends
 * the whole session rather than a `MAX_AI_HISTORY_MESSAGES` window, so it needs
 * its own bound: a long meeting would otherwise overflow the context window.
 * Sized to leave room for the summary instructions and the response.
 */
export const MAX_SUMMARY_TRANSCRIPT_CHARS = 24000;

const TRUNCATION_MARKER = "[earlier transcript truncated]";

/**
 * Render conversation state as a chronological, speaker-attributed transcript
 * for summarization, capped at `MAX_SUMMARY_TRANSCRIPT_CHARS`.
 *
 * State is newest-first; the output is oldest-first. When the session exceeds
 * the budget the *oldest* turns are dropped (the end of a meeting carries the
 * conclusions and action items) and the loss is disclosed to the model rather
 * than silently truncating mid-thought.
 */
export function buildSummaryTranscript(messages: ChatMessage[]): string {
  const chronological = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  const lines = chronological.map((m) => {
    const who = m.role === "assistant" ? "Assistant" : m.speaker || "Speaker";
    return `${who}: ${m.content}`;
  });

  const kept: string[] = [];
  let budget = MAX_SUMMARY_TRANSCRIPT_CHARS;

  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + 1;
    if (budget - cost < 0) break;
    budget -= cost;
    kept.unshift(lines[i]);
  }

  if (kept.length === lines.length) {
    return kept.join("\n");
  }
  return [TRUNCATION_MARKER, ...kept].join("\n").slice(0, MAX_SUMMARY_TRANSCRIPT_CHARS);
}
