import { describe, expect, it } from "vitest";
import {
  applySpeakerLabels,
  getSpeakerForUtterance,
  type SpeakerSegment,
} from "./useSpeakerLabels";

const speaker = (
  id: string,
  start: number,
  end: number,
): SpeakerSegment => ({
  speaker_id: id,
  start_time: start,
  end_time: end,
  quality_score: 0.9,
});

const userMessage = (id: string, timestamp: number, speaker?: string) => ({
  id,
  role: "user" as const,
  content: `utterance ${id}`,
  timestamp,
  ...(speaker ? { speaker } : {}),
});

describe("getSpeakerForUtterance", () => {
  it("ignores unusable diarization segments and selects the best overlap", () => {
    expect(
      getSpeakerForUtterance(1, 4, [
        {
          speaker_id: "bad",
          start_time: 1,
          end_time: 4,
          quality_score: 0,
        },
        {
          speaker_id: "speaker-1",
          start_time: 1.5,
          end_time: 3.5,
          quality_score: 0.8,
        },
        {
          speaker_id: "speaker-2",
          start_time: 3,
          end_time: 4,
          quality_score: 0.9,
        },
      ]),
    ).toBe("speaker-1");
  });

  it("returns null when every overlapping segment is unusable", () => {
    expect(
      getSpeakerForUtterance(0, 2, [
        {
          speaker_id: "bad",
          start_time: 0,
          end_time: 2,
          quality_score: 0,
        },
      ]),
    ).toBeNull();
  });
});

type UtteranceRecord = { messageId: string | null; start: number; end: number };

const record = (messageId: string | null, start: number, end: number): UtteranceRecord => ({
  messageId,
  start,
  end,
});

describe("applySpeakerLabels", () => {
  const segments: SpeakerSegment[] = [
    speaker("speaker-a", 0, 10),
    speaker("speaker-b", 20, 30),
  ];

  it("labels each accepted message by its own utterance window", () => {
    const messages = [userMessage("m1", 1000), userMessage("m2", 2000)];

    const labeled = applySpeakerLabels(messages, segments, [
      record("m1", 1, 9),
      record("m2", 21, 29),
    ]);

    expect(labeled.find((m) => m.id === "m1")?.speaker).toBe("speaker-a");
    expect(labeled.find((m) => m.id === "m2")?.speaker).toBe("speaker-b");
  });

  it("ignores records for failed, dropped, or untimed utterances", () => {
    const messages = [
      userMessage("accepted", 3000),
      userMessage("typed", 4000),
    ];

    const labeled = applySpeakerLabels(messages, segments, [
      record(null, 1, 9),
      record("m-gone", 21, 29),
      record("accepted", 1, 9),
    ]);

    expect(labeled.find((m) => m.id === "accepted")?.speaker).toBe("speaker-a");
    expect(labeled.find((m) => m.id === "typed")?.speaker).toBeUndefined();
  });

  it("keeps timing bound to message identity when STT completes out of order", () => {
    const messages = [
      userMessage("m-late", 1000),
      userMessage("m-early", 2000),
    ];

    const labeled = applySpeakerLabels(messages, segments, [
      record("m-late", 1, 9),
      record("m-early", 21, 29),
    ]);

    expect(labeled.find((m) => m.id === "m-late")?.speaker).toBe("speaker-a");
    expect(labeled.find((m) => m.id === "m-early")?.speaker).toBe(
      "speaker-b",
    );
  });

  it("leaves messages from outside the capture untouched", () => {
    const messages = [
      userMessage("m-session", 1000),
      userMessage("m-assistant", 1500, "assistant-label"),
    ];

    const labeled = applySpeakerLabels(
      messages,
      segments,
      [record("m-session", 1, 9)],
    );

    expect(labeled.find((m) => m.id === "m-session")?.speaker).toBe(
      "speaker-a",
    );
    expect(labeled.find((m) => m.id === "m-assistant")?.speaker).toBe(
      "assistant-label",
    );
  });

  it("returns the same messages when nothing matches", () => {
    const messages = [userMessage("m-unrelated", 1000)];

    expect(applySpeakerLabels(messages, segments, [record(null, 1, 9)])).toBe(
      messages,
    );
  });
});
