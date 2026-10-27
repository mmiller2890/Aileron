import { SPEECH_TO_TEXT_PROVIDERS } from "@/config/stt.constants";

const PARAKEET_ID = "local-parakeet";

/** The origin of the built-in local Parakeet server, or null if it has none. */
function parakeetOrigin(): string | null {
  const curl =
    SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === PARAKEET_ID)?.curl ?? "";
  const endpoint = curl.match(/https?:\/\/[^"\s]+/)?.[0];
  if (!endpoint) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

/**
 * Where the capture loop gets live text off macOS: the local Parakeet server,
 * which re-transcribes the turn in progress (see remote_live_text.rs). macOS
 * uses FluidAudio's streaming model, and no other provider is sent turn audio
 * for live text. The address is the one the provider itself posts to.
 */
export function liveTextEndpointFor(
  providerId: string,
  platform: "macos" | "windows" | "linux",
): string | null {
  if (platform === "macos" || providerId !== PARAKEET_ID) return null;
  const curl =
    SPEECH_TO_TEXT_PROVIDERS.find((p) => p.id === PARAKEET_ID)?.curl ?? "";
  return curl.match(/https?:\/\/[^"\s]+/)?.[0] ?? null;
}

/**
 * Where the capture loop gets live speaker labels off macOS: the same local
 * server's speaker root (see remote_live_speakers.rs), which owns Sortformer's
 * streaming state so a slot keeps naming the same voice across turns.
 */
export function liveSpeakersEndpointFor(
  providerId: string,
  platform: "macos" | "windows" | "linux",
): string | null {
  if (platform === "macos" || providerId !== PARAKEET_ID) return null;
  const origin = parakeetOrigin();
  return origin ? `${origin}/v1/speakers` : null;
}
