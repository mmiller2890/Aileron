import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPE_PROVIDER } from "@/types";

const { invokeMock, tauriFetchMock, globalFetchMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  tauriFetchMock: vi.fn(),
  globalFetchMock: vi.fn(),
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
  globalFetchMock.mockReset();
  vi.stubGlobal("fetch", globalFetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

describe("form-upload STT providers attach audio under the template's field", () => {
  const audio = new Blob(["wav"], { type: "audio/wav" });

  const formValues = (init: RequestInit): string[] => {
    const form = init.body as FormData;
    const values: string[] = [];
    form.forEach((value) => {
      if (typeof value === "string") values.push(value);
    });
    return values;
  };

  it("local-whisper: keeps the blob under file and still sends model", async () => {
    tauriFetchMock.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ text: "hello" })),
    });
    const provider = {
      id: "local-whisper",
      curl: `curl -X POST "http://localhost:8000/v1/audio/transcriptions" \\
        -F "file={{AUDIO}}" \\
        -F "model={{MODEL}}"`,
      responseContentPath: "text",
      streaming: false,
    } as TYPE_PROVIDER;

    await expect(
      fetchSTT({
        provider,
        selectedProvider: {
          provider: "local-whisper",
          variables: { MODEL: "openai/whisper-large-v3-turbo" },
        },
        audio,
      })
    ).resolves.toBe("hello");

    expect(tauriFetchMock).toHaveBeenCalledOnce();
    const form = tauriFetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.get("model")).toBe("openai/whisper-large-v3-turbo");
    expect(formValues(tauriFetchMock.mock.calls[0][1])).not.toContain(
      "{{AUDIO}}"
    );
  });

  it("rev-ai style: attaches the blob under media, never under file", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ id: "job-123" })),
    });
    const provider = {
      id: "rev-ai-stt",
      curl: `curl -X POST "https://api.rev.ai/speechtotext/v1/jobs" \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -F "media={{AUDIO}}" \\
        -F "options={{OPTIONS}}"`,
      responseContentPath: "id",
      streaming: false,
    } as TYPE_PROVIDER;

    await expect(
      fetchSTT({
        provider,
        selectedProvider: {
          provider: "rev-ai-stt",
          variables: { API_KEY: "secret", OPTIONS: '{"language":"en"}' },
        },
        audio,
      })
    ).resolves.toBe("job-123");

    expect(globalFetchMock).toHaveBeenCalledOnce();
    const form = globalFetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("media")).toBeInstanceOf(Blob);
    expect(form.has("file")).toBe(false);
    expect(form.get("options")).toBe('{"language":"en"}');
    expect(formValues(globalFetchMock.mock.calls[0][1])).not.toContain(
      "{{AUDIO}}"
    );
  });

  it("speechmatics style: attaches the blob under data_file", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({ job: { id: "job-456" } })
      ),
    });
    const provider = {
      id: "speechmatics-stt",
      curl: `curl -X POST "https://asr.api.speechmatics.com/v2/jobs" \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -F "data_file={{AUDIO}}" \\
        -F 'config={"type": "transcription"}'`,
      responseContentPath: "job.id",
      streaming: false,
    } as TYPE_PROVIDER;

    await expect(
      fetchSTT({
        provider,
        selectedProvider: {
          provider: "speechmatics-stt",
          variables: { API_KEY: "secret" },
        },
        audio,
      })
    ).resolves.toBe("job-456");

    expect(globalFetchMock).toHaveBeenCalledOnce();
    const form = globalFetchMock.mock.calls[0][1].body as FormData;
    expect(form.get("data_file")).toBeInstanceOf(Blob);
    expect(form.has("file")).toBe(false);
    expect(formValues(globalFetchMock.mock.calls[0][1])).not.toContain(
      "{{AUDIO}}"
    );
  });
});

describe("STT error paths redact secrets and point at the local server", () => {
  const audio = new Blob(["wav"], { type: "audio/wav" });

  const rejection = (promise: Promise<string>): Promise<Error> =>
    promise.then(
      () => new Error("expected the request to fail"),
      (reason: unknown) =>
        reason instanceof Error ? reason : new Error(String(reason))
    );

  it("redacts API keys from provider error responses", async () => {
    tauriFetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ error: "Invalid api key sk-live-1234567890abc" })
        ),
    });
    const provider = {
      id: "local-whisper",
      curl: `curl -X POST http://x.test/v1/audio/transcriptions \\
        -F "file={{AUDIO}}" \\
        -F "model={{MODEL}}"`,
      responseContentPath: "text",
      streaming: false,
    } as TYPE_PROVIDER;

    const err = await rejection(
      fetchSTT({
        provider,
        selectedProvider: {
          provider: "local-whisper",
          variables: { API_KEY: "sk-live-1234567890abc" },
        },
        audio,
      })
    );

    expect(err.message).toContain("HTTP 401");
    expect(err.message).toContain("[REDACTED]");
    expect(err.message).not.toContain("sk-live-1234567890abc");
  });

  it("redacts API keys and adds a local-server hint when the transport fails", async () => {
    tauriFetchMock.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 127.0.0.1:8000 sk-live-1234567890abc")
    );
    const provider = {
      id: "local-whisper",
      curl: `curl -X POST "http://localhost:8000/v1/audio/transcriptions" \\
        -F "file={{AUDIO}}" \\
        -F "model={{MODEL}}"`,
      responseContentPath: "text",
      streaming: false,
    } as TYPE_PROVIDER;

    const err = await rejection(
      fetchSTT({
        provider,
        selectedProvider: {
          provider: "local-whisper",
          variables: { API_KEY: "sk-live-1234567890abc" },
        },
        audio,
      })
    );

    expect(err.message).toMatch(/Could not reach http:\/\/localhost:8000/);
    expect(err.message).toContain("[REDACTED]");
    expect(err.message).not.toContain("sk-live-1234567890abc");
    expect(err.message).toContain(
      "Check that the local server is running and serving this port."
    );
  });
});

describe("https STT provider URLs use the global fetch", () => {
  it("does not route https uploads through tauriFetch", async () => {
    globalFetchMock.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ id: "job-789" })),
    });
    const provider = {
      id: "rev-ai-stt",
      curl: `curl -X POST "https://api.rev.ai/speechtotext/v1/jobs" \\
        -H "Authorization: Bearer {{API_KEY}}" \\
        -F "media={{AUDIO}}" \\
        -F "options={{OPTIONS}}"`,
      responseContentPath: "id",
      streaming: false,
    } as TYPE_PROVIDER;

    await expect(
      fetchSTT({
        provider,
        selectedProvider: {
          provider: "rev-ai-stt",
          variables: { API_KEY: "secret", OPTIONS: '{"language":"en"}' },
        },
        audio: new Blob(["wav"], { type: "audio/wav" }),
      })
    ).resolves.toBe("job-789");

    expect(globalFetchMock).toHaveBeenCalledOnce();
    expect(tauriFetchMock).not.toHaveBeenCalled();
    const [url, init] = globalFetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.rev.ai/speechtotext/v1/jobs");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("media")).toBeInstanceOf(Blob);
  });
});
