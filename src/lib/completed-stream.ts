export function completedStreamValue(
  value: string,
  completed: boolean
): string | null {
  return completed ? value : null;
}
