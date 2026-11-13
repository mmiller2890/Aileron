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

export type SimpleAiChoice = "local" | "key" | null;

/** Which simple-setup choice a selected provider belongs to, if any. */
export function simpleAiChoice(providerId: string): SimpleAiChoice {
  if (providerId === "ollama") return "local";
  if (SIMPLE_KEY_PROVIDERS.some((provider) => provider.id === providerId)) {
    return "key";
  }
  return null;
}

/**
 * The simple setup can only show a provider it offers. Anything else (a
 * custom endpoint, LM Studio) was chosen in the advanced view, so reopen it
 * there rather than hide the user's choice.
 */
export function startsInAdvanced(providerId: string): boolean {
  return providerId !== "" && simpleAiChoice(providerId) === null;
}
