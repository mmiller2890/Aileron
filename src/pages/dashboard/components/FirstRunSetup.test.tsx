// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => tauriCommand(command),
}));
vi.mock("@/lib/platform", () => ({ isMacOS: () => true }));
const tauriCommand = async (command: string) =>
  command === "ollama_installed" ? ollamaInstalled : invoke(command);
vi.mock("@/components/deco", () => ({
  AileronMark: () => null,
  ChevronRule: () => null,
}));
// The Dev Space controls and the Ollama picker reach for the network and the
// app context; the setup's own behaviour is what is under test.
vi.mock("@/pages/dev/components", () => ({
  AIProviders: () => <div data-testid="all-ai-providers" />,
  STTProviders: () => <div data-testid="speech-providers" />,
}));
// What answers on this machine: URL -> JSON body. Anything absent is down.
let localServers: Record<string, unknown> = {};
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string) => {
    if (!(url in localServers)) throw new Error("connection refused");
    return { ok: true, json: async () => localServers[url] };
  },
}));
const OLLAMA = "http://localhost:11434/api/tags";
const LM_STUDIO = "http://localhost:1234/v1/models";
let ollamaInstalled = false;
vi.mock("@/lib/functions/ai-response.function", () => ({
  fetchAIResponse: vi.fn(),
}));

let selected = { provider: "", variables: {} as Record<string, string> };
const onSetSelectedAIProvider = vi.fn((next: typeof selected) => {
  selected = next;
});
vi.mock("@/hooks", () => ({
  useSettings: () => ({
    selectedAIProvider: selected,
    selectedSttProvider: { provider: "local-fluidaudio", variables: {} },
    onSetSelectedAIProvider,
    allAiProviders: [
      { id: "ollama", curl: 'curl -X POST http://localhost:11434/v1/chat/completions' },
      { id: "claude", curl: "curl https://api.anthropic.com/v1/messages" },
      { id: "openai", curl: "curl https://api.openai.com/v1/chat/completions" },
    ],
    variables: selected.provider
      ? [
          { key: "API_KEY", value: "api key" },
          { key: "MODEL", value: "model" },
        ]
      : [],
  }),
}));

const stt = {
  asrReady: true,
  isSupported: true,
  error: null as string | null,
  progress: null,
  initStage: null,
  init: vi.fn(async () => true),
  initLiveText: vi.fn(async () => true),
  initLiveSpeakers: vi.fn(async () => true),
};
vi.mock("@/hooks/useSttStatus", () => ({
  useSttStatus: () => stt,
  formatSttProgressPhase: () => "Downloading speech models",
}));

import { FirstRunSetup } from "./FirstRunSetup";

