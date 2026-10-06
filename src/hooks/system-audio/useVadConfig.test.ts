import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAD_CONFIG,
  vadDurationSeconds,
} from "./useVadConfig";

describe("VAD defaults and durations", () => {
  it("keeps the tuned reset values canonical", () => {
    expect(DEFAULT_VAD_CONFIG.silence_chunks).toBe(45);
    expect(DEFAULT_VAD_CONFIG.live_text).toBe(true);
    expect(DEFAULT_VAD_CONFIG.pre_speech_chunks).toBe(30);
    expect(DEFAULT_VAD_CONFIG.compare_preprocessing).toBe(false);
  });

  it("uses the active capture sample rate", () => {
    expect(vadDurationSeconds(DEFAULT_VAD_CONFIG, 48_000)).toBeCloseTo(
      0.96,
      3
    );
    expect(vadDurationSeconds(DEFAULT_VAD_CONFIG, 44_100)).toBeCloseTo(
      1.045,
      3
    );
  });
});
