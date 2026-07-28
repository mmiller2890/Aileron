import { describe, expect, it } from "vitest";
import { completedStreamValue } from "./completed-stream";

describe("completedStreamValue", () => {
  it("returns a completed response", () => {
    expect(completedStreamValue("complete answer", true)).toBe(
      "complete answer"
    );
  });

  it("rejects partial text from a failed stream", () => {
    expect(completedStreamValue("partial answer", false)).toBeNull();
  });
});
