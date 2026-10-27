import { describe, expect, it } from "vitest";
import {
  liveSpeakersEndpointFor,
  liveTextEndpointFor,
} from "./live-text-endpoint";

describe("liveTextEndpointFor", () => {
  it("streams live text from the local Parakeet server off macOS", () => {
    expect(liveTextEndpointFor("local-parakeet", "linux")).toBe(
      "http://localhost:8001/v1/audio/transcriptions",
    );
    expect(liveTextEndpointFor("local-parakeet", "windows")).toBe(
      "http://localhost:8001/v1/audio/transcriptions",
    );
  });

  it("leaves macOS to FluidAudio's own streaming model", () => {
    expect(liveTextEndpointFor("local-parakeet", "macos")).toBeNull();
    expect(liveTextEndpointFor("local-fluidaudio", "macos")).toBeNull();
  });

  it("never streams turn audio to other providers", () => {
    expect(liveTextEndpointFor("local-whisper", "linux")).toBeNull();
    expect(liveTextEndpointFor("openai-whisper", "linux")).toBeNull();
    expect(liveTextEndpointFor("", "linux")).toBeNull();
  });
});

describe("liveSpeakersEndpointFor", () => {
  it("sends no speaker audio off macOS while the server's labels are unreliable", () => {
    // Measured on the PC: 3 of 14 lines labelled, slots jumping between turns,
    // and ~0.3 s of diarizing per turn holding the lock finals need.
    expect(liveSpeakersEndpointFor("local-parakeet", "linux")).toBeNull();
    expect(liveSpeakersEndpointFor("local-parakeet", "windows")).toBeNull();
  });

  it("leaves macOS to FluidAudio's streaming diarizer", () => {
    expect(liveSpeakersEndpointFor("local-parakeet", "macos")).toBeNull();
  });

  it("sends no audio to a server that cannot diarize", () => {
    expect(liveSpeakersEndpointFor("local-whisper", "linux")).toBeNull();
    expect(liveSpeakersEndpointFor("groq", "linux")).toBeNull();
  });
});
