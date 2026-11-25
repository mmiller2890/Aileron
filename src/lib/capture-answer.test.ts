import { describe, expect, it } from "vitest";
import {
  CAPTURE_ANSWER_RULES,
  captureAnswerPrompt,
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
