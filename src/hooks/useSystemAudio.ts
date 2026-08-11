import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import {
  fetchSTT,
  fetchAIResponse,
  isLikelyQuestion,
  isBackchannel,
  buildAIHistory,
  buildSummaryTranscript,
} from "@/lib/functions";
import { useSttStatus } from "./useSttStatus";
import {
  generateConversationTitle,
  saveConversation,
  CONVERSATION_SAVE_DEBOUNCE_MS,
  generateConversationId,
  generateMessageId,
  isMacOS,
  isWindows,
  createTokenBatcher,
} from "@/lib";
import { ChatConversation, Message } from "@/types/completion";
import { useSpeakerLabels } from "./system-audio/useSpeakerLabels";
import { useVadConfig, type VadConfig } from "./system-audio/useVadConfig";
import { useLiveStatePublisher } from "./system-audio/useLiveStatePublisher";
import {
  LIVE_SESSION_COMMAND,
  LIVE_SNAPSHOT_MAX_MESSAGES,
  LiveSessionCommand,
  LiveSessionCommandAction,
  LiveSessionSnapshot,
} from "@/lib/live-session";
import { useQuickActions } from "./system-audio/useQuickActions";
import { useContextSettings } from "./system-audio/useContextSettings";
import { useCaptureKeyboardShortcuts } from "./system-audio/useCaptureKeyboardShortcuts";
import { beginCaptureSession } from "./system-audio/startCaptureSession";
import { createAsyncListenerScope } from "@/lib/async-listener-scope";
import {
  RecentSpeechEventFingerprints,
  type SpeechEventPayload,
} from "@/lib/speech-event-dedupe";
import {
  createCaptureSessionWork,
  getSessionAudioStopAction,
} from "@/lib/capture-session-work";
import { completedStreamValue } from "@/lib/completed-stream";
import { normalizeFluidAudioModel } from "@/lib/fluidaudio-model";

export type { VadConfig };

/** Below this many captured utterances a session summary isn't worth the tokens. */
const MIN_UTTERANCES_FOR_SUMMARY = 2;

// Conversation/message shapes are the shared app types; re-exported here for
// existing importers of this module.
export type { ChatConversation };

export type useSystemAudioType = ReturnType<typeof useSystemAudio>;

