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
