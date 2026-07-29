import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import curl2Json from "@bany/curl-to-json";
import { TYPE_PROVIDER } from "@/types";
import {
  deepVariableReplacer,
  restoreUrlPlaceholders,
} from "./common.function";
import { withLoopbackOriginRemoved } from "./provider-auth";

/**
 * How long to ask Ollama to keep the model resident after a touch.
 */
export const WARMUP_KEEP_ALIVE = "30m";

/**
 * How often to re-touch the model.
 *
 * This must stay comfortably under Ollama's 5-minute default idle timeout,
 * because a normal completion resets the timer back to that default (see
 * `resolveWarmupTarget`).
 */
export const WARMUP_HEARTBEAT_MS = 3 * 60 * 1000;

/**
 * Whether an Ollama model tag is cloud-proxied rather than run locally.
 *
 * Ollama names these with a `cloud` tag (`qwen3.5:cloud`) or a `-cloud`
 * suffixed variant (`gpt-oss:20b-cloud`).
 */
export function isCloudModel(model: string): boolean {
  const tag = model.includes(":") ? model.slice(model.indexOf(":") + 1) : "";
  return tag === "cloud" || tag.endsWith("-cloud");
}

export interface WarmupTarget {
  /** Native Ollama preload endpoint, e.g. http://localhost:11434/api/generate */
  url: string;
  model: string;
}

/**
 * Work out whether a provider is an Ollama server we can preload, and where.
 *
 * Only Ollama is supported: its OpenAI-compatible `/v1/chat/completions`
 * endpoint silently ignores `keep_alive` and resets the model's idle timer to
 * the 5-minute default on every request, so keeping a model resident means
 * touching the *native* `/api/generate` endpoint on a heartbeat. Hosted
 * providers have nothing to warm, and other local runtimes (LM Studio) use a
 * different, server-side TTL setting.
 *
 * Returns null when the provider isn't Ollama or no model is configured.
 */
export function resolveWarmupTarget(
  provider: TYPE_PROVIDER | undefined,
  selectedProvider: { provider: string; variables: Record<string, string> } | undefined
): WarmupTarget | null {
  if (!provider || !selectedProvider) return null;
  if (provider.capabilities?.warmup !== "ollama") return null;

  const model = selectedProvider.variables?.MODEL?.trim();
  if (!model) return null;

  // Ollama's `:cloud` models are proxied to ollama.com — nothing is loaded
  // locally, so a preload is a no-op that leaves `/api/ps` empty. Warming one
  // just fires a pointless request at a remote service on every heartbeat.
  if (isCloudModel(model)) return null;

  let rawUrl: string;
  try {
    rawUrl = curl2Json(provider.curl).url || "";
  } catch {
    return null;
  }
  if (!rawUrl) return null;

  const variables = Object.fromEntries(
    Object.entries(selectedProvider.variables ?? {}).map(([k, v]) => [
      k.toUpperCase(),
      v,
    ])
  );
  const resolvedUrl = deepVariableReplacer(
    restoreUrlPlaceholders(rawUrl),
    variables
  ) as string;

  // A placeholder the caller never configured would otherwise leave a literal
  // `{{NAME}}` in the host. Warming the wrong server is worse than not warming,
  // so stand down rather than POST to a broken URL on every heartbeat.
  if (resolvedUrl.includes("{{")) return null;

  let parsed: URL;
  try {
    parsed = new URL(resolvedUrl);
  } catch {
    return null;
  }

  return { url: `${parsed.origin}/api/generate`, model };
}

/**
 * Load the model into memory (if needed) and reset its idle timer.
 *
 * Best-effort: a warm-up is a latency optimisation, never a precondition for a
 * request, so all failures are swallowed. Returns true only when the server
 * acknowledged the touch.
 *
 * A touch on an already-resident model costs ~40-110ms; a cold one blocks for
 * as long as the load takes, which is the whole point of doing it ahead of the
 * user's first question.
 */
export async function warmUpModel(
  target: WarmupTarget,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    // Local (http) URLs must go through the Tauri HTTP plugin to bypass CORS,
    // matching how fetchAIResponse picks its transport.
    const fetchFunction = target.url.startsWith("https") ? fetch : tauriFetch;
    const response = await fetchFunction(target.url, {
      method: "POST",
      headers: withLoopbackOriginRemoved(
        { "Content-Type": "application/json" },
        target.url
      ),
      // No prompt: this is a pure preload/keep-alive touch, so it loads the
      // weights and returns without generating any tokens.
      body: JSON.stringify({
        model: target.model,
        keep_alive: WARMUP_KEEP_ALIVE,
        stream: false,
      }),
      signal,
    });
    await response.text();
    return response.ok;
  } catch {
    return false;
  }
}
