import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TYPE_PROVIDER } from "@/types";

/**
 * Captures the request body `fetchAIResponse` actually sends, so the
 * `reasoning_effort` injection can be asserted against real provider
 * templates rather than reimplemented in the test.
 */
const sent: { url: string; body: any; headers: Record<string, string> }[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init: any) => {
    sent.push({
      url,
      body: JSON.parse(init.body),
      headers: init.headers,
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "hi" } }] }),
    });
  },
}));

let thinking: "default" | "off" = "off";
vi.mock("@/lib", async () => ({
  getResponseSettings: () => ({
    responseLength: "auto",
    language: "english",
    autoScroll: true,
    thinking,
  }),
  RESPONSE_LENGTHS: [],
  LANGUAGES: [],
}));

const { fetchAIResponse } = await import("./ai-response.function");

const drain = async (provider: TYPE_PROVIDER, model = "m") => {
  const out: string[] = [];
  for await (const c of fetchAIResponse({
    provider,
    selectedProvider: {
      provider: provider.id ?? "",
      variables: { MODEL: model },
    },
    userMessage: "hello",
  })) {
    out.push(c);
  }
  return out;
};

const mk = (
  id: string,
  url: string,
  body: string,
  capabilities?: TYPE_PROVIDER["capabilities"]
): TYPE_PROVIDER =>
  ({
    id,
    curl: `curl -X POST ${url} -H "Content-Type: application/json" -d '${body}'`,
    responseContentPath: "choices[0].message.content",
    streaming: false,
    capabilities,
  }) as TYPE_PROVIDER;

const OPENAI_BODY = `{"model": "{{MODEL}}", "messages": [{"role": "user", "content": "{{TEXT}}"}]}`;

beforeEach(() => {
  sent.length = 0;
  thinking = "off";
});
afterEach(() => vi.clearAllMocks());

describe("reasoning_effort injection", () => {
  it("removes the packaged webview origin from local AI requests", async () => {
    await drain(
      mk("ollama", "http://localhost:11434/v1/chat/completions", OPENAI_BODY)
    );

    expect(sent[0].headers).toMatchObject({ Origin: "" });
  });

  it("is sent when the provider declares thinking-off support", async () => {
    await drain(
      mk("ollama", "http://localhost:11434/v1/chat/completions", OPENAI_BODY, {
        reasoningEffort: { offValue: "none" },
      })
    );
    expect(sent[0].body.reasoning_effort).toBe("none");
  });

  it("is omitted when thinking is left at the model default", async () => {
    thinking = "default";
    await drain(
      mk("ollama", "http://localhost:11434/v1/chat/completions", OPENAI_BODY, {
        reasoningEffort: { offValue: "none" },
      })
    );
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");
  });

  it("is omitted for an OpenAI-shaped endpoint without the capability", async () => {
    await drain(
      mk(
        "custom",
        "http://x.test/v1/chat/completions",
        OPENAI_BODY
      )
    );
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");
  });

  // Providers with their own request shape reject unknown top-level fields,
  // so a global "thinking: off" must not leak into them.
  it("is omitted for a Gemini-style generateContent endpoint", async () => {
    await drain(
      mk(
        "gemini",
        "http://x.test/v1beta/models/gemini:generateContent",
        `{"contents": [{"parts": [{"text": "{{TEXT}}"}]}]}`
      )
    );
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");
  });

  it("is omitted for an Anthropic-style /v1/messages endpoint", async () => {
    await drain(
      mk(
        "claude",
        "http://x.test/v1/messages",
        `{"model": "{{MODEL}}", "messages": [{"role": "user", "content": "{{TEXT}}"}]}`
      )
    );
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");
  });

  it("overrides a template value when the provider supports turning thinking off", async () => {
    await drain(
      mk(
        "custom",
        "http://x.test/v1/chat/completions",
        `{"model": "{{MODEL}}", "reasoning_effort": "high", "messages": [{"role": "user", "content": "{{TEXT}}"}]}`,
        { reasoningEffort: { offValue: "none" } }
      )
    );
    expect(sent[0].body.reasoning_effort).toBe("none");
  });

  it("limits support to declared model prefixes", async () => {
    const provider = mk(
      "groq",
      "http://x.test/v1/chat/completions",
      OPENAI_BODY,
      {
        reasoningEffort: {
          offValue: "none",
          modelPrefixes: ["qwen/"],
        },
      }
    );

    await drain(provider, "openai/gpt-oss-20b");
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");

    sent.length = 0;
    await drain(provider, "qwen/qwen3.6-27b");
    expect(sent[0].body.reasoning_effort).toBe("none");
  });
});
