import { beforeEach, describe, expect, it, vi } from "vitest";
import { TYPE_PROVIDER } from "@/types";

const { invokeMock, tauriFetchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  tauriFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

vi.mock("./common.function", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./common.function")>();
  return {
    ...actual,
    blobToBase64: vi.fn().mockResolvedValue("encoded"),
    wavBase64ToF32Samples: vi
      .fn()
      .mockResolvedValue(new Float32Array([0.25, -0.25])),
  };
});

const { fetchSTT, isUtteranceCacheMiss } = await import("./stt.function");

const provider = {
  id: "local-fluidaudio",
  curl: "",
  responseContentPath: "text",
  streaming: false,
} as TYPE_PROVIDER;

const params = {
  provider,
  selectedProvider: {
    provider: "local-fluidaudio",
    variables: {},
  },
  audio: new Blob(["wav"], { type: "audio/wav" }),
  utteranceId: "utterance-1",
};

beforeEach(() => {
  invokeMock.mockReset();
  tauriFetchMock.mockReset();
});

describe("local Fluidaudio utterance fallback", () => {
  it("decodes the WAV only for a typed cache miss", async () => {
    invokeMock
      .mockRejectedValueOnce(
        "UTTERANCE_CACHE_MISS: Utterance utterance-1 is no longer cached"
      )
      .mockResolvedValueOnce({ text: "fallback transcript" });

    await expect(fetchSTT(params)).resolves.toBe("fallback transcript");
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "stt_transcribe_utterance",
      "stt_transcribe_speech",
    ]);
  });

  it("does not repeat inference after an ASR failure", async () => {
    invokeMock.mockRejectedValueOnce("FluidAudio inference failed");

    await expect(fetchSTT(params)).rejects.toThrow(
      "FluidAudio inference failed"
    );
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("recognizes only the stable cache-miss prefix", () => {
    expect(
      isUtteranceCacheMiss(
        new Error("UTTERANCE_CACHE_MISS: expired utterance")
      )
    ).toBe(true);
    expect(isUtteranceCacheMiss(new Error("model cache failed"))).toBe(false);
  });
});

describe("local HTTP transcription", () => {
  it("removes the packaged webview origin from loopback STT requests", async () => {
    tauriFetchMock.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ text: "hello" })),
    });
    const httpProvider = {
      id: "local-whisper",
      curl: `curl -X POST http://127.0.0.1:8000/v1/audio/transcriptions -H "Content-Type: audio/wav" --data-binary "{{AUDIO}}"`,
      responseContentPath: "text",
      streaming: false,
    } as TYPE_PROVIDER;

    await expect(
      fetchSTT({
        provider: httpProvider,
        selectedProvider: {
          provider: "local-whisper",
          variables: {},
        },
        audio: new Blob(["wav"], { type: "audio/wav" }),
      })
    ).resolves.toBe("hello");

    expect(tauriFetchMock.mock.calls[0][1].headers).toMatchObject({
      Origin: "",
    });
  });
});
