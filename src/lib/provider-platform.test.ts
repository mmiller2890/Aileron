import { describe, expect, it } from "vitest";
import { SPEECH_TO_TEXT_PROVIDERS } from "@/config/stt.constants";
import {
  liveFeaturesAvailableOn,
  provider_visible_on,
  sttFallbackFor,
} from "./provider-platform";

const providerPlatform = (id: string) =>
  SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === id)?.platform;

describe("provider_visible_on", () => {
  it("offers the in-process Apple engine only on macOS", () => {
    expect(provider_visible_on("macos", "macos-apple-silicon")).toBe(true);
    expect(provider_visible_on("linux", "macos-apple-silicon")).toBe(false);
    expect(provider_visible_on("windows", "macos-apple-silicon")).toBe(false);
  });

  it("offers the local servers on Windows and Linux", () => {
    expect(provider_visible_on("linux", "windows-linux")).toBe(true);
    expect(provider_visible_on("windows", "windows-linux")).toBe(true);
    expect(provider_visible_on("macos", "windows-linux")).toBe(false);
  });

  it("offers cloud providers and custom ones everywhere", () => {
    expect(provider_visible_on("linux", providerPlatform("groq"))).toBe(true);
    expect(provider_visible_on("macos", providerPlatform("openai-whisper"))).toBe(
      true,
    );
    expect(provider_visible_on("macos", undefined)).toBe(true);
  });
});

describe("a Mac saved on the Linux Parakeet provider", () => {
  it("is treated as unavailable and migrates to the Apple engine, never to :8001", () => {
    expect(provider_visible_on("macos", providerPlatform("local-parakeet"))).toBe(
      false,
    );
    expect(sttFallbackFor("macos").provider).toBe("local-fluidaudio");
  });

  it("leaves a Linux user on Local Whisper when nothing is selected", () => {
    expect(provider_visible_on("linux", providerPlatform("local-parakeet"))).toBe(
      true,
    );
    expect(sttFallbackFor("linux").provider).toBe("local-whisper");
  });
});

describe("liveFeaturesAvailableOn", () => {
  it("works with any provider on macOS", () => {
    expect(liveFeaturesAvailableOn("macos", "local-fluidaudio")).toBe(true);
    expect(liveFeaturesAvailableOn("macos", "groq")).toBe(true);
  });

  it("needs the Parakeet server elsewhere", () => {
    expect(liveFeaturesAvailableOn("linux", "local-parakeet")).toBe(true);
    expect(liveFeaturesAvailableOn("linux", "local-whisper")).toBe(false);
    expect(liveFeaturesAvailableOn("linux", "groq")).toBe(false);
  });
});
