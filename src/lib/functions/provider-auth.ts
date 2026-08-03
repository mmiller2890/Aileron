const isLoopbackUrl = (rawUrl: string): boolean => {
  try {
    const hostname = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname)
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
  if (!isLoopbackUrl(resolvedUrl)) {
    return { ...headers };
  }

  const headersWithoutOrigin = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "origin")
  );
  return { ...headersWithoutOrigin, Origin: "" };
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
