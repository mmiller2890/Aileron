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
  _providerId: string | undefined,
  resolvedUrl: string
): boolean {
  return isLoopbackUrl(resolvedUrl);
}

export function withLoopbackOriginRemoved(
  headers: Record<string, string>,
  resolvedUrl: string
): Record<string, string> {
  return isLoopbackUrl(resolvedUrl)
    ? { ...headers, Origin: "" }
    : { ...headers };
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
