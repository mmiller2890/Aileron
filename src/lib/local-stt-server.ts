import { SPEECH_TO_TEXT_PROVIDERS } from "@/config/stt.constants";

/** What a local transcription server reports about itself. */
export type LocalServerState = "up" | "loading" | "down";

/** Providers whose server runs on this machine. */
const LOCAL_PROVIDERS = ["local-parakeet", "local-whisper"];

/**
 * The `/health` URL for a local provider, taken from the address its own curl
 * posts to, so the check can never drift from the request. `null` for cloud
 * providers: there is nothing on this machine to check.
 */
export function localServerHealthUrl(providerId: string): string | null {
  if (!LOCAL_PROVIDERS.includes(providerId)) return null;
  const curl =
    SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === providerId)?.curl ?? "";
  const endpoint = curl.match(/https?:\/\/[^"\s]+/)?.[0];
  if (!endpoint) return null;
  try {
    return `${new URL(endpoint).origin}/health`;
  } catch {
    return null;
  }
}

/**
 * Ask a local server whether it is ready. Parakeet reports `loading` while the
 * model warms up, which is not the same as absent: the user who just logged in
 * must not be told their server isn't running.
 */
export async function checkLocalServer(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs = 1500,
): Promise<LocalServerState> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchFn(url, { signal: controller.signal }),
      timeout,
    ]);
    if (!response.ok) return "down";
    const body = (await Promise.race([response.json(), timeout])) as {
      status?: string;
    };
    if (body?.status === "ok") return "up";
    if (body?.status === "loading") return "loading";
    return "down";
  } catch {
    return "down";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Which provider startup should switch to, or `null` to keep the saved one.
 *
 * Only a saved Local Whisper (or nothing saved) is reconsidered, and only when
 * Whisper is down while Parakeet is up or still loading. A Whisper server that
 * is running is the user's deliberate choice and is never overridden.
 */
export function pickLinuxProvider(
  saved: string,
  parakeet: LocalServerState,
  whisper: LocalServerState,
): string | null {
  const reconsider = saved === "" || saved === "local-whisper";
  if (!reconsider) return null;
  if (whisper !== "down") return null;
  if (parakeet === "down") return null;
  return "local-parakeet";
}

/**
 * What to tell the user when a local server cannot serve a capture. `null`
 * when there is nothing to say.
 */
export function localServerDownMessage(
  providerId: string,
  state: LocalServerState,
): string | null {
  if (providerId === "local-parakeet") {
    if (state === "down") {
      return "Parakeet speech server isn't running. Start it with: systemctl --user start aileron-parakeet";
    }
    if (state === "loading") {
      return "Parakeet speech server is still starting (loading the model). Try again in a few seconds.";
    }
  }
  if (providerId === "local-whisper" && state === "down") {
    return "Local Whisper isn't running on port 8000. Start whisper_server.py, or choose Local Parakeet in speech settings.";
  }
  return null;
}
