import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { CheckIcon, LoaderIcon } from "lucide-react";
import { UseSettingsReturn } from "@/types";
import { fetchAIResponse } from "@/lib/functions/ai-response.function";
import {
  type LocalAiFound,
  ollamaGap,
  parseOllamaModels,
  parseOpenAiModels,
  preselectLocalAi,
  SIMPLE_KEY_PROVIDERS,
  simpleAiChoice,
  startsInAdvanced,
} from "@/lib/first-run";
import { isMacOS } from "@/lib/platform";
import { AIProviders, STTProviders } from "@/pages/dev/components";

const OLLAMA_MODELS_URL = "http://localhost:11434/api/tags";
const LM_STUDIO_MODELS_URL = "http://localhost:1234/v1/models";
const DETECT_TIMEOUT_MS = 1500;

/** A local server's reply as JSON, or `null` when it is not answering. */
async function localJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
  try {
    const response = await tauriFetch(url, { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Looks for Ollama and LM Studio on this machine. Never throws. */
async function detectLocalAi(): Promise<LocalAiFound> {
  const [ollama, lmStudio, ollamaInstalled] = await Promise.all([
    localJson(OLLAMA_MODELS_URL),
    localJson(LM_STUDIO_MODELS_URL),
    invoke<boolean>("ollama_installed").catch(() => false),
  ]);
  return {
    ollamaModels: ollama === null ? null : parseOllamaModels(ollama),
    ollamaInstalled: ollamaInstalled || ollama !== null,
    lmStudioModels: lmStudio === null ? null : parseOpenAiModels(lmStudio),
  };
}

const TEST_TIMEOUT_MS = 30_000;

const choiceClass = (active: boolean) =>
  `flex-1 border px-3 py-2.5 text-left transition-colors ${
    active
      ? "border-primary/60 bg-primary/10"
      : "border-border hover:border-primary/40"
  }`;
const fieldClass =
  "h-9 w-full border border-input/50 bg-transparent px-2.5 text-sm outline-none transition-colors focus:border-primary/50";

const Label = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[11px] text-meta">{children}</span>
);

/** Sends one short question through the chosen provider, as a real answer would go. */
const TestConnection = ({ settings }: { settings: UseSettingsReturn }) => {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "testing" }
    | { kind: "ok" }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const { selectedAIProvider, allAiProviders } = settings;

  // A result describes the settings it was run with; any change clears it.
  const fingerprint = JSON.stringify(selectedAIProvider);
  useEffect(() => {
    abortRef.current?.abort();
    setState({ kind: "idle" });
  }, [fingerprint]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    setState({ kind: "testing" });
    try {
      let reply = "";
      for await (const piece of fetchAIResponse({
        provider: allAiProviders.find(
          (provider) => provider.id === selectedAIProvider.provider,
        ),
        selectedProvider: selectedAIProvider,
        systemPrompt: "Reply with one short word.",
        userMessage: "Say: ready",
        signal: controller.signal,
      })) {
        reply += piece;
      }
      if (controller !== abortRef.current) return;
      setState(
        reply.trim()
          ? { kind: "ok" }
          : { kind: "failed", message: "The provider answered with nothing." },
      );
    } catch (error) {
      if (controller !== abortRef.current) return;
      setState({
        kind: "failed",
        message: controller.signal.aborted
          ? "No answer within 30 seconds."
          : error instanceof Error
            ? error.message
            : String(error),
      });
    } finally {
      clearTimeout(timer);
    }
  };

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={run}
        disabled={state.kind === "testing"}
        className="inline-flex h-8 items-center gap-1.5 border border-border px-3 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
      >
        {state.kind === "testing" && (
          <LoaderIcon className="size-3.5 animate-spin" />
        )}
        {state.kind === "ok" && <CheckIcon className="size-3.5 text-ok" />}
        {state.kind === "ok" ? "it works" : "test it"}
      </button>
      {state.kind === "failed" && (
        <p className="break-words text-xs leading-relaxed text-destructive">
          That didn't work: {state.message}
        </p>
      )}
    </div>
  );
};

