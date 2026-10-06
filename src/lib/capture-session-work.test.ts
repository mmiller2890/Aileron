import { describe, expect, it } from "vitest";
import {
  createCaptureSessionWork,
  isStartCancelled,
} from "./capture-session-work";

describe("createCaptureSessionWork", () => {
  it("invalidates results from a stopped or superseded session", () => {
    const sessions = createCaptureSessionWork();
    const first = sessions.begin();
    expect(sessions.isCurrent(first)).toBe(true);

    sessions.invalidate(first);
    expect(sessions.isCurrent(first)).toBe(false);

    const second = sessions.begin();
    expect(sessions.isCurrent(first)).toBe(false);
    expect(sessions.isCurrent(second)).toBe(true);
  });

  it("drains tracked STT work", async () => {
    const sessions = createCaptureSessionWork();
    const generation = sessions.begin();
    let release: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    void sessions.track(generation, work);

    let drained = false;
    const drain = sessions.drain(generation, 100).then((value) => {
      drained = value;
      return value;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release?.();
    await expect(drain).resolves.toBe(true);
  });

  it("returns false instead of blocking past the drain timeout", async () => {
    const sessions = createCaptureSessionWork();
    const generation = sessions.begin();
    void sessions.track(generation, new Promise<void>(() => {}));

    await expect(sessions.drain(generation, 1)).resolves.toBe(false);
  });

  it("invalidating a stale generation leaves a newer one untouched", async () => {
    const sessions = createCaptureSessionWork();
    const stale = sessions.begin();
    const current = sessions.begin();
    void sessions.track(stale, new Promise<void>(() => {}));

    sessions.invalidate(stale);

    expect(sessions.isCurrent(current)).toBe(true);
    await expect(sessions.drain(current, 10)).resolves.toBe(true);
  });
});

describe("isStartCancelled", () => {
  it("recognises a start cancelled by a stop, however it is wrapped", () => {
    expect(isStartCancelled("Capture stopped during startup")).toBe(true);
    expect(isStartCancelled(new Error("Capture stopped during startup"))).toBe(
      true,
    );
  });

  it("treats every other failure as a real error", () => {
    expect(isStartCancelled("Failed to access system audio: denied")).toBe(
      false,
    );
    expect(isStartCancelled(new Error("Capture already running"))).toBe(false);
    expect(isStartCancelled(undefined)).toBe(false);
  });
});
