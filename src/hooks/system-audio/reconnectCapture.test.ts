import { describe, expect, it } from "vitest";
import {
  reconnectCapture,
  requiresSessionBoundaryOnDeviceChange,
} from "./reconnectCapture";

describe("reconnectCapture", () => {
  it("ends a FluidAudio session on device change to preserve diarization timing", () => {
    expect(requiresSessionBoundaryOnDeviceChange("local-fluidaudio")).toBe(true);
    expect(requiresSessionBoundaryOnDeviceChange("local-whisper")).toBe(false);
    expect(requiresSessionBoundaryOnDeviceChange("groq")).toBe(false);
  });

  it("owns the stopping state across stop and restart", async () => {
    let stopping = false;
    const states: string[] = [];

    const outcome = await reconnectCapture({
      isCapturing: () => true,
      isStopping: () => stopping,
      setStopping: (value) => {
        stopping = value;
        states.push(`stopping:${value}`);
      },
      stop: async () => {
        states.push(`stop:${stopping}`);
      },
      start: async () => {
        states.push(`start:${stopping}`);
      },
    });

    expect(outcome).toBe("reconnected");
    expect(states).toEqual([
      "stopping:true",
      "stop:true",
      "start:true",
      "stopping:false",
    ]);
  });

  it("ignores duplicate recovery while a stop is already active", async () => {
    let attempted = false;

    const outcome = await reconnectCapture({
      isCapturing: () => true,
      isStopping: () => true,
      setStopping: () => {},
      stop: async () => {
        attempted = true;
      },
      start: async () => {
        attempted = true;
      },
    });

    expect(outcome).toBe("ignored");
    expect(attempted).toBe(false);
  });
});
