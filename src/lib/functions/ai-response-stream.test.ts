import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TYPE_PROVIDER } from "@/types";

const { tauriFetchMock } = vi.hoisted(() => ({
  tauriFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

vi.mock("@/lib", () => ({
  getResponseSettings: () => ({
    responseLength: "auto",
    language: "english",
    autoScroll: true,
    thinking: "off",
  }),
  RESPONSE_LENGTHS: [],
  LANGUAGES: [],
}));

const { fetchAIResponse } = await import("./ai-response.function");

const OPENAI_BODY = `{"model": "{{MODEL}}", "messages": [{"role": "user", "content": "{{TEXT}}"}]}`;

const streamingProvider = (): TYPE_PROVIDER =>
  ({
    id: "custom-stream",
    curl: `curl -X POST http://x.test/v1/chat/completions -H "Content-Type: application/json" -d '${OPENAI_BODY}'`,
    responseContentPath: "choices[0].message.content",
    streaming: true,
  }) as TYPE_PROVIDER;

/** Serve an SSE payload as a real ReadableStream body, chunked as given. */
const sseResponse = (chunks: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 }
  );
};

const drain = async (chunks: string[]): Promise<string[]> => {
  tauriFetchMock.mockResolvedValueOnce(sseResponse(chunks));
  const out: string[] = [];
  for await (const chunk of fetchAIResponse({
    provider: streamingProvider(),
    selectedProvider: {
      provider: "custom-stream",
      variables: { MODEL: "m" },
    },
    userMessage: "hello",
  })) {
    out.push(chunk);
  }
  return out;
};

beforeEach(() => {
  tauriFetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchAIResponse streaming read loop", () => {
  it("assembles deltas from a normal multi-delta stream", async () => {
    const out = await drain([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(out).toEqual(["Hello", " world", "!"]);
    expect(out.join("")).toBe("Hello world!");
  });

  it("carries a partial line across chunk boundaries", async () => {
    const out = await drain([
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DONE]\n\n',
    ]);

    expect(out.join("")).toBe("Hello!");
  });

  it("ignores a malformed JSON line and keeps streaming", async () => {
    const out = await drain([
      "data: not-json\n\n",
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    expect(out).toEqual(["ok"]);
  });

  it("skips keepalive comments, empty data lines, and ends on [DONE]", async () => {
    const out = await drain([
      ": keepalive comment\n\n",
      "data: \n\n",
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      "\n",
      "data: [DONE]\n\n",
    ]);

    expect(out).toEqual(["x"]);
  });

  it("yields nothing for a stream that ends immediately on [DONE]", async () => {
    expect(await drain(["data: [DONE]\n\n"])).toEqual([]);
  });
});
