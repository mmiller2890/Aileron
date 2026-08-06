import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TYPE_PROVIDER } from "@/types";

const { tauriFetchMock } = vi.hoisted(() => ({
  tauriFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

// Distinctive markers so assertions cannot pass by accident on real copy.
vi.mock("@/lib", () => ({
  getResponseSettings: () => ({
    responseLength: "auto",
    language: "english",
    autoScroll: true,
    thinking: "off",
  }),
  RESPONSE_LENGTHS: [
    { id: "auto", title: "Auto", description: "", prompt: "LENGTH_DIRECTIVE" },
  ],
  LANGUAGES: [
    { id: "english", name: "English", flag: "", prompt: "Respond in English." },
  ],
}));

const { fetchAIResponse } = await import("./ai-response.function");

const BODY = `{"system": "{{SYSTEM_PROMPT}}", "messages": [{"role": "user", "content": "{{TEXT}}"}]}`;

const streamingProvider = (): TYPE_PROVIDER =>
  ({
    id: "custom-stream",
    curl: `curl -X POST http://x.test/v1/chat/completions -H "Content-Type: application/json" -d '${BODY}'`,
    responseContentPath: "choices[0].message.content",
    streaming: true,
  }) as TYPE_PROVIDER;

/** Serve an SSE payload as a real ReadableStream body. */
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

/** Drive one request and return the composed system prompt from its body. */
const composedPrompt = async (channel?: "chat" | "spoken"): Promise<string> => {
  tauriFetchMock.mockResolvedValueOnce(
    sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ])
  );
  for await (const _chunk of fetchAIResponse({
    provider: streamingProvider(),
    selectedProvider: { provider: "custom-stream", variables: {} },
    systemPrompt: "BASE_PROMPT",
    userMessage: "hello",
    channel,
  })) {
    // drain the generator so the request completes
  }
  const init = tauriFetchMock.mock.calls[0][1];
  return JSON.parse(init.body).system;
};

beforeEach(() => {
  tauriFetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("system prompt composition by channel", () => {
  it("includes length and markdown directives on the chat channel", async () => {
    const prompt = await composedPrompt("chat");
    expect(prompt).toContain("BASE_PROMPT");
    expect(prompt).toContain("LENGTH_DIRECTIVE");
    expect(prompt).toContain("mermaid");
    expect(prompt).toContain("Respond in English.");
  });

  it("defaults to the chat channel when none is given", async () => {
    const prompt = await composedPrompt();
    expect(prompt).toContain("LENGTH_DIRECTIVE");
    expect(prompt).toContain("mermaid");
  });

  it("drops the length directive on the spoken channel", async () => {
    const prompt = await composedPrompt("spoken");
    expect(prompt).toContain("BASE_PROMPT");
    expect(prompt).not.toContain("LENGTH_DIRECTIVE");
  });

  it("drops markdown formatting instructions on the spoken channel", async () => {
    const prompt = await composedPrompt("spoken");
    expect(prompt).not.toContain("mermaid");
    expect(prompt).not.toContain("```");
  });

  it("keeps the language directive on the spoken channel", async () => {
    const prompt = await composedPrompt("spoken");
    expect(prompt).toContain("Respond in English.");
  });

  it("separates blocks with a blank line on both channels", async () => {
    expect(await composedPrompt("chat")).toContain("\n\n");
    expect(await composedPrompt("spoken")).toContain("\n\n");
  });
});