export function useSystemAudio() {
  const { resizeWindow } = useWindowResize();
  const globalShortcuts = useGlobalShortcuts();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isAIProcessing, setIsAIProcessing] = useState(false);
  const [lastTranscription, setLastTranscription] = useState<string>("");
  const [lastAIResponse, setLastAIResponse] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [setupRequired, setSetupRequired] = useState<boolean>(false);
  const {
    quickActions,
    addQuickAction,
    removeQuickAction,
    isManagingQuickActions,
    setIsManagingQuickActions,
    showQuickActions,
    setShowQuickActions,
  } = useQuickActions();
  const { vadConfig, updateVadConfiguration } = useVadConfig();
  const [recordingProgress, setRecordingProgress] = useState<number>(0);
  // Live input level (0..1, raw peak) and a "no audio detected" flag, both
  // driven by backend events during VAD capture — they surface the silent-tap
  // failure that otherwise looks identical to normal listening.
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [captureSampleRate, setCaptureSampleRate] = useState<number>(48_000);
  const [noAudioDetected, setNoAudioDetected] = useState<boolean>(false);
  // Post-session summary generated after a capture ends (survives the stop
  // cleanup; cleared on the next start or when dismissed).
  const [sessionSummary, setSessionSummary] = useState<string>("");
  const [isSummarizing, setIsSummarizing] = useState<boolean>(false);
  const [isContinuousMode, setIsContinuousMode] = useState<boolean>(false);
  const [isRecordingInContinuousMode, setIsRecordingInContinuousMode] =
    useState<boolean>(false);
  // Wall-clock start of the running capture session; drives the dashboard's
  // live timer (computed locally there — no per-second events).
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);

  const [conversation, setConversation] = useState<ChatConversation>({
    id: "",
    title: "",
    messages: [],
    createdAt: 0,
    updatedAt: 0,
  });

  const {
    speakerSegments,
    setSpeakerSegments,
    isLabelingSpeakers,
    setIsLabelingSpeakers,
    currentSpeaker,
    setCurrentSpeaker,
    getSpeakerForUtterance,
    labelMessagesWithSpeakers,
  } = useSpeakerLabels(setConversation);

  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
    onSetSelectedSttProvider,
  } = useApp();
  const {
    useSystemPrompt,
    setUseSystemPrompt,
    contextContent,
    setContextContent,
    getEffectiveSystemPrompt,
    resetUseSystemPrompt,
  } = useContextSettings(systemPrompt);
  const {
    isSupported,
    asrReady,
    isInitializing: isSttInitializing,
    init: initStt,
  } = useSttStatus();
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeAiBatcherRef = useRef<ReturnType<
    typeof createTokenBatcher
  > | null>(null);
  // Monotonic id for AI requests; processWithAI uses it to detect when a
  // newer utterance has superseded an in-flight stream.
  const aiRequestSeqRef = useRef(0);
  // Most recent captured utterance, answered or not — the target of the
  // answer-last-utterance shortcut.
  const lastUtteranceRef = useRef<{ text: string; messageId: string } | null>(
    null,
  );
  // Read by the once-registered shortcut listener; assigned below after
  // answerLastUtterance is defined (same stale-closure guard as
  // processWithAIRef).
  const answerLastRef = useRef<() => void>(() => {});
  // Ref-backed so stopCapture (empty deps) always calls the freshest version,
  // which reads the current AI provider.
  const generateSummaryRef = useRef<() => void>(() => {});
  // Lets the capture-ended-unexpectedly listener (registered once, on mount)
  // run the real teardown instead of duplicating it.
  const stopCaptureRef = useRef<() => Promise<void>>(async () => {});
  // The summary streams independently of processWithAI, so it needs its own
  // abort + sequence guard; without them a summary from a previous stop keeps
  // streaming into the panel after the next capture begins.
  const summaryAbortRef = useRef<AbortController | null>(null);
  const activeSummaryBatcherRef = useRef<ReturnType<
    typeof createTokenBatcher
  > | null>(null);
  const summarySeqRef = useRef(0);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef<boolean>(false);
  const utteranceTimestampsRef = useRef<Array<{ start: number; end: number }>>(
    [],
  );
  const recentSpeechEventsRef = useRef(new RecentSpeechEventFingerprints());
  const captureSessionWorkRef = useRef(createCaptureSessionWork());
  const captureGenerationRef = useRef(0);
  const captureStoppingRef = useRef(false);
  const captureModelLeaseRef = useRef(false);

  const capturingRef = useRef(capturing);
  const selectedSttProviderRef = useRef(selectedSttProvider);
  const allSttProvidersRef = useRef(allSttProviders);
  const conversationMessagesRef = useRef(conversation.messages);
  const vadConfigRef = useRef(vadConfig);
  const labelMessagesWithSpeakersRef = useRef(labelMessagesWithSpeakers);
  // `processWithAI` is invoked from the `speech-detected` listener, registered
  // once with empty/stable deps. It captures its closure on the first render —
  // when `selectedAIProvider` is still the initial empty value (the context
  // hydrates it from localStorage afterwards), which made system-audio capture
  // fail with "No AI provider selected" even after a provider was chosen.
  // Mirror the latest callback into a ref, like the other listener-visible
  // values above, so that call site always reads the current provider.
  // Assigned after `processWithAI` is defined below.
  const processWithAIRef = useRef<
    (
      transcription: string,
      prompt: string,
      previousMessages: Message[],
      existingUserMessageId?: string,
    ) => Promise<void>
  >(async () => {});
  capturingRef.current = capturing;
  selectedSttProviderRef.current = selectedSttProvider;
  allSttProvidersRef.current = allSttProviders;
  conversationMessagesRef.current = conversation.messages;
  vadConfigRef.current = vadConfig;
  labelMessagesWithSpeakersRef.current = labelMessagesWithSpeakers;

  useEffect(() => {
    const scope = createAsyncListenerScope();
    void Promise.all([
      scope.add(
        listen(
          "capture-started",
          scope.guard((event) => {
            recentSpeechEventsRef.current.clear();
            const sampleRate = Number(event.payload);
            if (Number.isFinite(sampleRate) && sampleRate > 0) {
              setCaptureSampleRate(sampleRate);
            }
          }),
        ),
      ),
      scope.add(
        listen(
          "capture-ended-unexpectedly",
          scope.guard(() => {
            // The native capture task exited on its own (device disconnect,
            // sleep/wake, stream failure). Run the normal teardown so the UI
            // does not stay stuck on "listening", then explain why.
            if (!capturingRef.current || captureStoppingRef.current) {
              return;
            }
            void stopCaptureRef.current().then(() => {
              setError(
                "Audio capture stopped unexpectedly — check your output device, then start again.",
              );
            });
          }),
        ),
      ),
      scope.add(
        listen(
          "recording-progress",
          scope.guard((event) => {
            const seconds = event.payload as number;
            setRecordingProgress(seconds);
          }),
        ),
      ),
      scope.add(
        listen(
          "continuous-recording-start",
          scope.guard(() => {
            setRecordingProgress(0);
            setIsRecordingInContinuousMode(true);
          }),
        ),
      ),
      scope.add(
        listen(
          "continuous-recording-stopped",
          scope.guard(() => {
            setRecordingProgress(0);
            setIsRecordingInContinuousMode(false);
          }),
        ),
      ),
      scope.add(
        listen(
          "audio-encoding-error",
          scope.guard((event) => {
            const errorMsg = event.payload as string;
            console.error("Audio encoding error:", errorMsg);
            setError(`Failed to process audio: ${errorMsg}`);
            setIsProcessing(false);
            setIsAIProcessing(false);
            setIsRecordingInContinuousMode(false);
          }),
        ),
      ),
      scope.add(
        listen(
          "speech-discarded",
          scope.guard(() => {}),
        ),
      ),
    ]).catch((err) => {
      console.error("Failed to setup continuous recording listeners:", err);
    });

    return () => {
      scope.dispose();
    };
  }, []);

  useEffect(() => {
    const scope = createAsyncListenerScope();
    void Promise.all([
      scope.add(
        listen(
          "speech-detected",
          scope.guard(async (event) => {
            const generation = captureGenerationRef.current;
            try {
              if (!capturingRef.current) return;
              if (!captureSessionWorkRef.current.isCurrent(generation)) {
                return;
              }

              const payload = event.payload as SpeechEventPayload;
              const base64Audio = payload.audio;
              if (!base64Audio || base64Audio.length < 100) {
                return;
              }
              if (!recentSpeechEventsRef.current.claim(payload)) {
                return;
              }

              if (payload.start_time !== 0 || payload.end_time !== 0) {
                utteranceTimestampsRef.current.push({
                  start: payload.start_time,
                  end: payload.end_time,
                });
              }

              // Deferred: the local provider transcribes by handle (below) and
              // never needs the decoded WAV, and this loop runs over every byte
              // of the utterance on the UI thread.
              const audioBlob = () => {
                const binaryString = atob(base64Audio);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i);
                }
                return new Blob([bytes], { type: "audio/wav" });
              };

              const currentSelected = selectedSttProviderRef.current;
              const currentProviders = allSttProvidersRef.current;

              if (!currentSelected.provider) {
                setError("No speech provider selected.");
                return;
              }

              const providerConfig = currentProviders.find(
                (p) => p.id === currentSelected.provider,
              );

              if (!providerConfig) {
                setError("Speech provider config not found.");
                return;
              }

              setIsProcessing(true);

              const sttAbortController = new AbortController();
              const timeoutId = setTimeout(() => {
                sttAbortController.abort();
              }, 30000);

              try {
                const transcription = await captureSessionWorkRef.current.track(
                  generation,
                  fetchSTT({
                    provider: providerConfig,
                    selectedProvider: currentSelected,
                    audio: audioBlob,
                    utteranceId: payload.utterance_id ?? undefined,
                    signal: sttAbortController.signal,
                  }),
                );
                if (!captureSessionWorkRef.current.isCurrent(generation)) {
                  return;
                }

                if (transcription.trim()) {
                  // Pure backchannels ("Yeah.", "Mm-hmm.") carry no content —
                  // keep them out of the transcript, the overlay, and the
                  // question gate. VAD timing can't separate a 400ms "Yeah"
                  // from a 400ms "Why?"; only content can.
                  if (isBackchannel(transcription)) {
                    if (import.meta.env.DEV) {
                      console.debug(
                        "Dropped backchannel transcription:",
                        transcription,
                      );
                    }
                    return;
                  }

                  setLastTranscription(transcription);
                  setError("");

                  // Every utterance lands in the transcript; only likely
                  // questions earn an automatic answer. The rest can be
                  // answered on demand via the answer-last shortcut.
                  const messageId = appendUtteranceMessage(transcription);
                  lastUtteranceRef.current = {
                    text: transcription,
                    messageId,
                  };

                  if (
                    isLikelyQuestion(transcription) &&
                    !captureStoppingRef.current
                  ) {
                    const effectiveSystemPrompt = getEffectiveSystemPrompt();

                    const previousMessages = buildAIHistory(
                      conversationMessagesRef.current,
                      messageId,
                    );

                    void processWithAIRef.current(
                      transcription,
                      effectiveSystemPrompt,
                      previousMessages,
                      messageId,
                    );
                  }
                } else {
                  // Non-speech segments (music, ambience) legitimately transcribe
                  // to nothing — skip them quietly instead of surfacing an error.
                  console.warn(
                    "Skipping empty transcription for non-speech segment",
                  );
                }
              } catch (sttError: any) {
                if (!captureSessionWorkRef.current.isCurrent(generation)) {
                  return;
                }
                console.error("STT Error:", sttError);
                if (sttAbortController.signal.aborted) {
                  setError("Speech transcription timed out (30s)");
                } else {
                  setError(sttError.message || "Failed to transcribe audio");
                }
                setIsPopoverOpen(true);
              } finally {
                clearTimeout(timeoutId);
              }
            } catch (err) {
              if (captureSessionWorkRef.current.isCurrent(generation)) {
                setError("Failed to process speech");
              }
            } finally {
              if (captureSessionWorkRef.current.isCurrent(generation)) {
                setIsProcessing(false);
              }
            }
          }),
        ),
      ),
    ]).catch(() => {
      setError("Failed to setup speech listener");
    });

    return () => {
      scope.dispose();
    };
  }, []);

  const handleQuickActionClick = async (action: string) => {
    setError("");

    const effectiveSystemPrompt = getEffectiveSystemPrompt();

    let updatedMessages = [...conversation.messages];

    if (lastTranscription && lastTranscription.trim()) {
      const lastMessage = updatedMessages[updatedMessages.length - 1];
      if (!lastMessage || lastMessage.content !== lastTranscription) {
        const timestamp = Date.now();
        const userMessage = {
          id: generateMessageId("user", timestamp),
          role: "user" as const,
          content: lastTranscription,
          timestamp,
        };
        updatedMessages.push(userMessage);

        setConversation((prev) => ({
          ...prev,
          messages: [userMessage, ...prev.messages],
          updatedAt: timestamp,
          title: prev.title || generateConversationTitle(lastTranscription),
        }));
      }
    }

    const previousMessages = buildAIHistory(updatedMessages);

    await processWithAI(action, effectiveSystemPrompt, previousMessages);
  };

  const startContinuousRecording = useCallback(async () => {
    try {
      setRecordingProgress(0);
      setError("");

      // Manual record supersedes any active session. Only one capture task
      // can exist on the Rust side, so a running VAD session must be stopped
      // first — otherwise the start below is rejected with "Capture already
      // running" and the VAD session keeps picking up audio.
      if (capturingRef.current) {
        await invoke("stop_system_audio_capture");
      }

      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      const providerConfig = allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider,
      );

      // The record button always means a manual take, regardless of which
      // mode the current session was started in.
      await invoke<string>("start_system_audio_capture", {
        vadConfig: { ...vadConfig, enabled: false },
        deviceId: deviceId,
        streaming: providerConfig?.streaming === true,
      });
      setIsContinuousMode(true);
    } catch (err) {
      console.error("Failed to start continuous recording:", err);
      setError(`Failed to start recording: ${err}`);
    }
  }, [
    vadConfig,
    selectedAudioDevices.output.id,
    allSttProviders,
    selectedSttProvider.provider,
  ]);

  const ignoreContinuousRecording = useCallback(async () => {
    try {
      if (!isContinuousMode || !isRecordingInContinuousMode) return;

      await invoke<string>("stop_system_audio_capture");

      setRecordingProgress(0);
      setIsProcessing(false);
      setIsRecordingInContinuousMode(false);
    } catch (err) {
      console.error("Failed to ignore recording:", err);
      setError(`Failed to ignore recording: ${err}`);
    }
  }, [isContinuousMode, isRecordingInContinuousMode]);

  // Record a captured utterance in the transcript immediately, whether or not
  // it earns an automatic answer. Returns the message id so the answer path
  // can attach the assistant reply without duplicating the user entry.
  const appendUtteranceMessage = useCallback(
    (transcription: string): string => {
      const timestamp = Date.now();
      const id = generateMessageId("user", timestamp);
      setConversation((prev) => ({
        ...prev,
        messages: [
          { id, role: "user" as const, content: transcription, timestamp },
          ...prev.messages,
        ],
        updatedAt: timestamp,
        title: prev.title || generateConversationTitle(transcription),
      }));
      return id;
    },
    [],
  );

  const processWithAI = useCallback(
    async (
      transcription: string,
      prompt: string,
      previousMessages: Message[],
      existingUserMessageId?: string,
    ) => {
      activeAiBatcherRef.current?.cancel();
      activeAiBatcherRef.current = null;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;
      // Latest-question-wins: each call supersedes any in-flight one. The
      // signal cancels the fetch, and the request id stops a superseded
      // stream from appending chunks that were already in flight — without
      // both, concurrent utterances interleave into the same response text.
      const requestId = ++aiRequestSeqRef.current;
      const isCurrent = () =>
        requestId === aiRequestSeqRef.current && !signal.aborted;

      try {
        setIsAIProcessing(true);
        setLastAIResponse("");
        setError("");

        let fullResponse = "";
        let streamCompleted = false;

        if (!selectedAIProvider.provider) {
          setError("No AI provider selected.");
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider,
        );
        if (!provider) {
          setError("AI provider config not found.");
          return;
        }

        try {
          const batcher = createTokenBatcher(
            (batched) => setLastAIResponse((prev) => prev + batched),
            undefined,
            isCurrent,
          );
          activeAiBatcherRef.current = batcher;
          try {
            for await (const chunk of fetchAIResponse({
              provider,
              selectedProvider: selectedAIProvider,
              systemPrompt: prompt,
              history: previousMessages,
              userMessage: transcription,
              imagesBase64: [],
              signal,
            })) {
              if (!isCurrent()) {
                batcher.cancel();
                return;
              }
              fullResponse += chunk;
              batcher.push(chunk);
            }
            if (!isCurrent()) {
              batcher.cancel();
              return;
            }
            batcher.flush();
            streamCompleted = true;
          } catch (streamError) {
            batcher.cancel();
            throw streamError;
          } finally {
            if (activeAiBatcherRef.current === batcher) {
              activeAiBatcherRef.current = null;
            }
          }
        } catch (aiError: any) {
          if (!isCurrent() || signal.aborted) return;
          setError(aiError.message || "Failed to get AI response");
        }

        const responseToPersist = completedStreamValue(
          fullResponse,
          streamCompleted,
        );
        if (responseToPersist && isCurrent()) {
          const timestamp = Date.now();
          const latestUtterance =
            utteranceTimestampsRef.current[
              utteranceTimestampsRef.current.length - 1
            ];
          const speaker = latestUtterance
            ? getSpeakerForUtterance(
                latestUtterance.start,
                latestUtterance.end,
                speakerSegments,
              )
            : null;
          setConversation((prev) => {
            const assistantMessage = {
              id: generateMessageId("assistant", timestamp + 1),
              role: "assistant" as const,
              content: responseToPersist,
              timestamp: timestamp + 1,
            };
            // Utterances recorded by appendUtteranceMessage are already in
            // the transcript — attach only the reply to avoid duplicates.
            const hasExistingUserMessage =
              existingUserMessageId !== undefined &&
              prev.messages.some((m) => m.id === existingUserMessageId);
            const messages = hasExistingUserMessage
              ? [assistantMessage, ...prev.messages]
              : [
                  {
                    id: generateMessageId("user", timestamp),
                    role: "user" as const,
                    content: transcription,
                    timestamp,
                    speaker: speaker || undefined,
                  },
                  assistantMessage,
                  ...prev.messages,
                ];
            return {
              ...prev,
              messages,
              updatedAt: timestamp,
              title: prev.title || generateConversationTitle(transcription),
            };
          });
          if (speaker) {
            setCurrentSpeaker(speaker);
          }
        }
      } catch (err) {
        if (isCurrent() && !signal.aborted) {
          setError("Failed to get AI response");
        }
      } finally {
        // A superseded call must not clear the spinner for the active one.
        if (isCurrent()) {
          setIsAIProcessing(false);
        }
      }
    },
    [
      selectedAIProvider,
      allAiProviders,
      conversation.messages,
      speakerSegments,
      getSpeakerForUtterance,
    ],
  );

  // Keep the ref pointing at the freshest `processWithAI` so the once-registered
  // listener/socket call sites never run against a stale `selectedAIProvider`.
  processWithAIRef.current = processWithAI;

  // Answer the most recent captured utterance on demand (global shortcut),
  // regardless of whether the question gate skipped it. Reads everything
  // through refs, so the once-registered listener below stays fresh.
  const answerLastUtterance = useCallback(async () => {
    const last = lastUtteranceRef.current;
    if (!last) {
      return;
    }
    const effectiveSystemPrompt = getEffectiveSystemPrompt();
    const previousMessages = buildAIHistory(
      conversationMessagesRef.current,
      last.messageId,
    );
    await processWithAIRef.current(
      last.text,
      effectiveSystemPrompt,
      previousMessages,
      last.messageId,
    );
  }, []);
  answerLastRef.current = answerLastUtterance;

  // Generate a concise, speaker-attributed summary of the just-ended session
  // (key questions, main points, action items). This is the payoff for the
  // transcript + diarization work — most of a meeting's value lands after it
  // ends. Best-effort: skipped silently if there's nothing to summarize or no
  // AI provider is configured.
  const generateSessionSummary = useCallback(async () => {
    const messages = conversationMessagesRef.current;
    // A single utterance summarizes to itself — not worth a model round-trip.
    if (
      messages.filter((m) => m.role === "user").length <
      MIN_UTTERANCES_FOR_SUMMARY
    ) {
      return;
    }
    if (!selectedAIProvider.provider) return;
    const provider = allAiProviders.find(
      (p) => p.id === selectedAIProvider.provider,
    );
    if (!provider) return;

    // Supersede any summary still streaming from a previous stop, so its
    // chunks can't interleave into this one's output.
    activeSummaryBatcherRef.current?.cancel();
    activeSummaryBatcherRef.current = null;
    summaryAbortRef.current?.abort();
    const controller = new AbortController();
    summaryAbortRef.current = controller;
    const requestId = ++summarySeqRef.current;
    const isCurrent = () =>
      requestId === summarySeqRef.current && !controller.signal.aborted;

    const transcript = buildSummaryTranscript(messages);

    const summaryPrompt =
      "You are summarizing a meeting or interview transcript. Produce a brief summary as short bullet points covering: (1) the key questions or topics raised — attribute to the speaker label when present; (2) the main points and answers; (3) any action items or follow-ups. Be concise; omit sections that don't apply.";

    setIsSummarizing(true);
    setSessionSummary("");
    try {
      const batcher = createTokenBatcher(
        (batched) => setSessionSummary((prev) => prev + batched),
        undefined,
        isCurrent,
      );
      activeSummaryBatcherRef.current = batcher;
      try {
        for await (const chunk of fetchAIResponse({
          provider,
          selectedProvider: selectedAIProvider,
          systemPrompt: summaryPrompt,
          history: [],
          userMessage: `Transcript:\n\n${transcript}`,
          imagesBase64: [],
          signal: controller.signal,
        })) {
          if (!isCurrent()) {
            batcher.cancel();
            return;
          }
          batcher.push(chunk);
        }
        if (!isCurrent()) {
          batcher.cancel();
          return;
        }
        batcher.flush();
      } catch (streamError) {
        batcher.cancel();
        throw streamError;
      } finally {
        if (activeSummaryBatcherRef.current === batcher) {
          activeSummaryBatcherRef.current = null;
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.warn("Session summary failed:", err);
      }
    } finally {
      if (isCurrent()) setIsSummarizing(false);
    }
  }, [selectedAIProvider, allAiProviders]);
  generateSummaryRef.current = generateSessionSummary;

  const dismissSummary = useCallback(() => {
    // Dismissing mid-stream must stop it, or chunks keep arriving after.
    activeSummaryBatcherRef.current?.cancel();
    activeSummaryBatcherRef.current = null;
    summaryAbortRef.current?.abort();
    summarySeqRef.current++;
    setIsSummarizing(false);
    setSessionSummary("");
    setIsSummarizing(false);
  }, []);

  useEffect(() => {
    return globalShortcuts.registerCustomShortcutCallback("answer_last", () =>
      answerLastRef.current(),
    );
  }, [globalShortcuts.registerCustomShortcutCallback]);

  // Input-level meter + no-audio detection from the VAD capture loop.
  // Registered once.
  useEffect(() => {
    const scope = createAsyncListenerScope();
    void Promise.all([
      scope.add(
        listen(
          "audio-level",
          scope.guard((event) => {
            setAudioLevel((event.payload as number) ?? 0);
          }),
        ),
      ),
      scope.add(
        listen(
          "audio-silent",
          scope.guard(() => {
            setNoAudioDetected(true);
          }),
        ),
      ),
    ]).catch((err) => {
      console.warn("Failed to listen for audio level events:", err);
    });
    return () => {
      scope.dispose();
    };
  }, []);

  // The Rust VAD capture emits `audio-device-changed` when the default output
  // device switches mid-session (e.g. AirPods plugged in) — the tap would
  // otherwise keep capturing silence. Transparently restart on the new device.
  // Registered once; reads everything through refs.
  useEffect(() => {
    const scope = createAsyncListenerScope();
    void scope
      .add(
        listen(
          "audio-device-changed",
          scope.guard(async () => {
            if (!capturingRef.current) return;
            setError("Audio device changed — reconnecting…");
            try {
              await invoke("stop_system_audio_capture");
              const providerConfig = allSttProvidersRef.current.find(
                (p) => p.id === selectedSttProviderRef.current.provider,
              );
              await invoke<string>("start_system_audio_capture", {
                vadConfig: vadConfigRef.current,
                deviceId: null, // follow the new default device
                streaming: providerConfig?.streaming === true,
              });
              setError("");
            } catch (err) {
              console.error("Failed to reconnect after device change:", err);
              setError(`Audio device changed and reconnecting failed: ${err}`);
            }
          }),
        ),
      )
      .catch((err) => {
        console.warn("Failed to listen for audio-device-changed:", err);
      });
    return () => {
      scope.dispose();
    };
  }, []);

  const startCapture = useCallback(async () => {
    if (captureModelLeaseRef.current) return;
    captureModelLeaseRef.current = true;
    let started = false;
    try {
      setError("");

      if (selectedSttProvider.provider === "local-fluidaudio") {
        if (!isSupported) {
          onSetSelectedSttProvider({ provider: "groq", variables: {} });
          setError(
            "Local STT requires macOS Apple Silicon — switched to cloud STT",
          );
          return;
        }

        const requestedModel = normalizeFluidAudioModel(
          selectedSttProvider.variables.MODEL,
        );
        const status = await invoke<{
          asr_ready: boolean;
          model_version: "v2" | "v3" | null;
        }>("stt_get_status");

        if (!status.asr_ready || status.model_version !== requestedModel) {
          await initStt(requestedModel);
        }

        const statusAfter = await invoke<{
          asr_ready: boolean;
          model_version: "v2" | "v3" | null;
          vad_ready: boolean;
          diarization_ready: boolean;
        }>("stt_get_status");
        if (
          !statusAfter.asr_ready ||
          statusAfter.model_version !== requestedModel
        ) {
          setError(
            `Failed to initialize FluidAudio ${requestedModel}. Please try again.`,
          );
          return;
        }

        if (!statusAfter.vad_ready) {
          try {
            // 0.5 matches the mic path's positiveSpeechThreshold. The capture
            // loop applies its own 0.5/0.35 hysteresis on the raw probability;
            // this threshold only shapes VadFrame.is_voice_active.
            await invoke("stt_init_vad", { threshold: 0.5 });
          } catch (err) {
            console.warn(
              "Silero VAD init failed, falling back to threshold VAD:",
              err,
            );
          }
        }

        if (!statusAfter.diarization_ready) {
          try {
            await invoke("stt_init_diarization", { threshold: 0.6 });
          } catch (err) {
            console.warn("Diarization init failed:", err);
          }
        }
      }

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      const isContinuous = !vadConfig.enabled;
      const deviceId =
        selectedAudioDevices.output.id !== "default"
          ? selectedAudioDevices.output.id
          : null;

      const providerConfig = allSttProviders.find(
        (p) => p.id === selectedSttProvider.provider,
      );

      captureStoppingRef.current = false;
      const generation = captureSessionWorkRef.current.begin();
      captureGenerationRef.current = generation;
      try {
        await beginCaptureSession({
          isContinuous,
          startBackend: async () => {
            await invoke<string>("stop_system_audio_capture");
            await invoke<string>("start_system_audio_capture", {
              vadConfig: vadConfig,
              deviceId: deviceId,
              streaming: providerConfig?.streaming === true,
            });
          },
          commitStarted: () => {
            started = true;
            const conversationId = generateConversationId("sysaudio");
            setConversation({
              id: conversationId,
              title: "",
              messages: [],
              createdAt: 0,
              updatedAt: 0,
            });
            setCapturing(true);
            capturingRef.current = true;
            setSessionStartedAt(Date.now());
            setIsPopoverOpen(true);
            setIsContinuousMode(isContinuous);
            setRecordingProgress(0);
            setAudioLevel(0);
            setNoAudioDetected(false);
            summaryAbortRef.current?.abort();
            summarySeqRef.current++;
            setSessionSummary("");
            setIsSummarizing(false);
            utteranceTimestampsRef.current = [];
            setSpeakerSegments([]);
            setIsLabelingSpeakers(false);
            setCurrentSpeaker(null);
            if (isContinuous) {
              setIsRecordingInContinuousMode(false);
            }
          },
        });
      } catch (error) {
        captureSessionWorkRef.current.invalidate(generation);
        throw error;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setIsPopoverOpen(true);
    } finally {
      if (!started) {
        captureModelLeaseRef.current = false;
      }
    }
  }, [
    vadConfig,
    selectedAudioDevices.output.id,
    allSttProviders,
    selectedSttProvider,
    isSupported,
    asrReady,
    isSttInitializing,
    initStt,
    onSetSelectedSttProvider,
  ]);

  const stopCapture = useCallback(async () => {
    const generation = captureGenerationRef.current;
    captureStoppingRef.current = true;
    try {
      activeAiBatcherRef.current?.cancel();
      activeAiBatcherRef.current = null;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      const sessionPath = await invoke<string | null>(
        "stop_system_audio_capture",
      );

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const sttDrained = await captureSessionWorkRef.current.drain(
        generation,
        10_000,
      );
      captureSessionWorkRef.current.invalidate(generation);
      capturingRef.current = false;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const sessionAudioStopAction = getSessionAudioStopAction(
        selectedSttProviderRef.current.provider,
        sessionPath,
        sttDrained,
      );
      if (sessionPath) {
        if (sessionAudioStopAction === "diarize") {
          try {
            setIsLabelingSpeakers(true);
            const segments = await invoke<
              Array<{
                speaker_id: string;
                start_time: number;
                end_time: number;
              }>
            >("stt_diarize_file", { path: sessionPath });
            setSpeakerSegments(segments);
            labelMessagesWithSpeakersRef.current(
              segments,
              utteranceTimestampsRef.current,
            );
          } catch (err) {
            console.warn("Diarization failed:", err);
          } finally {
            setIsLabelingSpeakers(false);
          }
        } else if (sessionAudioStopAction === "discard") {
          try {
            await invoke("stt_discard_session_audio", { path: sessionPath });
          } catch (err) {
            console.warn("Failed to discard session audio:", err);
          }
        }
      }

      // Summarize the just-ended session (fire-and-forget). Kept out of the
      // reset below so the summary survives and shows in the popover.
      generateSummaryRef.current();

      setCapturing(false);
      setSessionStartedAt(null);
      setIsProcessing(false);
      setIsAIProcessing(false);
      setIsContinuousMode(false);
      setIsRecordingInContinuousMode(false);
      setRecordingProgress(0);
      setAudioLevel(0);
      setNoAudioDetected(false);
      setLastTranscription("");
      setLastAIResponse("");
      setError("");
    } catch (err) {
      captureStoppingRef.current = false;
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to stop capture: ${errorMessage}`);
      console.error("Stop capture error:", err);
    } finally {
      // Release the start guard here, not on the success path: a stop that
      // throws would otherwise leave the lease held and make startCapture a
      // silent no-op for the rest of the session.
      captureModelLeaseRef.current = false;
    }
  }, []);

  stopCaptureRef.current = stopCapture;

  const manualStopAndSend = useCallback(async () => {
    try {
      if (!isContinuousMode) {
        console.warn("Not in continuous mode");
        return;
      }

      setIsProcessing(true);

      await invoke("manual_stop_continuous");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(`Failed to manually stop: ${errorMessage}`);
      setIsProcessing(false);
      console.error("Manual stop error:", err);
    }
  }, [isContinuousMode]);

  const handleSetup = useCallback(async () => {
    try {
      if (isMacOS() || isWindows()) {
        await invoke("request_system_audio_access");
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await startCapture();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps below.");
      setSetupRequired(true);
    }
  }, [startCapture]);

  useEffect(() => {
    const shouldOpenPopover =
      capturing ||
      setupRequired ||
      isAIProcessing ||
      !!lastAIResponse ||
      isSummarizing ||
      !!sessionSummary ||
      !!error;
    setIsPopoverOpen(shouldOpenPopover);
    resizeWindow(shouldOpenPopover);
  }, [
    capturing,
    setupRequired,
    isAIProcessing,
    lastAIResponse,
    isSummarizing,
    sessionSummary,
    error,
    resizeWindow,
  ]);

  useEffect(() => {
    return globalShortcuts.registerSystemAudioCallback(async () => {
      if (capturingRef.current) {
        await stopCapture();
      } else {
        await startCapture();
      }
    });
  }, [startCapture, stopCapture]);

  useEffect(() => {
    return () => {
      activeAiBatcherRef.current?.cancel();
      activeAiBatcherRef.current = null;
      activeSummaryBatcherRef.current?.cancel();
      activeSummaryBatcherRef.current = null;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      summaryAbortRef.current?.abort();
      invoke("stop_system_audio_capture").catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    if (
      !conversation.id ||
      conversation.updatedAt === 0 ||
      conversation.messages.length === 0
    ) {
      return;
    }

    saveTimeoutRef.current = setTimeout(async () => {
      if (isSavingRef.current) {
        return;
      }

      try {
        isSavingRef.current = true;
        await saveConversation(conversation);
      } catch (error) {
        console.error("Failed to save system audio conversation:", error);
      } finally {
        isSavingRef.current = false;
      }
    }, CONVERSATION_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    conversation.messages.length,
    conversation.title,
    conversation.id,
    conversation.updatedAt,
  ]);

  const startNewConversation = useCallback(() => {
    setConversation({
      id: generateConversationId("sysaudio"),
      title: "",
      messages: [],
      createdAt: 0,
      updatedAt: 0,
    });
    setLastTranscription("");
    setLastAIResponse("");
    setError("");
    setSetupRequired(false);
    setIsProcessing(false);
    setIsAIProcessing(false);
    setIsPopoverOpen(false);
    resetUseSystemPrompt();
  }, [resetUseSystemPrompt]);

  // Apply a mode change (VAD <-> manual) to the RUNNING session. The Rust
  // capture task snapshots its config at start, so without a restart the
  // toggle only changed a setting: switching to manual left the VAD session
  // listening, and switching to VAD left the session armed-but-idle while
  // the UI claimed to be listening.
  const prevVadEnabledRef = useRef(vadConfig.enabled);
  useEffect(() => {
    const modeChanged = prevVadEnabledRef.current !== vadConfig.enabled;
    prevVadEnabledRef.current = vadConfig.enabled;

    if (!capturing) {
      return;
    }

    setIsContinuousMode(!vadConfig.enabled);
    if (!vadConfig.enabled) {
      setIsRecordingInContinuousMode(false);
    }

    if (!modeChanged) {
      return;
    }

    (async () => {
      try {
        // Stop whatever session is running (no-op if manual mode was armed
        // with no active task).
        await invoke("stop_system_audio_capture");

        if (vadConfig.enabled) {
          // Switching to VAD: start listening immediately.
          const deviceId =
            selectedAudioDevices.output.id !== "default"
              ? selectedAudioDevices.output.id
              : null;
          const providerConfig = allSttProvidersRef.current.find(
            (p) => p.id === selectedSttProviderRef.current.provider,
          );
          await invoke<string>("start_system_audio_capture", {
            vadConfig: vadConfig,
            deviceId: deviceId,
            streaming: providerConfig?.streaming === true,
          });
        }
        // Switching to manual: stay armed; the Record button starts a take.
      } catch (err) {
        console.error("Failed to apply capture mode change:", err);
        setError(`Failed to switch capture mode: ${err}`);
      }
    })();
  }, [vadConfig, capturing, selectedAudioDevices.output.id]);

  // ---- Cross-window live session mirror (sub-project ④) ----
  // The dashboard renders this snapshot and drives the engine via commands;
  // it never derives state on its own (mirror-only discipline).
  const liveSnapshot = useMemo<LiveSessionSnapshot>(
    () => ({
      capturing,
      isContinuousMode,
      isRecordingInContinuousMode,
      isProcessing,
      isAIProcessing,
      error,
      setupRequired,
      isSttInitializing,
      lastAIResponse,
      conversation:
        conversation.messages.length > LIVE_SNAPSHOT_MAX_MESSAGES
          ? {
              ...conversation,
              messages: conversation.messages.slice(
                0,
                LIVE_SNAPSHOT_MAX_MESSAGES,
              ),
            }
          : conversation,
      sessionStartedAt,
      currentSpeaker,
      isLabelingSpeakers,
      sessionSummary,
      isSummarizing,
      audioLevel,
      noAudioDetected,
    }),
    [
      capturing,
      isContinuousMode,
      isRecordingInContinuousMode,
      isProcessing,
      isAIProcessing,
      error,
      setupRequired,
      isSttInitializing,
      lastAIResponse,
      conversation,
      sessionStartedAt,
      currentSpeaker,
      isLabelingSpeakers,
      sessionSummary,
      isSummarizing,
      audioLevel,
      noAudioDetected,
    ],
  );
  useLiveStatePublisher(liveSnapshot);

  // Dashboard commands dispatch to the engine's own functions through a
  // per-render ref (same stale-closure guard as processWithAIRef), so the
  // once-registered listener always calls the freshest closures.
  // Typed prompts from the dashboard's embedded bar join the SESSION
  // conversation (not useCompletion's separate popover state), so the answer
  // streams back into the snapshot and renders in the dashboard feed. Mirrors
  // the batch speech-detected path, minus the question gate — a typed question
  // is always answered.
  const submitTypedPromptRef = useRef<(text: string) => void>(() => {});
  submitTypedPromptRef.current = (text: string) => {
    const messageId = appendUtteranceMessage(text);
    lastUtteranceRef.current = { text, messageId };
    const effectiveSystemPrompt = getEffectiveSystemPrompt();
    const previousMessages = buildAIHistory(
      conversationMessagesRef.current,
      messageId,
    );
    void processWithAIRef.current(
      text,
      effectiveSystemPrompt,
      previousMessages,
      messageId,
    );
  };

  const liveCommandHandlersRef = useRef<
    Record<Exclude<LiveSessionCommandAction, "submit">, () => void>
  >({} as Record<Exclude<LiveSessionCommandAction, "submit">, () => void>);
  liveCommandHandlersRef.current = {
    "start-capture": () => void startCapture(),
    "stop-capture": () => void stopCapture(),
    "start-recording": () => void startContinuousRecording(),
    "stop-and-send": () => void manualStopAndSend(),
    "ignore-recording": () => void ignoreContinuousRecording(),
    "answer-last": () => void answerLastUtterance(),
    "new-conversation": () => startNewConversation(),
    "dismiss-summary": () => dismissSummary(),
    // Dashboard bar's "grant permission" action → same permission-request +
    // retry-capture path the overlay uses, keeping that logic in the engine.
    setup: () => void handleSetup(),
  };
  useEffect(() => {
    const scope = createAsyncListenerScope();
    void scope
      .add(
        listen<LiveSessionCommand>(
          LIVE_SESSION_COMMAND,
          scope.guard((event) => {
            const payload = event.payload;
            if (!payload?.action) return;
            if (payload.action === "submit") {
              const text = payload.text?.trim();
              if (text) {
                submitTypedPromptRef.current(text);
              }
              return;
            }
            const handler = liveCommandHandlersRef.current[payload.action];
            if (handler) {
              handler();
            }
          }),
        ),
      )
      .catch((error) => {
        console.error("Failed to listen for live session commands:", error);
      });
    return () => {
      scope.dispose();
    };
  }, []);

  const { scrollAreaRef } = useCaptureKeyboardShortcuts({
    isPopoverOpen,
    isContinuousMode,
    isRecordingInContinuousMode,
    isProcessing,
    isAIProcessing,
    startContinuousRecording,
    manualStopAndSend,
    ignoreContinuousRecording,
  });

  return {
    capturing,
    isProcessing,
    isAIProcessing,
    lastTranscription,
    lastAIResponse,
    error,
    setupRequired,
    isSttInitializing,
    startCapture,
    stopCapture,
    handleSetup,
    isPopoverOpen,
    setIsPopoverOpen,
    conversation,
    setConversation,
    processWithAI,
    answerLastUtterance,
    useSystemPrompt,
    setUseSystemPrompt,
    contextContent,
    setContextContent,
    startNewConversation,
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
    isContinuousMode,
    isRecordingInContinuousMode,
    recordingProgress,
    sessionStartedAt,
    audioLevel,
    captureSampleRate,
    noAudioDetected,
    sessionSummary,
    isSummarizing,
    dismissSummary,
    manualStopAndSend,
    startContinuousRecording,
    ignoreContinuousRecording,
    scrollAreaRef,
    speakerSegments,
    isLabelingSpeakers,
    currentSpeaker,
  };
}