/**
 * The setup's AI step. The simple view offers a free model on this machine
 * (Ollama, or LM Studio when its server is running) or an API key for one of
 * a few well-known services, and selects a running local model by itself.
 * The advanced view is the full Dev Space: every provider, custom endpoints
 * from a curl command, and the speech provider.
 */
export const FirstRunAi = ({
  settings,
  ready,
}: {
  settings: UseSettingsReturn;
  ready: boolean;
}) => {
  const { selectedAIProvider, onSetSelectedAIProvider } = settings;
  const providerId = selectedAIProvider.provider;
  const [advanced, setAdvanced] = useState(() => startsInAdvanced(providerId));
  const choice = simpleAiChoice(providerId);
  const keyProvider = SIMPLE_KEY_PROVIDERS.find(
    (provider) => provider.id === providerId,
  );

  const choose = (id: string, model?: string) => {
    if (id === providerId) return;
    const preset =
      model ??
      SIMPLE_KEY_PROVIDERS.find((provider) => provider.id === id)?.model;
    onSetSelectedAIProvider({
      provider: id,
      variables: preset ? { MODEL: preset } : {},
    });
  };
  const setVariable = (key: string, value: string) =>
    onSetSelectedAIProvider({
      ...selectedAIProvider,
      variables: { ...selectedAIProvider.variables, [key]: value },
    });

  // What is already running here. Looked up when the step opens, and again
  // on request (after the user installs or opens something).
  const [found, setFound] = useState<LocalAiFound | null>(null);
  const [detecting, setDetecting] = useState(false);
  const selectionRef = useRef(selectedAIProvider);
  selectionRef.current = selectedAIProvider;
  const applyRef = useRef(onSetSelectedAIProvider);
  applyRef.current = onSetSelectedAIProvider;
  const detect = useCallback(async () => {
    setDetecting(true);
    const result = await detectLocalAi();
    setFound(result);
    setDetecting(false);
    const current = selectionRef.current;
    const preselected = preselectLocalAi(current.provider, result);
    if (preselected) {
      applyRef.current(preselected);
      return;
    }
    // A local provider chosen before its models were known gets the first one.
    const models =
      current.provider === "ollama"
        ? result.ollamaModels
        : current.provider === "lm-studio"
          ? result.lmStudioModels
          : null;
    if (models?.length && !current.variables?.MODEL) {
      applyRef.current({
        ...current,
        variables: { ...current.variables, MODEL: models[0] },
      });
    }
  }, []);
  useEffect(() => {
    void detect();
  }, [detect]);

  const gap = found ? ollamaGap(found) : null;
  const lmStudioRunning = Boolean(found?.lmStudioModels);
  const localModels =
    choice === "local"
      ? (found?.ollamaModels ?? [])
      : choice === "lm-studio"
        ? (found?.lmStudioModels ?? [])
        : [];
  const [opening, setOpening] = useState(false);
  const openOllama = async () => {
    setOpening(true);
    try {
      await invoke("launch_ollama");
      // The server takes a few seconds to answer after the app opens.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if ((await localJson(OLLAMA_MODELS_URL)) !== null) break;
      }
    } catch (error) {
      console.error("Could not open Ollama:", error);
    }
    setOpening(false);
    await detect();
  };

  if (advanced) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setAdvanced(false)}
          className="font-mono text-xs text-meta transition-colors hover:text-foreground"
        >
          ← simple setup
        </button>
        <AIProviders {...settings} />
        <STTProviders {...settings} />
        {ready && <TestConnection settings={settings} />}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={choice === "local"}
          onClick={() => choose("ollama", found?.ollamaModels?.[0])}
          className={choiceClass(choice === "local")}
        >
          <div className="text-sm text-foreground">Free, on this computer</div>
          <div className="text-xs text-muted-foreground">
            {found?.ollamaModels?.length
              ? "Ollama is running here."
              : "Ollama. Private, no account."}
          </div>
        </button>
        {(lmStudioRunning || choice === "lm-studio") && (
          <button
            type="button"
            aria-pressed={choice === "lm-studio"}
            onClick={() => choose("lm-studio", found?.lmStudioModels?.[0])}
            className={choiceClass(choice === "lm-studio")}
          >
            <div className="text-sm text-foreground">LM Studio</div>
            <div className="text-xs text-muted-foreground">
              Its local server is running here.
            </div>
          </button>
        )}
        <button
          type="button"
          aria-pressed={choice === "key"}
          onClick={() => choose(keyProvider?.id ?? SIMPLE_KEY_PROVIDERS[0].id)}
          className={choiceClass(choice === "key")}
        >
          <div className="text-sm text-foreground">I have an API key</div>
          <div className="text-xs text-muted-foreground">
            OpenAI, Claude, Gemini or Groq.
          </div>
        </button>
      </div>

      {(choice === "local" || choice === "lm-studio") && (
        <div className="space-y-2">
          {localModels.length > 0 && (
            <label className="block space-y-1">
              <Label>model</Label>
              <select
                value={selectedAIProvider.variables?.MODEL || ""}
                onChange={(event) => setVariable("MODEL", event.target.value)}
                className={fieldClass}
              >
                {!selectedAIProvider.variables?.MODEL && (
                  <option value="">choose a model</option>
                )}
                {localModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          )}
          {choice === "local" && !found && (
            <p className="text-xs text-muted-foreground">Looking for Ollama…</p>
          )}
          {choice === "local" && gap === "not-installed" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Ollama isn't installed. Get it from ollama.com, open it, then
              check again.
            </p>
          )}
          {choice === "local" && gap === "not-running" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Ollama is installed but not running.
              {isMacOS() ? "" : " Start it with: ollama serve"}
            </p>
          )}
          {choice === "local" && gap === "no-models" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Ollama is running but has no models yet. In Terminal, run{" "}
              <code>ollama pull llama3.2</code>, then check again.
            </p>
          )}
          {choice === "lm-studio" && localModels.length === 0 && found && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              LM Studio's server isn't answering, or has no model loaded.
              Start the server in LM Studio, then check again.
            </p>
          )}
          {(localModels.length === 0 || gap) && found && (
            <div className="flex gap-2">
              {choice === "local" && gap === "not-running" && isMacOS() && (
                <button
                  type="button"
                  onClick={openOllama}
                  disabled={opening || detecting}
                  className="inline-flex h-8 items-center gap-1.5 border border-primary/50 bg-primary/10 px-3 font-mono text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
                >
                  {opening && <LoaderIcon className="size-3.5 animate-spin" />}
                  open ollama
                </button>
              )}
              <button
                type="button"
                onClick={() => void detect()}
                disabled={opening || detecting}
                className="inline-flex h-8 items-center gap-1.5 border border-border px-3 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
              >
                {detecting && <LoaderIcon className="size-3.5 animate-spin" />}
                check again
              </button>
            </div>
          )}
        </div>
      )}

      {choice === "key" && keyProvider && (
        <div className="space-y-2">
          <label className="block space-y-1">
            <Label>service</Label>
            <select
              value={keyProvider.id}
              onChange={(event) => choose(event.target.value)}
              className={fieldClass}
            >
              {SIMPLE_KEY_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <Label>api key (kept in your keychain)</Label>
            <input
              type="password"
              autoComplete="off"
              value={selectedAIProvider.variables?.API_KEY || ""}
              onChange={(event) => setVariable("API_KEY", event.target.value)}
              placeholder="paste your key"
              className={fieldClass}
            />
          </label>
          <label className="block space-y-1">
            <Label>model</Label>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={selectedAIProvider.variables?.MODEL || ""}
              onChange={(event) => setVariable("MODEL", event.target.value)}
              placeholder={keyProvider.modelHint}
              className={fieldClass}
            />
          </label>
        </div>
      )}

      {ready && <TestConnection settings={settings} />}

      <button
        type="button"
        onClick={() => setAdvanced(true)}
        className="block font-mono text-xs text-meta transition-colors hover:text-foreground"
      >
        advanced: other providers, custom endpoints, speech engine →
      </button>
    </div>
  );
};
