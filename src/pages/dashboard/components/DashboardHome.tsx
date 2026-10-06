import { useState } from "react";
import {
  AudioLinesIcon,
  CornerDownLeftIcon,
  PictureInPicture2,
} from "lucide-react";
import { AileronMark, ChevronRule } from "@/components/deco";
import { ChatConversation } from "@/types/completion";
import {
  LiveSessionCommand,
  LiveSessionSnapshot,
  deriveBarNotice,
  greetingForHour,
} from "@/lib/live-session";
import { SessionNotice } from "./SessionNotice";
import { formatRelative } from "./RecentSessions";

const RECENT_LIMIT = 3;

/**
 * The dashboard's starting screen: one place to begin (ask or capture) and a
 * short list of recent sessions. The transcript layout replaces it as soon as
 * a session exists.
 */
export const DashboardHome = ({
  snapshot,
  sendCommand,
  conversations,
  providerLabel,
  overlayVisible,
  onTogglePopOut,
  onOpenProviders,
  onOpenConversation,
  onOpenAllChats,
  hour = new Date().getHours(),
}: {
  snapshot: LiveSessionSnapshot | null;
  sendCommand: (command: LiveSessionCommand) => void;
  conversations: ChatConversation[];
  /** Current model and speech provider, shown in the composer's corner. */
  providerLabel: string;
  overlayVisible: boolean;
  onTogglePopOut: () => void;
  onOpenProviders: () => void;
  onOpenConversation: (id: string) => void;
  onOpenAllChats: () => void;
  hour?: number;
}) => {
  const [text, setText] = useState("");
  const submitText = () => {
    const question = text.trim();
    if (!question) return;
    sendCommand({ action: "submit", text: question });
    setText("");
  };

  const notice = deriveBarNotice(snapshot);
  const recent = conversations.slice(0, RECENT_LIMIT);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto px-6 py-12">
      <div className="flex w-full max-w-[640px] flex-col items-center gap-7">
        <div className="flex flex-col items-center gap-4 select-none">
          <AileronMark size={56} />
          <h1
            className="text-center text-2xl tracking-[0.14em] text-foreground"
            style={{ fontFamily: "var(--font-display)", fontWeight: 500 }}
          >
            {greetingForHour(hour)}.
          </h1>
          <ChevronRule className="w-40" />
        </div>

        <div className="flex w-full flex-col gap-2">
          {!overlayVisible && notice && (
            <SessionNotice
              notice={notice}
              onGrantPermission={() => sendCommand({ action: "setup" })}
            />
          )}

          {overlayVisible ? (
            <div className="flex items-center justify-between border border-border bg-card px-4 py-4 font-mono text-xs text-meta">
              <span>popped out · bar is floating (invisible to screen share)</span>
              <button
                onClick={onTogglePopOut}
                className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary"
              >
                <PictureInPicture2 className="size-3" /> pop in
              </button>
            </div>
          ) : (
            <div className="flex flex-col border border-border bg-card transition-colors focus-within:border-primary/60">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitText();
                  }
                }}
                rows={2}
                autoFocus
                aria-label="Ask a question"
                placeholder="Ask anything…"
                className="w-full resize-none bg-transparent px-4 pt-4 pb-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
              />
              <div className="flex items-center gap-2 px-3 pb-3">
                <button
                  onClick={() => sendCommand({ action: "start-capture" })}
                  title="Listen to system audio and answer what is asked"
                  className="inline-flex h-8 items-center gap-1.5 border border-primary/50 bg-primary/10 px-3 font-mono text-xs text-primary transition-colors hover:bg-primary/20"
                >
                  <AudioLinesIcon className="size-3.5" />
                  start capture
                </button>
                <button
                  onClick={onTogglePopOut}
                  title="Pop out the bar (invisible to screen share)"
                  aria-label="Pop out the bar"
                  className="inline-flex size-8 items-center justify-center border border-border text-muted-foreground transition-colors hover:text-primary"
                >
                  <PictureInPicture2 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={onOpenProviders}
                  title="Configure providers"
                  className="ml-auto min-w-0 truncate font-mono text-[10px] text-meta transition-colors hover:text-foreground"
                >
                  {providerLabel}
                </button>
                <button
                  onClick={submitText}
                  disabled={!text.trim()}
                  title="Send"
                  aria-label="Send"
                  className="inline-flex size-8 shrink-0 items-center justify-center border border-border text-muted-foreground transition-colors hover:text-primary disabled:opacity-40"
                >
                  <CornerDownLeftIcon className="size-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>

        {recent.length > 0 && (
          <div className="w-full">
            <div className="mb-1 flex items-center justify-between px-1 font-mono text-[11px] text-meta">
              <span>recent</span>
              <button
                onClick={onOpenAllChats}
                className="transition-colors hover:text-foreground"
              >
                all chats →
              </button>
            </div>
            <div className="flex flex-col">
              {recent.map((conversation) => (
                <button
                  key={conversation.id}
                  onClick={() => onOpenConversation(conversation.id)}
                  className="flex w-full items-center justify-between gap-3 border-l-2 border-transparent px-3 py-2 text-left transition-colors hover:border-[var(--emerald)] hover:bg-secondary"
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {conversation.title || "Untitled session"}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-meta">
                    {formatRelative(conversation.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
