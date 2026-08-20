import { describe, expect, it } from "vitest";
import { microphoneStreamConstraints } from "./microphoneStream";

describe("microphoneStreamConstraints", () => {
  it("keeps the VAD audio processing defaults", () => {
    expect(microphoneStreamConstraints()).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    });
  });

  it("requests the selected microphone exactly", () => {
    expect(microphoneStreamConstraints("external-mic")).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
        deviceId: { exact: "external-mic" },
      },
    });
  });

  it("does not constrain the browser default microphone", () => {
    expect(microphoneStreamConstraints("default")).not.toHaveProperty(
      "audio.deviceId"
    );
  });
});
