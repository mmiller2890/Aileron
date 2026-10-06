import { useEffect, useRef } from "react";
import { ChatConversation } from "@/types/completion";
import { Markdown } from "@/components";
import { isNearBottom } from "@/lib/scroll";
import { SpeakerTag } from "@/components/SpeakerTag";

const formatClock = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

export const TranscriptFeed = ({
  conversation,
  live = false,
  liveAnswerDraft = null,
  partialTranscription = "",
  partialSpeaker = null,
}: {
  conversation: ChatConversation | null;
  live?: boolean;
  liveAnswerDraft?: string | null;
  /** Provisional text for the turn in progress; shown only while live. */
  partialTranscription?: string;
  /** Who is speaking in the turn in progress, when known. */
  partialSpeaker?: string | null;
}) => {
  const provisional = live ? partialTranscription.trim() : "";
  // Live conversation state is newest-first; DB reads are chronological.
  // Sort by timestamp so both render oldest → newest.
  const turns = [...(conversation?.messages ?? [])]
    .filter((m) => m.role !== "system")
    .sort((a, b) => a.timestamp - b.timestamp);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether new content should keep the feed pinned to the bottom. Starts true
  // (follow the newest turn); flips to false the moment the user scrolls up to
  // re-read, so incoming turns no longer yank them back down.
  const stickToBottomRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearBottom(
      el.scrollTop,
      el.scrollHeight,
      el.clientHeight
    );
  };

  const lastContent = turns[turns.length - 1]?.content;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !live || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [
    live,
    turns.length,
    lastContent,
    liveAnswerDraft,
    provisional,
  ]);

  const empty =
    turns.length === 0 &&
    liveAnswerDraft === null &&
    !provisional;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
      {empty ? (
        <div className="flex h-full items-center justify-center p-6 text-center">
          <span className="font-mono text-xs text-meta">
            {live
              ? "listening · say something"
              : "no session yet · press start capture"}
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {turns.map((m) => (
            <div key={m.id} className="flex gap-3">
              <span className="min-w-[40px] pt-0.5 font-mono text-[11px] text-meta">
                {formatClock(m.timestamp)}
              </span>
              {m.role === "assistant" ? (
                <div className="min-w-0 flex-1 border-l-[3px] border-[var(--emerald)] pl-3">
                  <div className="mb-1 font-mono text-[11px] text-primary">
                    answer
                  </div>
                  <div className="prose prose-sm max-w-none text-sm dark:prose-invert">
                    <Markdown>{m.content}</Markdown>
                  </div>
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="mb-1">
                    <SpeakerTag
                      speaker={m.speaker}
                      fallback="heard"
                      className="text-[11px]"
                    />
                  </div>
                  <div className="text-sm leading-relaxed">{m.content}</div>
                </div>
              )}
            </div>
          ))}
          {provisional && (
            <div className="flex gap-3">
              <span className="min-w-[40px] pt-0.5 font-mono text-[11px] text-meta animate-pulse">
                …
              </span>
              <div className="min-w-0 flex-1">
                <div className="mb-1">
                  <SpeakerTag
                    speaker={partialSpeaker}
                    fallback="hearing"
                    className="text-[11px]"
                  />
                </div>
                <div className="text-sm italic leading-relaxed text-muted-foreground">
                  {provisional}
                </div>
              </div>
            </div>
          )}
          {live && liveAnswerDraft !== null && (
            <div className="flex gap-3">
              <span className="min-w-[40px] pt-0.5 font-mono text-[11px] text-meta">
                …
              </span>
              <div className="min-w-0 flex-1 border-l-[3px] border-[var(--emerald)] pl-3">
                <div className="mb-1 font-mono text-[11px] text-primary">
                  answer
                </div>
                <div className="prose prose-sm max-w-none text-sm dark:prose-invert">
                  <Markdown>{liveAnswerDraft}</Markdown>
                  <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-primary align-middle" />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