describe("FirstRunSetup", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onStartListening = vi.fn();
  const onSkip = vi.fn();

  // Async, so the look for local AI that runs on mount settles first.
  const render = () =>
    act(async () => {
      root.render(
        <FirstRunSetup onStartListening={onStartListening} onSkip={onSkip} />,
      );
    });
  const button = (text: string) =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.toLowerCase().includes(text),
    ) as HTMLButtonElement | undefined;
  const click = async (text: string) => {
    await act(async () => {
      button(text)!.click();
    });
    await render();
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    selected = { provider: "", variables: {} };
    localServers = {};
    ollamaInstalled = false;
    stt.asrReady = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("will not start listening until an AI provider is ready, but can be skipped", async () => {
    await render();
    expect(button("start listening")!.disabled).toBe(true);
    await click("skip setup");
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onStartListening).not.toHaveBeenCalled();
  });

  it("selects a running Ollama and its first model without being asked", async () => {
    localServers[OLLAMA] = { models: [{ name: "llama3.2" }, { name: "qwen3" }] };
    await render();
    expect(onSetSelectedAIProvider).toHaveBeenCalledWith({
      provider: "ollama",
      variables: { MODEL: "llama3.2" },
    });
    await render();
    expect(container.querySelector("select")!.value).toBe("llama3.2");
    expect(button("start listening")!.disabled).toBe(false);
    await click("start listening");
    expect(onStartListening).toHaveBeenCalledTimes(1);
  });

  it("says to install Ollama when it is not on this machine", async () => {
    await render();
    await click("free, on this computer");
    expect(container.textContent).toContain("Ollama isn't installed");
    expect(button("open ollama")).toBeUndefined();
    expect(button("start listening")!.disabled).toBe(true);
  });

  it("offers to open an Ollama that is installed but not running", async () => {
    ollamaInstalled = true;
    await render();
    await click("free, on this computer");
    expect(container.textContent).toContain("installed but not running");
    expect(button("open ollama")).toBeDefined();
  });

  it("says how to get a model when Ollama runs with none", async () => {
    localServers[OLLAMA] = { models: [] };
    await render();
    await click("free, on this computer");
    expect(container.textContent).toContain("ollama pull llama3.2");
    expect(onSetSelectedAIProvider).toHaveBeenLastCalledWith({
      provider: "ollama",
      variables: {},
    });
  });

  it("offers LM Studio only when its server is running", async () => {
    await render();
    expect(button("lm studio")).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);

    selected = { provider: "claude", variables: {} };
    localServers[LM_STUDIO] = { data: [{ id: "phi-4" }] };
    await render();
    await click("lm studio");
    expect(onSetSelectedAIProvider).toHaveBeenLastCalledWith({
      provider: "lm-studio",
      variables: { MODEL: "phi-4" },
    });
  });

  it("never replaces a provider that was already chosen", async () => {
    selected = { provider: "claude", variables: {} };
    localServers[OLLAMA] = { models: [{ name: "llama3.2" }] };
    await render();
    expect(onSetSelectedAIProvider).not.toHaveBeenCalled();
  });

  it("takes an API key for a hosted service, with Claude's model filled in", async () => {
    await render();
    await click("i have an api key");
    expect(onSetSelectedAIProvider).toHaveBeenLastCalledWith({
      provider: "openai",
      variables: {},
    });
    const service = container.querySelector("select")!;
    await act(async () => {
      service.value = "claude";
      service.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSetSelectedAIProvider).toHaveBeenLastCalledWith({
      provider: "claude",
      variables: { MODEL: "claude-sonnet-5-5" },
    });
    selected = { provider: "claude", variables: { MODEL: "claude-sonnet-5-5" } };
    await render();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    // A hosted service is not ready without its key.
    expect(button("start listening")!.disabled).toBe(true);
    selected = {
      provider: "claude",
      variables: { MODEL: "claude-sonnet-5-5", API_KEY: "sk-test" },
    };
    await render();
    expect(button("start listening")!.disabled).toBe(false);
  });

  it("opens the full provider and speech controls in the advanced view, and comes back", async () => {
    await render();
    expect(container.querySelector('[data-testid="all-ai-providers"]')).toBeNull();
    await click("advanced");
    expect(container.querySelector('[data-testid="all-ai-providers"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="speech-providers"]')).not.toBeNull();
    await click("simple setup");
    expect(container.querySelector('[data-testid="all-ai-providers"]')).toBeNull();
  });

  it("asks macOS for audio access only when the button is pressed", async () => {
    invoke.mockResolvedValue(true);
    await render();
    expect(invoke).not.toHaveBeenCalled();
    await click("allow access");
    expect(invoke).toHaveBeenCalledWith("check_system_audio_access");
    expect(container.textContent).toContain("Access granted");
  });

  it("downloads the speech models by itself when they are missing", async () => {
    stt.asrReady = false;
    await act(async () => {
      root.render(
        <FirstRunSetup onStartListening={onStartListening} onSkip={onSkip} />,
      );
    });
    expect(stt.init).toHaveBeenCalledWith("v3");
    expect(stt.initLiveText).toHaveBeenCalled();
    expect(stt.initLiveSpeakers).toHaveBeenCalled();
  });

  it("leaves ready speech models alone", async () => {
    await render();
    expect(stt.init).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Speech is transcribed on this Mac");
  });
});
