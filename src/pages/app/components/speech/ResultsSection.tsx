import { ChatConversation } from "@/types";
import { Markdown, Switch, CopyButton } from "@/components";
import { BotIcon, HeadphonesIcon, Loader2, SparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { isMacOS } from "@/lib";
import { SpeakerTag } from "@/components/SpeakerTag";

type Props = {
  lastTranscription: string;
  lastAIResponse: string;
  isAIProcessing: boolean;
  conversation: ChatConversation;
  conversationMode: boolean;
  setConversationMode: (mode: boolean) => void;
  currentSpeaker?: string | null;
  /** Provisional text for the turn in progress. */
  partialTranscription?: string;
  /** Who is speaking in the turn in progress, when known. */
  partialSpeaker?: string | null;
};

export const ResultsSection = ({
  lastTranscription,
  lastAIResponse,
  isAIProcessing,
  conversation,
  conversationMode,
  setConversationMode,
  currentSpeaker = null,
  partialTranscription = "",
  partialSpeaker = null,
}: Props) => {
  const provisional = partialTranscription.trim();
  const hasResponse = lastAIResponse || isAIProcessing;
  const hasHistory = conversation.messages.length > 2;

  if (!hasResponse && !lastTranscription && !provisional) {
    return null;
  }

  const modKey = isMacOS() ? "⌘" : "Ctrl";

  const transcriptionText = lastTranscription;

  // The turn in progress gets its own line. The settled question stays put so
  // the answer below it never appears to belong to different words.
  const hearingLine = provisional ? (
    <p className="flex items-baseline gap-1.5 text-[11px] text-muted-foreground">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 translate-y-[-1px] animate-pulse bg-primary"
      />
      <SpeakerTag
        speaker={partialSpeaker}
        fallback="hearing"
        className="shrink-0 text-[9px] text-meta"
      />
      <span className="min-w-0 italic">{provisional}</span>
    </p>
  ) : null;

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
                <SpeakerTag
                  speaker={currentSpeaker}
                  fallback=""
                  className="mr-1 text-[9px]"
                />
              )}
              <span className="text-muted-foreground">{transcriptionText}</span>
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

          {hearingLine}
        </div>
      )}

      {/* CONVERSATION MODE: AI on top, then System, then history */}
      {conversationMode && (
        <div className="space-y-2">
          {/* Newest first here, so the turn in progress leads. */}
          {hearingLine}
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
                  <SpeakerTag
                    speaker={currentSpeaker}
                    fallback=""
                    className="text-[9px]"
                  />
                )}
              </div>
              <p className="text-sm">{transcriptionText}</p>
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
                      {message.role === "user" ? (
                        <SpeakerTag
                          speaker={message.speaker}
                          fallback="system"
                          className="text-[8px] text-meta"
                        />
                      ) : (
                        <span className="font-mono text-[8px] text-meta">
                          answer
                        </span>
                      )}
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
