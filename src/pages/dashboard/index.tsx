import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getRecentConversations } from "@/lib";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChatConversation } from "@/types/completion";
import {
  deriveLiveAnswerDraft,
  TOGGLE_WINDOW_VISIBILITY,
} from "@/lib/live-session";
import { useLiveSession } from "@/hooks/useLiveSession";
import { EmbeddedBar } from "./components/EmbeddedBar";
import { TranscriptFeed } from "./components/TranscriptFeed";
import { SessionMetrics } from "./components/SessionMetrics";
import { RecentSessions } from "./components/RecentSessions";
import { SessionSummaryCard } from "./components/SessionSummaryCard";
import { ProviderStatus } from "./components/ProviderStatus";
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";

const Dashboard = () => {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const { snapshot, sendCommand } = useLiveSession();
  const navigate = useNavigate();
  const [railCollapsed, setRailCollapsed] = useState(false);

  const load = useCallback(async () => {
    try {
      const recent = await getRecentConversations();
      setConversations(recent);
    } catch (error) {
      console.error("Failed to load conversations for dashboard:", error);
      setConversations([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // DB refresh on focus stays as the idle fallback (deep history and sessions
  // recorded before this window existed); live sessions arrive via events.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const win = getCurrentWebviewWindow();
        unlisten = await win.onFocusChanged(({ payload: focused }) => {
          if (focused) load();
        });
      } catch (error) {
        console.error("Failed to set up dashboard focus listener:", error);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [load]);

  // Overlay visibility drives the embedded bar's popped-in/out rendering.
  const [overlayVisible, setOverlayVisible] = useState(false);
  useEffect(() => {
    invoke<boolean>("is_overlay_visible")
      .then(setOverlayVisible)
      .catch(() => {});
    const un = listen<boolean>(TOGGLE_WINDOW_VISIBILITY, (e) => {
      if (typeof e.payload === "boolean") setOverlayVisible(!e.payload);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);
  const togglePopOut = () =>
    invoke<boolean>("toggle_overlay")
      .then(setOverlayVisible)
      .catch(() => {});

  // Mirror-only: prefer the live conversation whenever the engine has one.
  const liveConversation =
    snapshot && snapshot.conversation.messages.length > 0
      ? snapshot.conversation
      : null;
  const isLive = Boolean(snapshot?.capturing || liveConversation);
  const displayed = liveConversation ?? conversations[0] ?? null;
  const liveAnswerDraft = deriveLiveAnswerDraft(snapshot);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
      <EmbeddedBar
        snapshot={snapshot}
        sendCommand={sendCommand}
        overlayVisible={overlayVisible}
        onTogglePopOut={togglePopOut}
        onOpenProviders={() => navigate("/dev-space")}
      />
      <div
        className={`grid min-h-0 flex-1 ${
          railCollapsed
            ? "grid-cols-1"
            : "grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]"
        }`}
      >
        <div
          className={`relative min-h-0 overflow-hidden ${
            railCollapsed ? "" : "border-r border-border"
          }`}
        >
          <TranscriptFeed
            conversation={displayed}
            live={isLive}
            partialTranscription={snapshot?.partialTranscription ?? ""}
            liveAnswerDraft={liveAnswerDraft}
          />
          <button
            onClick={() => setRailCollapsed((v) => !v)}
            title={railCollapsed ? "Show sessions" : "Hide sessions"}
            aria-label={railCollapsed ? "Show sessions panel" : "Hide sessions panel"}
            className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center border border-border bg-secondary text-muted-foreground transition-colors hover:text-primary"
          >
            {railCollapsed ? (
              <PanelRightOpenIcon className="size-4" />
            ) : (
              <PanelRightCloseIcon className="size-4" />
            )}
          </button>
        </div>
        {!railCollapsed && (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
            <SessionMetrics
              conversation={displayed}
              liveStartedAt={
                snapshot?.capturing ? snapshot.sessionStartedAt : null
              }
            />
            {snapshot && (
              <SessionSummaryCard snapshot={snapshot} sendCommand={sendCommand} />
            )}
            <RecentSessions conversations={conversations} />
            <ProviderStatus />
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
