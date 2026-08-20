import { describe, expect, it } from "vitest";
import { advanceSttProgress, formatSttProgressPhase } from "./useSttStatus";

describe("FluidAudio initialization progress", () => {
  it("keeps progress monotonic and clamps invalid fractions", () => {
    const first = advanceSttProgress(null, {
      fraction_completed: 0.6,
      phase: "downloading",
    });
    const stale = advanceSttProgress(first, {
      fraction_completed: 0.2,
      phase: "downloading",
    });
    const complete = advanceSttProgress(stale, {
      fraction_completed: 2,
      phase: "compiling",
      model_name: "Encoder.mlmodelc",
    });

    expect(first.fractionCompleted).toBe(0.6);
    expect(stale.fractionCompleted).toBe(0.6);
    expect(complete.fractionCompleted).toBe(1);
  });

  it("formats download and CoreML compilation phases", () => {
    expect(formatSttProgressPhase({
      fractionCompleted: 0.25,
      phase: "downloading",
    })).toBe("Downloading speech models");
    expect(formatSttProgressPhase({
      fractionCompleted: 0.8,
      phase: "compiling",
      modelName: "Encoder",
    })).toBe("Compiling Encoder for CoreML");
  });
});
