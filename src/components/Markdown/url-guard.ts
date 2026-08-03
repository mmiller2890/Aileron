const SAFE_URL_PROTOCOLS = ["http:", "https:", "mailto:"];

export const isSafeExternalUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return SAFE_URL_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
};
