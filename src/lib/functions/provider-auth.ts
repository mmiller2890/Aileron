const BUILT_IN_OPTIONAL_KEY_PROVIDERS = new Set(["ollama", "lm-studio"]);

const isLoopbackUrl = (rawUrl: string): boolean => {
  try {
    const hostname = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
    );
  } catch {
    return false;
  }
};

export function isApiKeyOptional(
  providerId: string | undefined,
  resolvedUrl: string
): boolean {
  return (
    BUILT_IN_OPTIONAL_KEY_PROVIDERS.has(providerId ?? "") ||
    isLoopbackUrl(resolvedUrl)
  );
}

export function omitEmptyApiKeyHeaders(
  resolvedHeaders: Record<string, string>,
  templateHeaders: Record<string, unknown>,
  apiKey: string
): Record<string, string> {
  if (apiKey.trim()) {
    return resolvedHeaders;
  }

  return Object.fromEntries(
    Object.entries(resolvedHeaders).filter(([name]) => {
      const template = templateHeaders[name];
      return !(
        typeof template === "string" && template.includes("{{API_KEY}}")
      );
    })
  );
}
