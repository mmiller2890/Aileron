import { useEffect, useState } from "react";
import { useApp } from "@/contexts";
import {
  CircleStopIcon,
  AudioLinesIcon,
  MicIcon,
  MicOffIcon,
  CornerDownLeftIcon,
  PictureInPicture2,
  SparklesIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  LiveSessionSnapshot,
  LiveSessionCommand,
  deriveSessionStatus,
  deriveBarNotice,
} from "@/lib/live-session";
import { SessionNotice } from "./SessionNotice";

const formatElapsed = (startedAt: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const EmbeddedBar = ({
  snapshot,
  sendCommand,
  overlayVisible,
  onTogglePopOut,
  onOpenProviders,
}: {
  snapshot: LiveSessionSnapshot | null;
  sendCommand: (command: LiveSessionCommand) => void;
  overlayVisible: boolean;
  onTogglePopOut: () => void;
  onOpenProviders: () => void;
}) => {
  const { selectedAIProvider, selectedSttProvider } = useApp();
  const status = deriveSessionStatus(snapshot);
  const capturing = snapshot?.capturing ?? false;
  const manualMode = snapshot?.isContinuousMode ?? false;
  const recording = snapshot?.isRecordingInContinuousMode ?? false;
  const busy = (snapshot?.isProcessing || snapshot?.isAIProcessing) ?? false;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!capturing) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [capturing]);

  const [text, setText] = useState("");
  const submitText = () => {
    const t = text.trim();
    if (!t) return;
    sendCommand({ action: "submit", text: t });
    setText("");
  };

  const notice = deriveBarNotice(snapshot);

  return (
    <div
      data-tauri-drag-region
      className="relative z-[60] flex flex-col gap-1 border-b border-border bg-sidebar px-4 pb-2.5 pt-2"
    >
      {/* Status band */}
      <div className="flex items-center justify-between font-mono text-[10px] pointer-events-none">
        <span className={`inline-flex items-center gap-1.5 ${status.cls}`}>
          <span
            className={`size-1.5 rounded-full ${status.dot} ${
              status.word !== "idle" ? "animate-pulse" : ""
            }`}
          />
          {status.word}
          {capturing && snapshot?.sessionStartedAt ? (
            <span className="text-muted-foreground">
              · {formatElapsed(snapshot.sessionStartedAt, now)}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={onOpenProviders}
          title="Configure providers"
          className="pointer-events-auto text-meta transition-colors hover:text-foreground"
        >
          {selectedAIProvider.provider || "no model"} ·{" "}
          {selectedSttProvider.provider || "no stt"}
        </button>
      </div>

      {!overlayVisible && notice && (
        <SessionNotice
          notice={notice}
          onGrantPermission={() => sendCommand({ action: "setup" })}
        />
      )}

      {overlayVisible ? (
        <div className="flex h-9 items-center justify-between rounded-md border border-border bg-secondary px-3 font-mono text-xs text-meta">
          <span>popped out · bar is floating (invisible to screen share)</span>
          <button
            onClick={onTogglePopOut}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-primary"
          >
            <PictureInPicture2 className="size-3" /> pop in
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() =>
              sendCommand({
                action: capturing ? "stop-capture" : "start-capture",
              })
            }
            title={capturing ? "Stop capture" : "Start capturing system audio"}
            className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 font-mono text-xs transition-colors ${
              capturing
                ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                : "border-border bg-secondary text-muted-foreground hover:border-input hover:text-primary"
            }`}
          >
            {capturing ? (
              <CircleStopIcon className="size-3.5" />
            ) : (
              <AudioLinesIcon className="size-3.5" />
            )}
            {capturing ? "stop" : "capture"}
          </button>

          {capturing && manualMode && (
            <button
              onClick={() =>
                sendCommand({
                  action: recording ? "stop-and-send" : "start-recording",
                })
              }
              disabled={busy}
              title={recording ? "Stop & send" : "Record"}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-secondary px-3 font-mono text-xs text-muted-foreground transition-colors hover:text-primary disabled:opacity-40"
            >
              {recording ? (
                <MicOffIcon className="size-3.5 text-primary" />
              ) : (
                <MicIcon className="size-3.5" />
              )}
              {recording ? "send" : "record"}
            </button>
          )}
          {capturing && manualMode && recording && (
            <button
              onClick={() => sendCommand({ action: "ignore-recording" })}
              className="inline-flex h-9 items-center rounded-md border border-border bg-secondary px-3 font-mono text-xs text-muted-foreground transition-colors hover:text-primary"
            >
              ignore
            </button>
          )}

          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitText();
              }
            }}
            placeholder="Ask a question…"
            className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-input"
          />
          <button
            onClick={submitText}
            disabled={!text.trim()}
            title="Send"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition-colors hover:text-primary disabled:opacity-40"
          >
            <CornerDownLeftIcon className="size-3.5" />
          </button>

          <button
            onClick={() => sendCommand({ action: "answer-last" })}
            title="Answer the last thing heard"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition-colors hover:text-primary"
          >
            <SparklesIcon className="size-3.5" />
          </button>
          <button
            onClick={() => sendCommand({ action: "new-conversation" })}
            title="New session"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition-colors hover:text-primary"
          >
            <RotateCcwIcon className="size-3.5" />
          </button>
          <button
            onClick={onTogglePopOut}
            title="Pop out the bar (invisible to screen share)"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition-colors hover:text-primary"
          >
            <PictureInPicture2 className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
