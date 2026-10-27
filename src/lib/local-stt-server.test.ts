import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkLocalServer,
  localServerDownMessage,
  localServerHealthUrl,
  pickLinuxProvider,
} from "./local-stt-server";

const jsonResponse = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as Response;

describe("localServerHealthUrl", () => {
  it("finds each local provider's own address", () => {
    expect(localServerHealthUrl("local-parakeet")).toBe(
      "http://localhost:8001/health",
    );
    expect(localServerHealthUrl("local-whisper")).toBe(
      "http://localhost:8000/health",
    );
  });

  it("has nothing to check for a cloud provider", () => {
    expect(localServerHealthUrl("openai-whisper")).toBeNull();
    expect(localServerHealthUrl("groq")).toBeNull();
  });
});

describe("checkLocalServer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a ready server", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ status: "ok" }));
    await expect(
      checkLocalServer("http://localhost:8001/health", fetchFn as never),
    ).resolves.toBe("up");
  });

  it("reports a server that is still loading the model", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ status: "loading" }));
    await expect(
      checkLocalServer("http://localhost:8001/health", fetchFn as never),
    ).resolves.toBe("loading");
  });

  it("reports an unreachable server", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connection refused");
    });
    await expect(
      checkLocalServer("http://localhost:8001/health", fetchFn as never),
    ).resolves.toBe("down");
  });

  it("reports a non-2xx answer as down", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, false));
    await expect(
      checkLocalServer("http://localhost:8001/health", fetchFn as never),
    ).resolves.toBe("down");
  });

  it("gives up on a server that never answers", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const pending = checkLocalServer(
      "http://localhost:8001/health",
      fetchFn as never,
      1_500,
    );
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(pending).resolves.toBe("down");
  });
});

describe("pickLinuxProvider", () => {
  it("moves to Parakeet while it loads and Whisper is down", () => {
    expect(pickLinuxProvider("local-whisper", "loading", "down")).toBe(
      "local-parakeet",
    );
  });

  it("keeps a Whisper server the user is running", () => {
    expect(pickLinuxProvider("local-whisper", "up", "up")).toBeNull();
    expect(pickLinuxProvider("local-whisper", "down", "up")).toBeNull();
  });

  it("fills an empty choice when only Parakeet is up", () => {
    expect(pickLinuxProvider("", "up", "down")).toBe("local-parakeet");
  });

  it("leaves a deliberate cloud choice alone", () => {
    expect(pickLinuxProvider("openai-whisper", "up", "down")).toBeNull();
  });

  it("keeps Whisper when nothing is running", () => {
    expect(pickLinuxProvider("local-whisper", "down", "down")).toBeNull();
  });
});

describe("localServerDownMessage", () => {
  it("names the service to start", () => {
    expect(localServerDownMessage("local-parakeet", "down")).toBe(
      "Parakeet speech server isn't running. Start it with: systemctl --user start aileron-parakeet",
    );
  });

  it("distinguishes loading from missing", () => {
    expect(localServerDownMessage("local-parakeet", "loading")).toBe(
      "Parakeet speech server is still starting (loading the model). Try again in a few seconds.",
    );
  });

  it("says what to do about Whisper", () => {
    expect(localServerDownMessage("local-whisper", "down")).toBe(
      "Local Whisper isn't running on port 8000. Start whisper_server.py, or choose Local Parakeet in speech settings.",
    );
  });

  it("stays quiet when the server is fine", () => {
    expect(localServerDownMessage("local-parakeet", "up")).toBeNull();
    expect(localServerDownMessage("local-whisper", "loading")).toBeNull();
    expect(localServerDownMessage("openai-whisper", "down")).toBeNull();
  });
});
