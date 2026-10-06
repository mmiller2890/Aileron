import { describe, expect, it } from "vitest";
import { speakerAccent, speakerSlot } from "./speaker-style";

describe("speaker style", () => {
  it("maps the four live labels to distinct accents", () => {
    const accents = [1, 2, 3, 4].map((n) => speakerAccent(`Speaker ${n}`));
    expect(accents.every((accent) => accent !== null)).toBe(true);
    expect(new Set(accents).size).toBe(4);
  });

  it("reads the slot regardless of case and spacing", () => {
    expect(speakerSlot("speaker 2")).toBe(1);
    expect(speakerSlot("  SPEAKER   3 ")).toBe(2);
  });

  it("gives no accent to labels that are not live speaker slots", () => {
    expect(speakerAccent(null)).toBeNull();
    expect(speakerAccent("")).toBeNull();
    expect(speakerAccent("heard")).toBeNull();
    expect(speakerAccent("Speaker 0")).toBeNull();
    expect(speakerAccent("Speaker 5")).toBeNull();
    expect(speakerAccent("S1")).toBeNull();
  });
});
