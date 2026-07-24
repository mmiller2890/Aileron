import { describe, expect, test, vi } from "vitest";
import { beginCaptureSession } from "./startCaptureSession";

describe("beginCaptureSession", () => {
  test("publishes VAD capture state only after backend startup succeeds", async () => {
    const calls: string[] = [];

    await beginCaptureSession({
      isContinuous: false,
      startBackend: async () => {
        calls.push("backend");
      },
      commitStarted: () => {
        calls.push("state");
      },
    });

    expect(calls).toEqual(["backend", "state"]);
  });

  test("does not publish capture state when backend startup fails", async () => {
    const commitStarted = vi.fn();

    await expect(
      beginCaptureSession({
        isContinuous: false,
        startBackend: async () => {
          throw new Error("backend failed");
        },
        commitStarted,
      })
    ).rejects.toThrow("backend failed");

    expect(commitStarted).not.toHaveBeenCalled();
  });

  test("publishes manual armed state without starting the backend", async () => {
    const startBackend = vi.fn(async () => {});
    const commitStarted = vi.fn();

    await beginCaptureSession({
      isContinuous: true,
      startBackend,
      commitStarted,
    });

    expect(startBackend).not.toHaveBeenCalled();
    expect(commitStarted).toHaveBeenCalledOnce();
  });
});
