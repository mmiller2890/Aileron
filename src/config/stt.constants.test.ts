import { describe, expect, it } from "vitest";
import { SPEECH_TO_TEXT_PROVIDERS } from "./stt.constants";

describe("Local Parakeet provider", () => {
  const parakeet = SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === "local-parakeet");

  it("posts to the local parakeet_server.py on port 8001", () => {
    expect(parakeet).toBeDefined();
    expect(parakeet?.curl).toContain("http://localhost:8001/v1/audio/transcriptions");
    expect(parakeet?.responseContentPath).toBe("text");
  });

  it("needs nothing but the audio: no API key or model to fill in", () => {
    const variables = [...(parakeet?.curl ?? "").matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    expect(variables).toEqual(["AUDIO"]);
  });

  it("does not collide with another provider", () => {
    const ids = SPEECH_TO_TEXT_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
