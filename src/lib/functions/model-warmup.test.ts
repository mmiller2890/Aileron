import { describe, it, expect, vi } from "vitest";
import { resolveWarmupTarget, warmUpModel } from "./model-warmup";
import { TYPE_PROVIDER } from "@/types";

const { tauriFetchMock } = vi.hoisted(() => ({
  tauriFetchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: tauriFetchMock,
}));

const provider = (
  id: string,
  url: string,
  capabilities?: TYPE_PROVIDER["capabilities"]
): TYPE_PROVIDER =>
  ({
    id,
    curl: `curl -X POST ${url} -H "Content-Type: application/json" -d '{"model": "{{MODEL}}"}'`,
    responseContentPath: "choices[0].message.content",
    streaming: true,
    capabilities,
  }) as TYPE_PROVIDER;

const warmableProvider = (id: string, url: string) =>
  provider(id, url, { warmup: "ollama" });

const selected = (variables: Record<string, string>) => ({
  provider: "ollama",
  variables,
});

describe("resolveWarmupTarget", () => {
  it("points at the native preload endpoint for the stock ollama provider", () => {
    const target = resolveWarmupTarget(
      warmableProvider("ollama", "http://localhost:11434/v1/chat/completions"),
      selected({ MODEL: "qwen3.5:2b-mlx" })
    );
    expect(target).toEqual({
      url: "http://localhost:11434/api/generate",
      model: "qwen3.5:2b-mlx",
    });
  });

  it("recognises a custom provider pointed at an Ollama server", () => {
    const target = resolveWarmupTarget(
      warmableProvider("my-box", "http://192.168.1.50:11434/v1/chat/completions"),
      selected({ MODEL: "gemma4:e2b" })
    );
    expect(target?.url).toBe("http://192.168.1.50:11434/api/generate");
  });

  // curl2Json lowercases the host, so `{{HOST}}` arrives as `{{host}}`;
  // restoreUrlPlaceholders puts it back before substitution.
  it("resolves a templated host", () => {
    const target = resolveWarmupTarget(
      warmableProvider("ollama", "http://{{HOST}}:11434/v1/chat/completions"),
      selected({ MODEL: "lfm2.5:latest", HOST: "127.0.0.1" })
    );
    expect(target?.url).toBe("http://127.0.0.1:11434/api/generate");
  });

  // Warming the wrong server is worse than not warming at all.
  it("returns null when a URL placeholder has no configured value", () => {
    expect(
      resolveWarmupTarget(
        warmableProvider("ollama", "http://{{HOST}}:11434/v1/chat/completions"),
        selected({ MODEL: "lfm2.5:latest" })
      )
    ).toBeNull();
  });

  it("returns null for hosted providers", () => {
    expect(
      resolveWarmupTarget(
        provider("openai", "https://api.openai.com/v1/chat/completions"),
        selected({ MODEL: "gpt-4o" })
      )
    ).toBeNull();
  });

  it("does not infer warmup support from provider id or port", () => {
    expect(
      resolveWarmupTarget(
        provider("ollama", "http://localhost:11434/v1/chat/completions"),
        selected({ MODEL: "qwen3.5:2b-mlx" })
      )
    ).toBeNull();
    expect(
      resolveWarmupTarget(
        provider("custom", "http://localhost:11434/v1/chat/completions"),
        selected({ MODEL: "qwen3.5:2b-mlx" })
      )
    ).toBeNull();
  });

  it("preserves an IPv6 loopback origin", () => {
    expect(
      resolveWarmupTarget(
        warmableProvider(
          "ollama",
          "http://[::1]:11434/v1/chat/completions"
        ),
        selected({ MODEL: "qwen3.5:2b-mlx" })
      )
    ).toEqual({
      url: "http://[::1]:11434/api/generate",
      model: "qwen3.5:2b-mlx",
    });
  });

  it("returns null for other local runtimes on their own ports", () => {
    // LM Studio manages model TTL server-side; there's nothing to touch here.
    expect(
      resolveWarmupTarget(
        provider("lm-studio", "http://localhost:1234/v1/chat/completions"),
        selected({ MODEL: "some-model" })
      )
    ).toBeNull();
  });

  // Verified against a live server: preloading a `:cloud` model returns 200 but
  // leaves /api/ps empty, so the heartbeat would hit ollama.com for nothing.
  it.each([
    "deepseek-v4-flash:cloud",
    "qwen3.5:cloud",
    "gpt-oss:20b-cloud",
    "gemma4:31b-cloud",
  ])("returns null for the cloud-proxied model %s", (model) => {
    expect(
      resolveWarmupTarget(
        warmableProvider("ollama", "http://localhost:11434/v1/chat/completions"),
        selected({ MODEL: model })
      )
    ).toBeNull();
  });

  it("still warms local models whose name merely contains 'cloud'", () => {
    expect(
      resolveWarmupTarget(
      warmableProvider("ollama", "http://localhost:11434/v1/chat/completions"),
        selected({ MODEL: "cloudy-llm:7b" })
      )?.model
    ).toBe("cloudy-llm:7b");
  });

  it("returns null when no model is configured", () => {
    expect(
      resolveWarmupTarget(
        warmableProvider("ollama", "http://localhost:11434/v1/chat/completions"),
        selected({ MODEL: "   " })
      )
    ).toBeNull();
    expect(
      resolveWarmupTarget(
        warmableProvider("ollama", "http://localhost:11434/v1/chat/completions"),
        selected({})
      )
    ).toBeNull();
  });

  it("returns null rather than throwing on missing or unparseable input", () => {
    expect(resolveWarmupTarget(undefined, selected({ MODEL: "m" }))).toBeNull();
    expect(
      resolveWarmupTarget(
        warmableProvider("ollama", "http://localhost:11434/v1/chat/completions"),
        undefined
      )
    ).toBeNull();
    expect(
      resolveWarmupTarget(
        { id: "ollama", curl: "not a curl command at all" } as TYPE_PROVIDER,
        selected({ MODEL: "m" })
      )
    ).toBeNull();
  });
});

describe("warmUpModel", () => {
  it("uses non-streaming mode and consumes the response body", async () => {
    const consumeBody = vi.fn().mockResolvedValue("{}");
    tauriFetchMock.mockResolvedValueOnce({
      ok: true,
      text: consumeBody,
    });

    await expect(
      warmUpModel({
        url: "http://localhost:11434/api/generate",
        model: "qwen3.5:2b-mlx",
      })
    ).resolves.toBe(true);

    const [, request] = tauriFetchMock.mock.calls[0];
    expect(JSON.parse(request.body)).toMatchObject({
      model: "qwen3.5:2b-mlx",
      stream: false,
    });
    expect(request.headers).toMatchObject({ Origin: "" });
    expect(consumeBody).toHaveBeenCalledOnce();
  });
});
