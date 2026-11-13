import { useEffect, useRef, useState } from "react";
import { CheckIcon, LoaderIcon } from "lucide-react";
import { UseSettingsReturn } from "@/types";
import { fetchAIResponse } from "@/lib/functions/ai-response.function";
import {
  SIMPLE_KEY_PROVIDERS,
  simpleAiChoice,
  startsInAdvanced,
} from "@/lib/first-run";
import { AIProviders, STTProviders } from "@/pages/dev/components";
import { OllamaModelPicker } from "@/pages/dev/components/ai-configs/OllamaModelPicker";

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
 * The setup's AI step. The simple view offers two choices: a free model on
 * this machine (Ollama) or an API key for one of a few well-known services.
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

  const choose = (id: string) => {
    if (id === providerId) return;
    const model = SIMPLE_KEY_PROVIDERS.find((provider) => provider.id === id)
      ?.model;
    onSetSelectedAIProvider({
      provider: id,
      variables: model ? { MODEL: model } : {},
    });
  };
  const setVariable = (key: string, value: string) =>
    onSetSelectedAIProvider({
      ...selectedAIProvider,
      variables: { ...selectedAIProvider.variables, [key]: value },
    });

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
          onClick={() => choose("ollama")}
          className={choiceClass(choice === "local")}
        >
          <div className="text-sm text-foreground">Free, on this computer</div>
          <div className="text-xs text-muted-foreground">
            Ollama. Private, no account.
          </div>
        </button>
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

      {choice === "local" && (
        <div className="space-y-2">
          <Label>model</Label>
          <OllamaModelPicker
            value={selectedAIProvider.variables?.MODEL || ""}
            onChange={(model) => setVariable("MODEL", model)}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            New to Ollama? Install it from ollama.com, then run{" "}
            <code>ollama pull llama3.2</code> in Terminal and press Retry.
          </p>
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
