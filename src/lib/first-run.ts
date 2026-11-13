/**
 * First-launch setup: when to show it and what each step's state is. Pure, so
 * the rules are tested without a window.
 */

/**
 * Whether to open on the setup checklist. Only a brand-new install sees it:
 * once it has been finished or skipped it never returns, and anyone who
 * already chose an AI provider (every existing user) skips it entirely.
 * Decided from storage, synchronously, so an existing user never sees it
 * flash while the provider loads.
 */
export function shouldShowSetup(
  completedFlag: string | null,
  savedAiProvider: string | null,
): boolean {
  if (completedFlag) return false;
  return !savedProviderId(savedAiProvider);
}

function savedProviderId(saved: string | null): string {
  if (!saved) return "";
  try {
    const provider = JSON.parse(saved)?.provider;
    return typeof provider === "string" ? provider : "";
  } catch {
    return "";
  }
}

/**
 * An AI provider is ready once one is chosen and every variable its request
 * needs has a value. The API key is required unless the provider runs on this
 * machine (Ollama, LM Studio): the same rule a real request applies.
 */
export function aiProviderReady(
  providerId: string,
  requiredKeys: string[],
  values: Record<string, string> | undefined,
  apiKeyOptional: boolean,
): boolean {
  if (!providerId) return false;
  return requiredKeys
    .filter((key) => !(apiKeyOptional && key.toUpperCase() === "API_KEY"))
    .every((key) => Boolean(values?.[key]?.trim()));
}

export type SpeechSetupState =
  | { kind: "ready" }
  | { kind: "preparing"; label: string; fraction: number | null }
  | { kind: "failed"; message: string }
  | { kind: "waiting" };

/** The on-device speech step, from the speech engine's status. */
export function speechSetupState(status: {
  asrReady: boolean;
  isInitializing: boolean;
  error: string | null;
  progressLabel: string | null;
  progressFraction: number | null;
}): SpeechSetupState {
  if (status.asrReady && !status.isInitializing) return { kind: "ready" };
  if (status.isInitializing) {
    return {
      kind: "preparing",
      label: status.progressLabel ?? "Preparing the speech engine",
      fraction: status.progressFraction,
    };
  }
  if (status.asrReady) return { kind: "ready" };
  if (status.error) return { kind: "failed", message: status.error };
  return { kind: "waiting" };
}

/**
 * The hosted providers the simple setup offers. Ids match
 * `AI_PROVIDERS`; everything else is reachable through the advanced view.
 * `model` is prefilled only where the id is known to be current.
 */
export const SIMPLE_KEY_PROVIDERS: {
  id: string;
  label: string;
  model?: string;
  modelHint: string;
}[] = [
  { id: "openai", label: "OpenAI", modelHint: "the model id from platform.openai.com" },
  {
    id: "claude",
    label: "Claude (Anthropic)",
    model: "claude-sonnet-5-5",
    modelHint: "the model id from console.anthropic.com",
  },
  { id: "gemini", label: "Google Gemini", modelHint: "the model id from aistudio.google.com" },
  { id: "groq", label: "Groq", modelHint: "the model id from console.groq.com" },
];

export type SimpleAiChoice = "local" | "lm-studio" | "key" | null;

/** Which simple-setup choice a selected provider belongs to, if any. */
export function simpleAiChoice(providerId: string): SimpleAiChoice {
  if (providerId === "ollama") return "local";
  if (providerId === "lm-studio") return "lm-studio";
  if (SIMPLE_KEY_PROVIDERS.some((provider) => provider.id === providerId)) {
    return "key";
  }
  return null;
}

/**
 * The simple setup can only show a provider it offers. Anything else (a
 * custom endpoint, another preset) was chosen in the advanced view, so reopen
 * it there rather than hide the user's choice.
 */
export function startsInAdvanced(providerId: string): boolean {
  return providerId !== "" && simpleAiChoice(providerId) === null;
}

/** What the setup found running on this machine when it opened. */
export interface LocalAiFound {
  /** Models Ollama has installed; `null` when Ollama is not answering. */
  ollamaModels: string[] | null;
  /** Ollama is on this machine, running or not. */
  ollamaInstalled: boolean;
  /** Models LM Studio's server offers; `null` when it is not answering. */
  lmStudioModels: string[] | null;
}

/**
 * The provider to select by itself when the setup opens, or `null` to leave
 * the choice to the user. Only ever fills an empty selection, and only with
 * something that is running and has a model: Ollama first, then LM Studio.
 */
export function preselectLocalAi(
  currentProviderId: string,
  found: LocalAiFound,
): { provider: string; variables: Record<string, string> } | null {
  if (currentProviderId) return null;
  if (found.ollamaModels?.length) {
    return { provider: "ollama", variables: { MODEL: found.ollamaModels[0] } };
  }
  if (found.lmStudioModels?.length) {
    return {
      provider: "lm-studio",
      variables: { MODEL: found.lmStudioModels[0] },
    };
  }
  return null;
}

/** Why Ollama has no model to offer, so the setup can say what to do next. */
export type OllamaGap = "not-installed" | "not-running" | "no-models" | null;

export function ollamaGap(found: LocalAiFound): OllamaGap {
  if (found.ollamaModels === null) {
    return found.ollamaInstalled ? "not-running" : "not-installed";
  }
  return found.ollamaModels.length === 0 ? "no-models" : null;
}

/** Model names from Ollama's `/api/tags` reply. */
export function parseOllamaModels(body: unknown): string[] {
  const models = (body as { models?: { name?: unknown }[] } | null)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => model?.name)
    .filter((name): name is string => typeof name === "string" && name !== "");
}

/** Model ids from an OpenAI-style `/v1/models` reply (LM Studio). */
export function parseOpenAiModels(body: unknown): string[] {
  const data = (body as { data?: { id?: unknown }[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((model) => model?.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
}
