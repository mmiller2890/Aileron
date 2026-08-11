export type FluidAudioModel = "v2" | "v3";

export function normalizeFluidAudioModel(
  value: string | undefined
): FluidAudioModel {
  return value === "v2" ? "v2" : "v3";
}
