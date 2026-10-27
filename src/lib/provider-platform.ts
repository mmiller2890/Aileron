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
 * Whether the live previews (live text and speaker labels) can run with this
 * provider. macOS has them in-process; elsewhere they come from the local
 * Parakeet server, so any other provider leaves them inert.
 */
export function liveFeaturesAvailableOn(
  platform: AppPlatform,
  providerId: string,
): boolean {
  if (platform === "macos") return true;
  return providerId === "local-parakeet";
}
