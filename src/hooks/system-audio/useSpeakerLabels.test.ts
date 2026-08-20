import { describe, expect, it } from "vitest";
import { getSpeakerForUtterance } from "./useSpeakerLabels";

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
