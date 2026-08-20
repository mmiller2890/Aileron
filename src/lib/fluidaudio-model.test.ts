import { describe, expect, it } from "vitest";
import { normalizeFluidAudioModel } from "./fluidaudio-model";

describe("FluidAudio model selection", () => {
  it("normalizes stale v2 and current v3 settings to v3", () => {
    expect(normalizeFluidAudioModel("v2")).toBe("v3");
    expect(normalizeFluidAudioModel("v3")).toBe("v3");
  });

  it("defaults missing and invalid values to v3", () => {
    expect(normalizeFluidAudioModel(undefined)).toBe("v3");
    expect(normalizeFluidAudioModel("turbo")).toBe("v3");
  });
});
