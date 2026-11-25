import { describe, expect, it } from "vitest";
import {
  CAPTURE_ANSWER_RULES,
  captureAnswerPrompt,
  IDLE_STOP_MS,
  idleStopDue,
  isAudible,
} from "./capture-answer";

describe("captureAnswerPrompt", () => {
  it("keeps the selected prompt first and adds the rules after it", () => {
    const prompt = captureAnswerPrompt("You are Morgan's interview copilot.");
    expect(prompt.startsWith("You are Morgan's interview copilot.")).toBe(true);
    expect(prompt.endsWith(CAPTURE_ANSWER_RULES)).toBe(true);
  });

  it("still has the rules when no prompt is selected", () => {
    expect(captureAnswerPrompt("")).toBe(CAPTURE_ANSWER_RULES);
    expect(captureAnswerPrompt("   ")).toBe(CAPTURE_ANSWER_RULES);
  });

  it("forbids the two failures seen in a real interview", () => {
    expect(CAPTURE_ANSWER_RULES).toMatch(/never say or imply that you are an AI/i);
    expect(CAPTURE_ANSWER_RULES).toMatch(/placeholders/i);
  });
});

describe("isAudible", () => {
  it("treats a silent tap as no audio and real audio as audio", () => {
    expect(isAudible(0)).toBe(false);
    expect(isAudible(0.001)).toBe(false);
    expect(isAudible(0.05)).toBe(true);
    expect(isAudible(Number.NaN)).toBe(false);
  });
});

describe("idleStopDue", () => {
  it("stops only after twenty minutes without audio", () => {
    const start = 1_000_000;
    expect(IDLE_STOP_MS).toBe(20 * 60 * 1000);
    expect(idleStopDue(start, start + IDLE_STOP_MS - 1)).toBe(false);
    expect(idleStopDue(start, start + IDLE_STOP_MS)).toBe(true);
    expect(idleStopDue(start, start + 6 * 60 * 60 * 1000)).toBe(true);
  });

  it("counts from the last audio, so a quiet stretch mid-call is safe", () => {
    const heardAt = 5_000_000;
    expect(idleStopDue(heardAt, heardAt + 15 * 60 * 1000)).toBe(false);
  });
});
