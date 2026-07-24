import { describe, expect, test } from "vitest";
import { RecentSpeechEventFingerprints } from "./speech-event-dedupe";

const payload = (
  audio: string,
  start_time = 1.25,
  end_time = 2.5
) => ({
  audio,
  start_time,
  end_time,
});

describe("RecentSpeechEventFingerprints", () => {
  test("rejects an immediate duplicate", () => {
    const recent = new RecentSpeechEventFingerprints();
    const event = payload("audio-a");

    expect(recent.claim(event, 1_000)).toBe(true);
    expect(recent.claim(event, 1_001)).toBe(false);
  });

  test("rejects an A-B-A duplicate", () => {
    const recent = new RecentSpeechEventFingerprints();

    expect(recent.claim(payload("audio-a"), 1_000)).toBe(true);
    expect(recent.claim(payload("audio-b"), 1_001)).toBe(true);
    expect(recent.claim(payload("audio-a"), 1_002)).toBe(false);
  });

  test("accepts the same payload after sixty seconds", () => {
    const recent = new RecentSpeechEventFingerprints();
    const event = payload("audio-a");

    expect(recent.claim(event, 1_000)).toBe(true);
    expect(recent.claim(event, 61_001)).toBe(true);
  });

  test("accepts the same payload after a capture boundary", () => {
    const recent = new RecentSpeechEventFingerprints();
    const event = payload("audio-a");

    expect(recent.claim(event, 1_000)).toBe(true);
    recent.clear();
    expect(recent.claim(event, 1_001)).toBe(true);
  });

  test("keeps events with different timestamps distinct", () => {
    const recent = new RecentSpeechEventFingerprints();

    expect(recent.claim(payload("audio-a", 1, 2), 1_000)).toBe(true);
    expect(recent.claim(payload("audio-a", 2, 3), 1_001)).toBe(true);
  });

  test("retains at most thirty-two fingerprints", () => {
    const recent = new RecentSpeechEventFingerprints();

    for (let index = 0; index < 33; index += 1) {
      expect(recent.claim(payload(`audio-${index}`), index)).toBe(true);
    }

    expect(recent.size).toBe(32);
    expect(recent.claim(payload("audio-0"), 34)).toBe(true);
    expect(recent.size).toBe(32);
  });
});
