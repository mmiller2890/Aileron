import { Card, Updater, CustomCursor } from "@/components";
import {
  SystemAudio,
  Completion,
  AudioVisualizer,
  StatusIndicator,
} from "./components";
import { useAppLifecycle } from "@/hooks";
import { useApp } from "@/contexts";
import { invoke } from "@tauri-apps/api/core";
import { ErrorBoundary } from "react-error-boundary";
import { LayoutDashboardIcon } from "lucide-react";
import { ErrorLayout } from "@/layouts";
import { getPlatform, isMacOS } from "@/lib";

const App = () => {
  const { isHidden, systemAudio } = useAppLifecycle();
  const { customizable } = useApp();
  const platform = getPlatform();
  const modKey = isMacOS() ? "⌘" : "Ctrl";

  const returnToDashboard = async () => {
    try {
      // Pops the bar in *and* focuses the dashboard. `open_dashboard` alone
      // only reveals the dashboard, leaving the bar still floating on top of
      // it — which is why this button read as doing nothing.
      await invoke("toggle_overlay");
    } catch (error) {
      console.error("Failed to return to dashboard:", error);
    }
  };

  // System voice for the status band, mirroring StatusIndicator's priority.
  const bandState = systemAudio?.error
    ? { word: "error", cls: "text-destructive", dot: "bg-destructive" }
    : systemAudio?.isAIProcessing
      ? { word: "answering", cls: "text-primary", dot: "bg-primary" }
      : systemAudio?.isProcessing
        ? {
            word: "transcribing",
            cls: "text-muted-foreground",
            dot: "bg-muted-foreground",
          }
        : systemAudio?.capturing
          ? { word: "listening", cls: "text-primary", dot: "bg-primary" }
          : { word: "idle", cls: "text-meta", dot: "bg-meta" };

  return (
    <ErrorBoundary
      fallbackRender={() => {
        return <ErrorLayout isCompact />;
      }}
      resetKeys={["app-error"]}
      onReset={() => {}}
    >
      <div
        className={`w-screen h-screen flex overflow-hidden justify-center items-start ${
          isHidden ? "hidden pointer-events-none" : ""
        }`}
      >
        <Card className="w-full flex flex-col p-1.5 gap-0.5">
          {/* Status band — the system's voice. Also the drag region: no grip
              handle; grab the band itself. */}
          <div
            data-tauri-drag-region
            className="flex h-[14px] items-center justify-between px-1 font-mono text-[9px] select-none"
          >
            <span
              className={`inline-flex items-center gap-1 pointer-events-none ${bandState.cls}`}
            >
              <span
                className={`size-1 rounded-full ${bandState.dot} ${
                  bandState.word !== "idle" ? "animate-pulse" : ""
                }`}
              />
              {bandState.word}
            </span>
            <span className="text-meta pointer-events-none">
              {modKey}⇧M capture · {modKey}\ hide
            </span>
          </div>

          {/* Control row */}
          <div className="flex flex-row items-center gap-1.5">
            <button
              onClick={returnToDashboard}
              title="Back to dashboard (pops the bar in)"
              aria-label="Back to dashboard"
              className="flex size-9 shrink-0 items-center justify-center rounded-md border border-primary text-primary transition-colors hover:bg-primary/10"
            >
              <LayoutDashboardIcon className="size-3.5" />
            </button>
            <SystemAudio {...systemAudio} />
            {systemAudio?.capturing ? (
              <div className="flex flex-row items-center gap-2 justify-between w-full">
                <div className="flex flex-1 items-center gap-2">
                  <AudioVisualizer isRecording={systemAudio?.capturing} />
                </div>
                <div className="flex !w-fit items-center gap-2">
                  <StatusIndicator
                    setupRequired={systemAudio.setupRequired}
                    error={systemAudio.error}
                    isProcessing={systemAudio.isProcessing}
                    isAIProcessing={systemAudio.isAIProcessing}
                    capturing={systemAudio.capturing}
                  />
                </div>
              </div>
            ) : null}
            {/* Kept mounted while capturing (hidden) so input/attachment state
                survives a capture session — matches pre-redesign behavior. */}
            <div
              className={
                systemAudio?.capturing
                  ? "hidden"
                  : "w-full flex flex-row gap-1.5 items-center"
              }
            >
              <Completion isHidden={isHidden} />
            </div>
            <Updater />
          </div>
        </Card>
        {customizable.cursor.type === "invisible" && platform !== "linux" ? (
          <CustomCursor />
        ) : null}
      </div>
    </ErrorBoundary>
  );
};

export default App;
