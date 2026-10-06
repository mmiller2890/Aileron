import { ChatConversation } from "@/types/completion";
import { useNavigate } from "react-router-dom";

export const formatRelative = (ts: number): string => {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
};

export const RecentSessions = ({
  conversations,
}: {
  conversations: ChatConversation[];
}) => {
  const navigate = useNavigate();
  const recent = conversations.slice(0, 6);

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="font-mono text-[11px] text-meta">sessions</div>
      {recent.length === 0 ? (
        <div className="font-mono text-xs text-meta">no sessions yet</div>
      ) : (
        <div className="space-y-1">
          {recent.map((c) => (
            <button
              key={c.id}
              onClick={() => navigate(`/chats/view/${c.id}`)}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {c.title || "untitled"}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-meta">
                {formatRelative(c.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
