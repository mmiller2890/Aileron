// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@/lib/platform", () => ({ isMacOS: () => true }));
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
vi.mock("@/pages/dev/components/ai-configs/OllamaModelPicker", () => ({
  OllamaModelPicker: () => <div data-testid="ollama-models" />,
}));
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

  const render = () =>
    act(() => {
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
    render();
  };

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    selected = { provider: "", variables: {} };
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
    render();
    expect(button("start listening")!.disabled).toBe(true);
    await click("skip setup");
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onStartListening).not.toHaveBeenCalled();
  });

  it("sets up a free local model in one choice", async () => {
    render();
    await click("free, on this computer");
    expect(onSetSelectedAIProvider).toHaveBeenCalledWith({
      provider: "ollama",
      variables: {},
    });
    expect(container.querySelector('[data-testid="ollama-models"]')).not.toBeNull();
    // No model picked yet: still not ready.
    expect(button("start listening")!.disabled).toBe(true);

    selected = { provider: "ollama", variables: { MODEL: "llama3.2" } };
    render();
    expect(button("start listening")!.disabled).toBe(false);
    await click("start listening");
    expect(onStartListening).toHaveBeenCalledTimes(1);
  });

  it("takes an API key for a hosted service, with Claude's model filled in", async () => {
    render();
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
    render();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    // A hosted service is not ready without its key.
    expect(button("start listening")!.disabled).toBe(true);
    selected = {
      provider: "claude",
      variables: { MODEL: "claude-sonnet-5-5", API_KEY: "sk-test" },
    };
    render();
    expect(button("start listening")!.disabled).toBe(false);
  });

  it("opens the full provider and speech controls in the advanced view, and comes back", async () => {
    render();
    expect(container.querySelector('[data-testid="all-ai-providers"]')).toBeNull();
    await click("advanced");
    expect(container.querySelector('[data-testid="all-ai-providers"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="speech-providers"]')).not.toBeNull();
    await click("simple setup");
    expect(container.querySelector('[data-testid="all-ai-providers"]')).toBeNull();
  });

  it("asks macOS for audio access only when the button is pressed", async () => {
    invoke.mockResolvedValue(true);
    render();
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

  it("leaves ready speech models alone", () => {
    render();
    expect(stt.init).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Speech is transcribed on this Mac");
  });
});
