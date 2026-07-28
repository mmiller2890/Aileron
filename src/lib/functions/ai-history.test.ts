import { describe, it, expect } from "vitest";
import {
  buildAIHistory,
  buildSummaryTranscript,
  MAX_AI_HISTORY_MESSAGES,
  MAX_SUMMARY_TRANSCRIPT_CHARS,
} from "./ai-history.function";
import { ChatMessage } from "@/types/completion";

// Conversation state is newest-first, so index 0 is the most recent message.
function msg(
  id: string,
  role: ChatMessage["role"],
  content: string,
  timestamp: number,
  speaker?: string
): ChatMessage {
  return { id, role, content, timestamp, ...(speaker ? { speaker } : {}) };
}

describe("buildAIHistory", () => {
  it("returns messages in chronological (oldest-first) order", () => {
    // Stored newest-first (how the conversation state holds them).
    const stored = [
      msg("m3", "assistant", "third", 300),
      msg("m2", "user", "second", 200),
      msg("m1", "user", "first", 100),
    ];
    const result = buildAIHistory(stored);
    expect(result.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("caps the window at MAX_AI_HISTORY_MESSAGES most-recent messages", () => {
    // 20 messages, newest (highest ts) first.
    const stored = Array.from({ length: 20 }, (_, i) =>
      msg(`m${i}`, "user", `msg-${20 - i}`, (20 - i) * 100)
    );
    const result = buildAIHistory(stored);
    expect(result).toHaveLength(MAX_AI_HISTORY_MESSAGES);
    // Should be the 12 most recent, chronological: msg-9 .. msg-20.
    expect(result[0].content).toBe("msg-9");
    expect(result[result.length - 1].content).toBe("msg-20");
  });

  it("excludes the message being answered so it isn't duplicated", () => {
    const stored = [
      msg("live", "user", "the current question", 300),
      msg("m2", "assistant", "earlier answer", 200),
      msg("m1", "user", "earlier question", 100),
    ];
    const result = buildAIHistory(stored, "live");
    expect(result.map((m) => m.content)).toEqual([
      "earlier question",
      "earlier answer",
    ]);
    expect(result.some((m) => m.content === "the current question")).toBe(false);
  });

  it("strips id/timestamp/speaker down to role + content", () => {
    const stored = [msg("m1", "user", "hi", 100)];
    expect(buildAIHistory(stored)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("handles an empty conversation", () => {
    expect(buildAIHistory([])).toEqual([]);
  });

  // The overlay chat stores messages oldest-first, the live session
  // newest-first. Both call this, so the window must be picked by timestamp
  // rather than by array position.
  it("keeps the most recent messages regardless of input ordering", () => {
    const oldestFirst = Array.from({ length: 20 }, (_, i) =>
      msg(`m${i}`, "user", `msg-${i + 1}`, (i + 1) * 100)
    );
    const newestFirst = [...oldestFirst].reverse();

    const fromOldest = buildAIHistory(oldestFirst);
    const fromNewest = buildAIHistory(newestFirst);

    expect(fromOldest).toEqual(fromNewest);
    expect(fromOldest).toHaveLength(MAX_AI_HISTORY_MESSAGES);
    expect(fromOldest[0].content).toBe("msg-9");
    expect(fromOldest[fromOldest.length - 1].content).toBe("msg-20");
  });
});

describe("buildSummaryTranscript", () => {
  it("renders chronologically with speaker attribution", () => {
    const stored = [
      msg("m3", "assistant", "third", 300),
      msg("m2", "user", "second", 200, "Speaker 1"),
      msg("m1", "user", "first", 100),
    ];
    expect(buildSummaryTranscript(stored)).toBe(
      "Speaker: first\nSpeaker 1: second\nAssistant: third"
    );
  });

  it("keeps the most recent turns when over the character budget", () => {
    // Each line is ~60 chars; enough of them to blow the budget.
    const count = Math.ceil(MAX_SUMMARY_TRANSCRIPT_CHARS / 50) + 20;
    const stored = Array.from({ length: count }, (_, i) =>
      msg(`m${i}`, "user", `line-${count - i}`.padEnd(50, "x"), (count - i) * 100)
    );
    const result = buildSummaryTranscript(stored);

    expect(result.length).toBeLessThanOrEqual(MAX_SUMMARY_TRANSCRIPT_CHARS);
    // The newest turn survives; the oldest is dropped.
    expect(result).toContain(`line-${count}`);
    expect(result).not.toContain("line-1x");
    // Truncation is disclosed so the model knows it's a partial transcript.
    expect(result).toContain("[earlier transcript truncated]");
  });

  it("does not truncate a transcript within budget", () => {
    const stored = [msg("m1", "user", "short", 100)];
    const result = buildSummaryTranscript(stored);
    expect(result).toBe("Speaker: short");
    expect(result).not.toContain("truncated");
  });

  it("handles an empty conversation", () => {
    expect(buildSummaryTranscript([])).toBe("");
  });
});
