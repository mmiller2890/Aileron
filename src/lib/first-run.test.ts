import { describe, expect, it } from "vitest";
import { AI_PROVIDERS } from "@/config/ai-providers.constants";
import {
  aiProviderReady,
  shouldShowSetup,
  SIMPLE_KEY_PROVIDERS,
  simpleAiChoice,
  speechSetupState,
  startsInAdvanced,
} from "./first-run";

describe("shouldShowSetup", () => {
  it("opens for a brand-new install", () => {
    expect(shouldShowSetup(null, null)).toBe(true);
    expect(shouldShowSetup(null, JSON.stringify({ provider: "" }))).toBe(true);
  });

  it("never opens for someone who already chose an AI provider", () => {
    expect(shouldShowSetup(null, JSON.stringify({ provider: "ollama" }))).toBe(
      false,
    );
  });

  it("never returns once finished or skipped, even with no provider", () => {
    expect(shouldShowSetup("1", null)).toBe(false);
  });

  it("treats unreadable storage as nothing chosen", () => {
    expect(shouldShowSetup(null, "{not json")).toBe(true);
    expect(shouldShowSetup(null, JSON.stringify({ provider: 7 }))).toBe(true);
  });
});

describe("aiProviderReady", () => {
  it("needs a provider", () => {
    expect(aiProviderReady("", [], {}, false)).toBe(false);
  });

  it("lets a provider on this machine go without an API key", () => {
    expect(aiProviderReady("ollama", ["MODEL", "API_KEY"], {}, true)).toBe(false);
    expect(
      aiProviderReady("ollama", ["MODEL", "API_KEY"], { MODEL: "llama3" }, true),
    ).toBe(true);
    expect(
      aiProviderReady("ollama", ["MODEL", "api_key"], { MODEL: "  " }, true),
    ).toBe(false);
  });

  it("needs the API key for a hosted provider", () => {
    const keys = ["API_KEY", "MODEL"];
    expect(aiProviderReady("claude", keys, { MODEL: "m" }, false)).toBe(false);
    expect(
      aiProviderReady("claude", keys, { MODEL: "m", API_KEY: "k" }, false),
    ).toBe(true);
  });

  it("is ready with a provider that needs no variables", () => {
    expect(aiProviderReady("custom", [], undefined, false)).toBe(true);
  });
});

describe("speechSetupState", () => {
  const base = {
    asrReady: false,
    isInitializing: false,
    error: null,
    progressLabel: null,
    progressFraction: null,
  };

  it("waits before anything has started", () => {
    expect(speechSetupState(base)).toEqual({ kind: "waiting" });
  });

  it("reports progress while a model downloads", () => {
    expect(
      speechSetupState({
        ...base,
        isInitializing: true,
        progressLabel: "Downloading speech models",
        progressFraction: 0.4,
      }),
    ).toEqual({
      kind: "preparing",
      label: "Downloading speech models",
      fraction: 0.4,
    });
  });

  it("stays in progress while the optional live models follow the main one", () => {
    expect(
      speechSetupState({ ...base, asrReady: true, isInitializing: true }).kind,
    ).toBe("preparing");
  });

  it("is ready once the speech model is loaded", () => {
    expect(speechSetupState({ ...base, asrReady: true })).toEqual({
      kind: "ready",
    });
  });

  it("reports a failed download", () => {
    expect(speechSetupState({ ...base, error: "offline" })).toEqual({
      kind: "failed",
      message: "offline",
    });
  });
});

describe("the simple AI choices", () => {
  it("only offers providers the app ships", () => {
    const shipped = AI_PROVIDERS.map((provider) => provider.id);
    for (const provider of SIMPLE_KEY_PROVIDERS) {
      expect(shipped).toContain(provider.id);
    }
    expect(shipped).toContain("ollama");
  });

  it("sorts a selected provider into its choice", () => {
    expect(simpleAiChoice("ollama")).toBe("local");
    expect(simpleAiChoice("claude")).toBe("key");
    expect(simpleAiChoice("lm-studio")).toBeNull();
    expect(simpleAiChoice("")).toBeNull();
  });

  it("opens the advanced view for a provider the simple one cannot show", () => {
    expect(startsInAdvanced("lm-studio")).toBe(true);
    expect(startsInAdvanced("my-custom-endpoint")).toBe(true);
    expect(startsInAdvanced("ollama")).toBe(false);
    expect(startsInAdvanced("")).toBe(false);
  });
});
