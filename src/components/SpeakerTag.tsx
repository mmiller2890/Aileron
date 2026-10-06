import { cn } from "@/lib/utils";
import { speakerAccent } from "@/lib/speaker-style";

/**
 * Who said a line: a small colour marker plus the label. Lines without a
 * speaker show `fallback` with no marker.
 */
export const SpeakerTag = ({
  speaker,
  fallback,
  className,
}: {
  speaker?: string | null;
  fallback: string;
  className?: string;
}) => {
  const accent = speakerAccent(speaker);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-muted-foreground",
        className,
      )}
    >
      {accent && (
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 shrink-0"
          style={{ backgroundColor: accent }}
        />
      )}
      {(speaker || fallback).toLowerCase()}
    </span>
  );
};
