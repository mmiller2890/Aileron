import { describe, it, expect } from "vitest";
import {
  describeError,
  providerEndpointLabel,
  redactProviderError,
} from "./common.function";

describe("describeError", () => {
  it("uses an Error's message", () => {
    expect(describeError(new Error("connection refused"))).toBe(
      "connection refused"
    );
  });

  // The Tauri HTTP plugin rejects with a bare string. `instanceof Error` is
  // false for these, which is how a real cause became "Unknown error".
  it("passes a thrown string through unchanged", () => {
    expect(describeError("error sending request for url (http://localhost:1234)")).toBe(
      "error sending request for url (http://localhost:1234)"
    );
  });

  it("reads a message property off a plain object", () => {
    expect(describeError({ message: "scope not allowed" })).toBe(
      "scope not allowed"
    );
  });

  it("serialises an object with no message", () => {
    expect(describeError({ code: 61, syscall: "connect" })).toBe(
      '{"code":61,"syscall":"connect"}'
    );
  });

  it("survives a circular object", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(typeof describeError(circular)).toBe("string");
  });

  it("returns empty string for null/undefined so callers can omit the detail", () => {
    expect(describeError(null)).toBe("");
    expect(describeError(undefined)).toBe("");
  });

  it("stringifies other primitives", () => {
    expect(describeError(504)).toBe("504");
  });
});

describe("provider error redaction", () => {
  it("shows only the endpoint origin", () => {
    expect(
      providerEndpointLabel(
        "https://alice:password@example.com/private/key?token=secret"
      )
    ).toBe("https://example.com");
  });

  it("removes URLs and configured secrets from transport details", () => {
    const result = redactProviderError(
      "request to https://alice:password@example.com/private?token=top-secret failed with top-secret",
      {
        API_KEY: "top-secret",
        MODEL: "qwen",
      }
    );

    expect(result).toBe(
      "request to https://example.com failed with [REDACTED]"
    );
    expect(result).not.toContain("password");
    expect(result).not.toContain("private");
    expect(result).not.toContain("top-secret");
  });

  it("does not redact non-secret provider variables", () => {
    expect(
      redactProviderError("model qwen failed", {
        MODEL: "qwen",
      })
    ).toBe("model qwen failed");
  });
});
