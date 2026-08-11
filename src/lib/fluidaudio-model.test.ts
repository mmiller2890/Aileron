import { describe, expect, it } from "vitest";
import { normalizeFluidAudioModel } from "./fluidaudio-model";

describe("FluidAudio model selection", () => {
  it("accepts only v2 and v3", () => {
    expect(normalizeFluidAudioModel("v2")).toBe("v2");
    expect(normalizeFluidAudioModel("v3")).toBe("v3");
  });

  it("defaults missing and invalid values to v3", () => {
    expect(normalizeFluidAudioModel(undefined)).toBe("v3");
    expect(normalizeFluidAudioModel("turbo")).toBe("v3");
  });
});
