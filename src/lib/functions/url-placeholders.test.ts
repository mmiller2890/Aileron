import { describe, it, expect } from "vitest";
import curl2Json from "@bany/curl-to-json";
import {
  restoreUrlPlaceholders,
  deepVariableReplacer,
  resolveCurlUrl,
} from "./common.function";

/** Mirrors how the request paths resolve a provider's URL. */
const resolveUrl = (curl: string, variables: Record<string, string>) =>
  deepVariableReplacer(
    restoreUrlPlaceholders(curl2Json(curl).url || ""),
    variables
  );

describe("restoreUrlPlaceholders", () => {
  it("re-uppercases a host placeholder lowercased by URL parsing", () => {
    expect(restoreUrlPlaceholders("http://{{host}}:11434/v1/chat")).toBe(
      "http://{{HOST}}:11434/v1/chat"
    );
  });

  it("decodes a percent-encoded path placeholder", () => {
    expect(
      restoreUrlPlaceholders("https://x.com/v1/models/%7B%7BMODEL%7D%7D/chat")
    ).toBe("https://x.com/v1/models/{{MODEL}}/chat");
  });

  it("handles lowercase percent-encoding", () => {
    expect(restoreUrlPlaceholders("https://x.com/%7b%7bMODEL%7d%7d")).toBe(
      "https://x.com/{{MODEL}}"
    );
  });

  it("restores several placeholders in one URL", () => {
    expect(
      restoreUrlPlaceholders("https://x.com/%7B%7BMODEL%7D%7D?k=%7B%7BAPI_KEY%7D%7D")
    ).toBe("https://x.com/{{MODEL}}?k={{API_KEY}}");
  });

  it("leaves an already-correct URL untouched", () => {
    const url = "http://localhost:11434/v1/chat/completions";
    expect(restoreUrlPlaceholders(url)).toBe(url);
  });

  it("does not disturb unrelated percent-encoding", () => {
    const url = "https://x.com/a%20b/c?q=1%2B2";
    expect(restoreUrlPlaceholders(url)).toBe(url);
  });

  it("tolerates non-string input", () => {
    expect(restoreUrlPlaceholders(undefined as unknown as string)).toBe("");
  });
});

describe("provider URL resolution end-to-end", () => {
  it("preserves and resolves query parameters parsed out of the URL", () => {
    const parsed = curl2Json(
      `curl -X POST "https://example.com/v1/chat?key={{API_KEY}}&model={{MODEL}}" -d '{}'`
    );

    expect(
      resolveCurlUrl(parsed, {
        API_KEY: "secret value",
        MODEL: "qwen/3",
      })
    ).toBe(
      "https://example.com/v1/chat?key=secret+value&model=qwen%2F3"
    );
  });

  it("substitutes a model placeholder in the path (Gemini-style)", () => {
    const curl = `curl -X POST https://generativelanguage.googleapis.com/v1beta/models/{{MODEL}}:generateContent -d '{}'`;
    expect(resolveUrl(curl, { MODEL: "gemini-3-flash" })).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent"
    );
  });

  it("substitutes a host placeholder", () => {
    const curl = `curl -X POST http://{{HOST}}:11434/v1/chat/completions -d '{}'`;
    expect(resolveUrl(curl, { HOST: "192.168.1.9" })).toBe(
      "http://192.168.1.9:11434/v1/chat/completions"
    );
  });

  it("leaves a URL without placeholders unchanged", () => {
    const curl = `curl -X POST http://localhost:11434/v1/chat/completions -d '{}'`;
    expect(resolveUrl(curl, { MODEL: "x" })).toBe(
      "http://localhost:11434/v1/chat/completions"
    );
  });
});
