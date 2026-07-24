import { describe, expect, test } from "vitest";
import {
  isApiKeyOptional,
  omitEmptyApiKeyHeaders,
} from "./provider-auth";

describe("isApiKeyOptional", () => {
  test.each([
    "http://localhost:11434/v1/chat/completions",
    "http://LOCALHOST:1234/v1/chat/completions",
    "http://127.0.0.1:11434/v1/chat/completions",
    "http://127.42.8.9:8080/v1/chat/completions",
    "http://[::1]:11434/v1/chat/completions",
  ])("allows an empty key for loopback URL %s", (url) => {
    expect(isApiKeyOptional("custom-local", url)).toBe(true);
  });

  test.each(["ollama", "lm-studio"])(
    "retains the built-in %s exemption",
    (providerId) => {
      expect(
        isApiKeyOptional(providerId, "https://invalid.example/v1/chat")
      ).toBe(true);
    }
  );

  test.each([
    "https://api.openai.com/v1/chat/completions",
    "http://localhost.example.com/v1/chat",
    "http://127.example.com/v1/chat",
    "not a valid URL",
  ])("requires a key for non-loopback URL %s", (url) => {
    expect(isApiKeyOptional("custom-remote", url)).toBe(false);
  });
});

describe("omitEmptyApiKeyHeaders", () => {
  const resolved = {
    Authorization: "Bearer ",
    "X-API-Key": "",
    "Content-Type": "application/json",
    "X-Static": "present",
  };
  const templates = {
    Authorization: "Bearer {{API_KEY}}",
    "X-API-Key": "{{API_KEY}}",
    "Content-Type": "application/json",
    "X-Static": "present",
  };

  test("removes only headers templated with an empty API key", () => {
    expect(omitEmptyApiKeyHeaders(resolved, templates, "")).toEqual({
      "Content-Type": "application/json",
      "X-Static": "present",
    });
  });

  test("preserves all resolved headers when an API key is configured", () => {
    expect(omitEmptyApiKeyHeaders(resolved, templates, "secret")).toEqual(
      resolved
    );
  });
});
