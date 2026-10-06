/**
 * Visual identity for the live speaker labels ("Speaker 1" … "Speaker 4").
 * Accents come from the theme tokens so they follow the active theme.
 */
const SPEAKER_ACCENTS = [
  "var(--emerald-bright)",
  "var(--brass-bright)",
  "var(--foreground)",
  "var(--muted-foreground)",
] as const;

/** Zero-based slot for a "Speaker N" label, or null for anything else. */
export function speakerSlot(speaker: string | null | undefined): number | null {
  const match = /^speaker\s+(\d+)$/i.exec(speaker?.trim() ?? "");
  if (!match) return null;
  const slot = Number(match[1]) - 1;
  return slot >= 0 && slot < SPEAKER_ACCENTS.length ? slot : null;
}

/** CSS colour for a speaker's marker, or null when the label is not a slot. */
export function speakerAccent(
  speaker: string | null | undefined,
): string | null {
  const slot = speakerSlot(speaker);
  return slot === null ? null : SPEAKER_ACCENTS[slot];
}
