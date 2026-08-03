import { MAX_FILES } from "@/config";

export function selectImageFilesWithinLimit<T extends { type: string }>(
  files: readonly T[],
  currentCount: number,
  maxFiles = MAX_FILES
): T[] {
  const remaining = Math.max(0, maxFiles - currentCount);
  return files
    .filter((file) => file.type.startsWith("image/"))
    .slice(0, remaining);
}

export function appendWithinLimit<T>(
  current: readonly T[],
  incoming: readonly T[],
  maxFiles = MAX_FILES
): T[] {
  return [...current, ...incoming].slice(0, Math.max(0, maxFiles));
}

/**
 * Assemble the base64 images for a request. Files come from the attachment
 * state, plus any images handed over explicitly (the screenshot auto-submit
 * path, which must not depend on React state having flushed).
 */
export function collectImagesBase64<T extends { type: string; base64: string }>(
  attachedFiles: readonly T[],
  extraImagesBase64: readonly string[] = []
): string[] {
  const fromFiles = attachedFiles
    .filter((file) => file.type.startsWith("image/"))
    .map((file) => file.base64);
  return [...fromFiles, ...extraImagesBase64];
}
