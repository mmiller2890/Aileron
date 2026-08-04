import { ChatConversation } from "@/types";
import { Markdown, Switch, CopyButton } from "@/components";
import { BotIcon, HeadphonesIcon, Loader2, SparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isMacOS } from "@/lib";

type Props = {
  lastTranscription: string;
  lastAIResponse: string;
  isAIProcessing: boolean;
  conversation: ChatConversation;
  conversationMode: boolean;
  setConversationMode: (mode: boolean) => void;
  isLabelingSpeakers?: boolean;
  currentSpeaker?: string | null;
};

export const ResultsSection = ({
  lastTranscription,
  lastAIResponse,
  isAIProcessing,
  conversation,
  conversationMode,
  setConversationMode,
  isLabelingSpeakers = false,
  currentSpeaker = null,
}: Props) => {
  const hasResponse = lastAIResponse || isAIProcessing;
  const hasHistory = conversation.messages.length > 2;

  if (!hasResponse && !lastTranscription) {
    return null;
  }

  const modKey = isMacOS() ? "⌘" : "Ctrl";

  const transcriptionText = lastTranscription;

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-3">
      {/* Header with toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <SparklesIcon className="w-3.5 h-3.5 text-primary" />
          <h4 className="font-mono text-[11px] text-primary">
            {conversationMode ? "conversation" : "answer"}
          </h4>
        </div>
        <div className="flex items-center gap-2 select-none">
          <span className="font-mono text-[9px] text-meta bg-secondary px-1 rounded">
            {modKey}+K
          </span>
          <Switch
            checked={conversationMode}
            onCheckedChange={setConversationMode}
            className="scale-75"
          />
          {lastAIResponse && <CopyButton content={lastAIResponse} />}
        </div>
      </div>

      {/* RESPONSE MODE: System as text, then AI response */}
      {!conversationMode && (
        <div className="space-y-2">
          {/* System Input - mono meta label, sans content */}
          {transcriptionText && (
            <p className="text-[11px]">
              <span className="font-mono text-meta">system</span>{" "}
              {currentSpeaker && (
                <span className="font-mono text-[9px] text-muted-foreground mr-1">
                  {currentSpeaker}
                </span>
              )}
              {isLabelingSpeakers && !currentSpeaker && (
                <span className="font-mono text-[9px] text-meta italic mr-1">
                  labeling speakers…
                </span>
              )}
              <span
                className="text-muted-foreground"
              >
                {transcriptionText}
              </span>
            </p>
          )}

          {/* AI Response — signal left rule */}
          {hasResponse && (
            <div className="border-l-2 border-primary pl-3">
              {isAIProcessing && !lastAIResponse ? (
                <div className="flex items-center gap-2 py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="font-mono text-xs text-muted-foreground">
                    answering
                  </span>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <Markdown>{lastAIResponse}</Markdown>
                  {isAIProcessing && (
                    <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 align-middle" />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* CONVERSATION MODE: AI on top, then System, then history */}
      {conversationMode && (
        <div className="space-y-2">
          {/* AI Response - First (on top) — signal left rule */}
          {hasResponse && (
            <div className="rounded-md border-l-2 border-primary bg-background p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <BotIcon className="h-3 w-3 text-primary" />
                <span className="font-mono text-[9px] text-primary">
                  answer
                </span>
              </div>
              {isAIProcessing && !lastAIResponse ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    answering
                  </span>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none dark:prose-invert text-sm">
                  <Markdown>{lastAIResponse}</Markdown>
                  {isAIProcessing && (
                    <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1 align-middle" />
                  )}
                </div>
              )}
            </div>
          )}

          {/* System Input - Second */}
          {transcriptionText && (
            <div className="rounded-md border border-border bg-background p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <HeadphonesIcon className="h-3 w-3 text-muted-foreground" />
                <span className="font-mono text-[9px] text-meta">
                  system
                </span>
                {currentSpeaker && (
                  <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                    {currentSpeaker}
                  </span>
                )}
                {isLabelingSpeakers && !currentSpeaker && (
                  <span className="text-[9px] text-muted-foreground italic">
                    Labeling speakers…
                  </span>
                )}
              </div>
              <p className="text-sm">
                {transcriptionText}
              </p>
            </div>
          )}

          {/* Previous Messages */}
          {hasHistory && (
            <div className="space-y-2 pt-2 border-t border-border">
              <p className="font-mono text-[9px] text-meta">
                previous
              </p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {conversation.messages
                  .slice(2)
                  .sort((a, b) => b.timestamp - a.timestamp)
                  .map((message, index) => (
                    <div
                      key={message.id || index}
                      className={cn(
                        "p-2 rounded-md text-[11px]",
                        message.role === "user"
                          ? "bg-secondary/50 border-l-2 border-border"
                          : "bg-background"
                      )}
                    >
                      <span className="font-mono text-[8px] text-meta">
                        {message.role === "user"
                          ? (message.speaker || "system").toLowerCase()
                          : "answer"}
                      </span>
                      <div className="text-muted-foreground leading-relaxed mt-0.5">
                        <Markdown>{message.content}</Markdown>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
