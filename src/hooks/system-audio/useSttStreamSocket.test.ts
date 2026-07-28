import { describe, expect, it } from "vitest";
import { isActiveStreamingSession } from "./useSttStreamSocket";

describe("isActiveStreamingSession", () => {
  it("accepts only the current socket in the current capture generation", () => {
    const currentSocket = {};
    const staleSocket = {};
    const isCurrentGeneration = (generation: number) => generation === 2;

    expect(
      isActiveStreamingSession(
        currentSocket,
        currentSocket,
        2,
        isCurrentGeneration
      )
    ).toBe(true);
    expect(
      isActiveStreamingSession(
        currentSocket,
        staleSocket,
        2,
        isCurrentGeneration
      )
    ).toBe(false);
    expect(
      isActiveStreamingSession(
        currentSocket,
        currentSocket,
        1,
        isCurrentGeneration
      )
    ).toBe(false);
  });
});
