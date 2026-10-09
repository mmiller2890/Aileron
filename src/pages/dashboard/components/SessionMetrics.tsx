import { useEffect, useState } from "react";
import { ChatConversation } from "@/types/completion";

const formatDuration = (ms: number): string => {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${String(s).padStart(2, "0")}`;
};

const formatDate = (ts: number): string =>
  new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

export const SessionMetrics = ({
  conversation,
  liveStartedAt = null,
}: {
  conversation: ChatConversation | null;
  /** When capturing: session start (ms epoch); duration runs from here. */
  liveStartedAt?: number | null;
}) => {
  const questions =
    conversation?.messages.filter((m) => m.role === "user").length ?? 0;
  const answers =
    conversation?.messages.filter((m) => m.role === "assistant").length ?? 0;
  // The live duration has to move on its own: snapshots only arrive when
  // something happens, so a quiet stretch would freeze the clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!liveStartedAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [liveStartedAt]);

  const duration = liveStartedAt
    ? formatDuration(now - liveStartedAt)
    : conversation
      ? formatDuration(conversation.updatedAt - conversation.createdAt)
      : "—";
  const date = liveStartedAt
    ? "live"
    : conversation
      ? formatDate(conversation.createdAt)
      : "";

  const Tile = ({ n, label }: { n: string; label: string }) => (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="font-mono text-xl font-medium leading-none">{n}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between font-mono text-[11px] text-meta">
        <span>session</span>
        <span>
          {conversation || liveStartedAt ? `${date} · ${duration}` : ""}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tile
          n={conversation || liveStartedAt ? String(questions) : "—"}
          label="questions"
        />
        <Tile
          n={conversation || liveStartedAt ? String(answers) : "—"}
          label="answers"
        />
      </div>
    </div>
  );
};
