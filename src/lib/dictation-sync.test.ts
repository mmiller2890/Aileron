import { describe, expect, it } from "vitest";
import { dictationSyncAction } from "./dictation-sync";

/**
 * The mic button and the global audio shortcut both toggle a single armed
 * flag; the native dictation task carries its own status. This table is what
 * reconciles the two, so a single click (or hotkey press) both arms and
 * starts, instead of arming a task nobody ever starts.
 */
describe("dictationSyncAction", () => {
  it("starts dictation as soon as the flag is armed", () => {
    expect(dictationSyncAction(true, "idle", false)).toBe("start");
  });

  it("does not restart a task that is already running", () => {
    expect(dictationSyncAction(true, "starting", false)).toBe("none");
    expect(dictationSyncAction(true, "listening", false)).toBe("none");
    expect(dictationSyncAction(true, "transcribing", false)).toBe("none");
  });

  it("does not retry a failed start while armed", () => {
    // A failed start lands on idle with the error set. Restarting on that
    // state spins: start -> fail -> idle -> start. Retry must be explicit.
    expect(dictationSyncAction(true, "idle", true)).toBe("none");
  });

  it("stops the task when the flag is disarmed", () => {
    expect(dictationSyncAction(false, "starting", false)).toBe("stop");
    expect(dictationSyncAction(false, "listening", false)).toBe("stop");
    expect(dictationSyncAction(false, "transcribing", false)).toBe("stop");
  });

  it("does nothing when disarmed and already idle", () => {
    expect(dictationSyncAction(false, "idle", false)).toBe("none");
    expect(dictationSyncAction(false, "idle", true)).toBe("none");
  });
});
