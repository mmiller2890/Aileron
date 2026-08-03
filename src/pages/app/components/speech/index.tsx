import { useState, useCallback, useEffect } from "react";
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverContent,
  ScrollArea,
  SttInitOverlay,
  Markdown,
} from "@/components";
import {
  HeadphonesIcon,
  AlertCircleIcon,
  LoaderIcon,
  AudioLinesIcon,
  CameraIcon,
  PlusIcon,
  XIcon,
  FileTextIcon,
  Loader2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ModeSwitcher } from "./ModeSwitcher";
import { RecordingPanel } from "./RecordingPanel";
import { ResultsSection } from "./ResultsSection";
import { SettingsPanel } from "./SettingsPanel";
import { PermissionFlow } from "./PermissionFlow";
import { QuickActions } from "./QuickActions";
import { Warning } from "./Warning";
import { useSystemAudioType } from "@/hooks";
import { useApp } from "@/contexts";
import { cn } from "@/lib/utils";
import { isMacOS } from "@/lib";

export const SystemAudio = (props: useSystemAudioType) => {
  const {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    partialTranscription,
    isStreaming,
    error,
    setupRequired,
    startCapture,
    stopCapture,
    isPopoverOpen,
    setIsPopoverOpen,
    useSystemPrompt,
    setUseSystemPrompt,
    contextContent,
    setContextContent,
    startNewConversation,
    conversation,
    resizeWindow,
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
    handleQuickActionClick,
    vadConfig,
    updateVadConfiguration,
    isRecordingInContinuousMode,
    recordingProgress,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    scrollAreaRef,
    isSttInitializing,
    isLabelingSpeakers,
    currentSpeaker,
    audioLevel,
    noAudioDetected,
    sessionSummary,
    isSummarizing,
    dismissSummary,
  } = props;

  const { hasActiveLicense, supportsImages } = useApp();

  // View mode toggle
  const [conversationMode, setConversationMode] = useState(false);

  // Screenshot state
  const [screenshotImage, setScreenshotImage] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);

  const isVadMode = vadConfig.enabled;
  const hasResponse = lastAIResponse || isAIProcessing;

  // Keyboard shortcut for Cmd+K to toggle view mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPopoverOpen) return;

      // Cmd+K or Ctrl+K to toggle view mode
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setConversationMode((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPopoverOpen]);

  // Reset screenshot when processing starts (message is being sent)
  useEffect(() => {
    if (isProcessing && screenshotImage) {
      setScreenshotImage(null);
    }
  }, [isProcessing, screenshotImage]);

  const handleToggleCapture = async () => {
    if (capturing) {
      await stopCapture();
    } else {
      await startCapture();
    }
  };

  const handleModeChange = (vadEnabled: boolean) => {
    updateVadConfiguration({
      ...vadConfig,
      enabled: vadEnabled,
    });
  };

  // Capture screenshot functionality
  const handleCaptureScreenshot = useCallback(async () => {
    if (isCapturingScreenshot) return;

    setIsCapturingScreenshot(true);
    try {
      // Check screen recording permission on macOS
      if (isMacOS()) {
        const {
          checkScreenRecordingPermission,
          requestScreenRecordingPermission,
        } = await import("tauri-plugin-macos-permissions-api");

        const hasPermission = await checkScreenRecordingPermission();
        if (!hasPermission) {
          await requestScreenRecordingPermission();
          setIsCapturingScreenshot(false);
          return;
        }
      }

      // Capture screenshot
      const base64: string = await invoke("capture_screenshot", {
        screenId: null, // Use default screen
      });

      setScreenshotImage(base64);
    } catch (err) {
      console.error("Failed to capture screenshot:", err);
    } finally {
      setIsCapturingScreenshot(false);
    }
  }, [isCapturingScreenshot]);

  const handleRemoveScreenshot = useCallback(() => {
    setScreenshotImage(null);
  }, []);

  const getButtonIcon = () => {
    if (setupRequired) return <AlertCircleIcon className="text-warn" />;
    if (error && !setupRequired)
      return <AlertCircleIcon className="text-destructive" />;
    if (isProcessing) return <LoaderIcon className="animate-spin" />;
    if (capturing) {
      // Manual mode armed-but-idle is not "listening" — don't pulse
      // unless audio is actually being captured.
      if (!isVadMode && !isRecordingInContinuousMode) {
        return <AudioLinesIcon className="text-warn" />;
      }
      return <AudioLinesIcon className="text-primary animate-pulse" />;
    }
    return <HeadphonesIcon />;
  };

  const getButtonTitle = () => {
    if (setupRequired) return "Setup required - Click for instructions";
    if (error && !setupRequired) return `Error: ${error}`;
    if (isProcessing) return "Transcribing audio...";
    if (capturing) {
      if (!isVadMode && !isRecordingInContinuousMode) {
        return "Manual mode (not listening) — press Start Recording, or switch to Auto to listen continuously";
      }
      return isVadMode
        ? "Listening (auto) — click to stop"
        : "Recording (manual) — click to stop";
    }
    return "Start system audio capture";
  };

  return (
    <Popover
      open={isPopoverOpen}
      onOpenChange={(open) => {
        if (capturing && !open) {
          return;
        }
        setIsPopoverOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="icon"
          title={getButtonTitle()}
          onClick={handleToggleCapture}
          className={cn(
            capturing && "bg-primary/10 hover:bg-primary/20",
            error && "bg-destructive/15 hover:bg-destructive/25"
          )}
        >
          {getButtonIcon()}
        </Button>
      </PopoverTrigger>

      {(capturing || setupRequired || error) && (
        <PopoverContent
          align="end"
          side="bottom"
          className="select-none w-screen p-0 border shadow-lg overflow-hidden border-input/50"
          sideOffset={8}
        >
          <div className="relative flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
            {isSttInitializing && <SttInitOverlay />}


            {/* Header - Mode Switcher + Actions */}
            <div className="flex-shrink-0 p-3 border-b border-border/50">
              <div className="flex items-center justify-between gap-2">
                {/* Mode Switcher */}
                {!setupRequired && (
                  <ModeSwitcher
                    isVadMode={isVadMode}
                    onModeChange={handleModeChange}
                    disabled={
                      isRecordingInContinuousMode ||
                      isProcessing ||
                      isAIProcessing
                    }
                  />
                )}
                {setupRequired && (
                  <h2 className="font-semibold text-sm">Setup Required</h2>
                )}

                {/* Action Buttons */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {/* Screenshot Button */}
                  {hasActiveLicense && !setupRequired && supportsImages && (
                    <Button
                      size="sm"
                      variant={screenshotImage ? "default" : "outline"}
                      onClick={handleCaptureScreenshot}
                      disabled={isCapturingScreenshot}
                      className={cn(
                        "h-6 text-[10px] gap-1 px-2",
                        screenshotImage && "bg-primary text-primary-foreground"
                      )}
                      title="Capture screenshot to include with transcription"
                    >
                      {isCapturingScreenshot ? (
                        <LoaderIcon className="w-3 h-3 animate-spin" />
                      ) : (
                        <CameraIcon className="w-3 h-3" />
                      )}
                      Screenshot
                    </Button>
                  )}

                  {/* New Conversation Button */}
                  {!setupRequired && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={startNewConversation}
                      className="h-6 text-[10px] gap-1 px-2"
                      title="Start a new conversation"
                    >
                      <PlusIcon className="w-3 h-3" />
                      New
                    </Button>
                  )}

                  {/* Close Button */}
                  {!capturing && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      title="Close"
                      onClick={() => {
                        setIsPopoverOpen(false);
                        resizeWindow(false);
                      }}
                    >
                      <XIcon className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            </div>

            <ScrollArea className="flex-1 min-h-0" ref={scrollAreaRef}>
              <div className="p-2 space-y-2">
                {/* Screenshot Preview */}
                {screenshotImage && (
                  <div className="flex items-center gap-2 p-2 rounded-lg bg-primary/5 border border-primary/20">
                    <img
                      src={`data:image/png;base64,${screenshotImage}`}
                      alt="Screenshot"
                      className="h-12 w-20 object-cover rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] font-medium">
                        Screenshot attached
                      </p>
                      <p className="text-[9px] text-muted-foreground">
                        Will be sent with next transcription
                      </p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-5 w-5"
                      onClick={handleRemoveScreenshot}
                    >
                      <XIcon className="h-3 w-3" />
                    </Button>
                  </div>
                )}

                {/* Error Display */}
                {error && !setupRequired && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-destructive/10 border border-destructive/30">
                    <AlertCircleIcon className="w-3.5 h-3.5 text-destructive flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="font-mono text-[10px] text-destructive">
                        error
                      </p>
                      <p className="text-[10px] text-muted-foreground">{error}</p>
                    </div>
                  </div>
                )}

                {/* Setup Required - Permission Flow */}
                {setupRequired ? (
                  <PermissionFlow
                    onPermissionGranted={() => {
                      startCapture();
                    }}
                    onPermissionDenied={() => {
                      // Keep showing setup instructions
                    }}
                  />
                ) : (
                  <>
                    {/* Live input-level meter + no-audio hint (VAD listening) */}
                    {capturing && isVadMode && (
                      <div className="px-1 pb-2 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide shrink-0">
                            Input
                          </span>
                          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-[width] duration-100",
                                noAudioDetected ? "bg-warn" : "bg-ok"
                              )}
                              style={{
                                width: `${Math.min(
                                  100,
                                  Math.round((audioLevel ?? 0) * 100 * 3)
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                        {noAudioDetected && (
                          <p className="text-[10px] text-warn leading-snug">
                            No system audio detected. Make sure something is
                            playing, and that Aileron has permission in{" "}
                            <span className="font-medium">
                              System Settings → Privacy &amp; Security → Screen
                              &amp; System Audio Recording
                            </span>
                            .
                          </p>
                        )}
                      </div>
                    )}

                    {/* Recording Panel */}
                    <RecordingPanel
                      isVadMode={isVadMode}
                      isRecording={isRecordingInContinuousMode}
                      isProcessing={isProcessing}
                      isAIProcessing={isAIProcessing}
                      recordingProgress={recordingProgress}
                      maxDuration={vadConfig.max_recording_duration_secs}
                      onStartRecording={startContinuousRecording}
                      onStopAndSend={manualStopAndSend}
                      onIgnore={ignoreContinuousRecording}
                      partialTranscription={partialTranscription}
                      isStreaming={isStreaming}
                    />

                    {/* AI Response */}
                    <ResultsSection
                      lastTranscription={lastTranscription}
                      lastAIResponse={lastAIResponse}
                      isAIProcessing={isAIProcessing}
                      conversation={conversation}
                      conversationMode={conversationMode}
                      setConversationMode={setConversationMode}
                      partialTranscription={partialTranscription}
                      isStreaming={isStreaming}
                      isLabelingSpeakers={isLabelingSpeakers}
                      currentSpeaker={currentSpeaker}
                    />

                    {/* Session Summary (post-capture) */}
                    {(isSummarizing || sessionSummary) && (
                      <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <FileTextIcon className="w-3.5 h-3.5 text-primary" />
                            <h4 className="text-xs font-medium">
                              Session Summary
                            </h4>
                          </div>
                          {sessionSummary && !isSummarizing && (
                            <button
                              onClick={dismissSummary}
                              title="Dismiss summary"
                              className="text-muted-foreground/60 hover:text-muted-foreground"
                            >
                              <XIcon className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        {isSummarizing && !sessionSummary ? (
                          <div className="flex items-center gap-2 py-1">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                            <span className="text-xs text-muted-foreground">
                              Summarizing session…
                            </span>
                          </div>
                        ) : (
                          <div className="prose prose-sm max-w-none dark:prose-invert text-[11px]">
                            <Markdown>{sessionSummary}</Markdown>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Settings Panel */}
                    <SettingsPanel
                      vadConfig={vadConfig}
                      onUpdateVadConfig={updateVadConfiguration}
                      useSystemPrompt={useSystemPrompt}
                      setUseSystemPrompt={setUseSystemPrompt}
                      contextContent={contextContent}
                      setContextContent={setContextContent}
                    />

                    {/* Help/Keyboard Shortcuts */}
                    <Warning isVadMode={isVadMode} />
                  </>
                )}
              </div>
            </ScrollArea>

            {/* Quick Actions */}
            {!setupRequired && hasResponse && (
              <div className="flex-shrink-0 border-t border-border/50 p-2">
                <QuickActions
                  actions={quickActions}
                  onActionClick={handleQuickActionClick}
                  onAddAction={addQuickAction}
                  onRemoveAction={removeQuickAction}
                  isManaging={isManagingQuickActions}
                  setIsManaging={setIsManagingQuickActions}
                  show={showQuickActions}
                  setShow={setShowQuickActions}
                />
              </div>
            )}
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
};
