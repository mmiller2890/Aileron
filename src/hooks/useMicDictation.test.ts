import { describe, expect, it, vi } from "vitest";
import { startMicDictation } from "./useMicDictation";

describe("startMicDictation", () => {
  it("initializes v3 before opening a local FluidAudio microphone stream", async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await startMicDictation(invokeCommand, "local-fluidaudio", "Built-in Mic");

    expect(invokeCommand.mock.calls).toEqual([
      ["stt_init", { modelVersion: "v3" }],
      ["start_mic_dictation", { deviceId: "Built-in Mic" }],
    ]);
  });

  it("does not initialize FluidAudio for another provider", async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await startMicDictation(invokeCommand, "local-whisper", "default");

    expect(invokeCommand.mock.calls).toEqual([
      ["start_mic_dictation", { deviceId: null }],
    ]);
  });
});
