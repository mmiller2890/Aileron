import { describe, expect, it } from "vitest";
import {
  createCaptureSessionWork,
  getSessionAudioStopAction,
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
});

describe("getSessionAudioStopAction", () => {
  it("discards remote-STT session audio", () => {
    expect(
      getSessionAudioStopAction("deepgram", "/tmp/session.wav", true)
    ).toBe("discard");
  });

  it("discards local session audio when STT does not drain", () => {
    expect(
      getSessionAudioStopAction(
        "local-fluidaudio",
        "/tmp/session.wav",
        false
      )
    ).toBe("discard");
  });

  it("diarizes only drained local Fluidaudio session audio", () => {
    expect(
      getSessionAudioStopAction(
        "local-fluidaudio",
        "/tmp/session.wav",
        true
      )
    ).toBe("diarize");
  });

  it("does nothing when capture produced no session audio", () => {
    expect(getSessionAudioStopAction("deepgram", null, true)).toBe("none");
  });
});
