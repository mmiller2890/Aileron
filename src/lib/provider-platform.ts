export type AppPlatform = "macos" | "windows" | "linux";

/**
 * Whether a built-in STT provider belongs on this platform. Providers without
 * a `platform` (every cloud provider, and anything the user added) are offered
 * everywhere. Without this filter a Linux user is offered the in-process
 * Apple engine, and a Mac is offered a server that only exists on the PC.
 */
export function provider_visible_on(
  platform: AppPlatform,
  providerPlatform?: string,
): boolean {
  if (!providerPlatform) return true;
  if (providerPlatform === "macos-apple-silicon") return platform === "macos";
  if (providerPlatform === "windows-linux") return platform !== "macos";
  return true;
}

/**
 * The provider a saved-but-unavailable choice migrates to: the macOS engine on
 * a Mac, and Local Whisper elsewhere (the server the Linux setup documents).
 */
export function sttFallbackFor(platform: AppPlatform): {
  provider: string;
  variables: Record<string, string>;
} {
  if (platform === "macos") {
    return {
      provider: "local-fluidaudio",
      variables: { MODEL: "v3" },
    };
  }
  return {
    provider: "local-whisper",
    variables: { MODEL: "openai/whisper-large-v3-turbo" },
  };
}

/**
 * Whether live text can run with this provider. macOS has it in-process;
 * elsewhere it comes from the local Parakeet server, so any other provider
 * leaves it inert.
 */
export function liveFeaturesAvailableOn(
  platform: AppPlatform,
  providerId: string,
): boolean {
  if (platform === "macos") return true;
  return providerId === "local-parakeet";
}

/**
 * Whether the local server's speaker labels are used off macOS. Off: on a real
 * two-speaker recording on the PC they labelled 3 of 14 lines with slots that
 * jumped between turns, and each turn's diarizing (~0.3 s) holds the server's
 * lock, delaying that turn's final transcript.
 */
export const REMOTE_SPEAKER_LABELS = false;

/**
 * Whether speaker labels can run with this provider. macOS has them
 * in-process; elsewhere only through the local Parakeet server, and only once
 * REMOTE_SPEAKER_LABELS is turned on.
 */
export function liveSpeakersAvailableOn(
  platform: AppPlatform,
  providerId: string,
): boolean {
  if (platform === "macos") return true;
  return REMOTE_SPEAKER_LABELS && providerId === "local-parakeet";
}
