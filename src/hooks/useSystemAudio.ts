import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useWindowResize, useGlobalShortcuts } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useApp } from "@/contexts";
import { STORAGE_KEYS } from "@/config/constants";
import { safeLocalStorage } from "@/lib/storage";
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
  applyPartial,
  clearThroughTurn,
  LiveTextPartial,
  LiveTextState,
} from "@/lib/live-text";
import {
  applySpeakerEvent,
  clearProvisionalThroughTurn,
  emptyLiveSpeakerState,
  LiveSpeakerState,
  registerTurnMessage,
  SpeakerEvent,
} from "@/lib/live-speakers";
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
import {
  reconnectCapture,
  requiresSessionBoundaryOnDeviceChange,
} from "./system-audio/reconnectCapture";
import { createAsyncListenerScope } from "@/lib/async-listener-scope";
import {
  RecentSpeechEventFingerprints,
  type SpeechEventPayload,
} from "@/lib/speech-event-dedupe";
import {
  createCaptureSessionWork,
  isStartCancelled,
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
  // Provisional text for the turn in progress; display only. The batch
  // transcription of the finished turn replaces it.
  const [partialTranscription, setPartialTranscription] = useState("");
  const liveTextRef = useRef<LiveTextState>(null);
  const setLiveText = useCallback((next: LiveTextState) => {
    liveTextRef.current = next;
    setPartialTranscription(next?.text ?? "");
  }, []);
  // Turn → speaker bookkeeping for the capture; `partialSpeaker` is who is
  // speaking in the turn in progress.
  // Set when a live feature stops mid-capture; the capture itself carries on.
  const [liveNotice, setLiveNotice] = useState("");
  const [partialSpeaker, setPartialSpeaker] = useState<string | null>(null);
  const liveSpeakersRef = useRef<LiveSpeakerState>(emptyLiveSpeakerState);
  const setLiveSpeakers = useCallback((next: LiveSpeakerState) => {
    liveSpeakersRef.current = next;
    setPartialSpeaker(next.provisional?.speaker ?? null);
  }, []);
  const [lastAIResponse, setLastAIResponse] = useState<string>("");
  const [error, setError] = useState<string>("");
  // Whatever the bar tells the user also lands in aileron.log, so a session
  // that went wrong can be read back afterwards.
  useEffect(() => {
    if (error) void invoke("log_ui_message", { message: error }).catch(() => {});
  }, [error]);
  useEffect(() => {
    if (liveNotice) {
      void invoke("log_ui_message", { message: liveNotice }).catch(() => {});
    }
  }, [liveNotice]);
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

  // Speaker shown beside the last settled line; set by the live label path.
  const [currentSpeaker, setCurrentSpeaker] = useState<string | null>(null);

  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    selectedAudioDevices,
    setSelectedAudioDevices,
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
    progress: sttModelProgress,
    initStage: sttInitStage,
    init: initStt,
    initLiveText,
    initLiveSpeakers,
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
  const pendingSaveConversationRef = useRef<ChatConversation | null>(null);
  const inFlightSaveRef = useRef<Promise<unknown> | null>(null);
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
          scope.guard(() => {
            setLiveText(null);
            setLiveSpeakers(
              clearProvisionalThroughTurn(liveSpeakersRef.current, null),
            );
          }),
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
          "live-feature-stopped",
          scope.guard((event) => {
            if (!capturingRef.current) return;
            setLiveNotice(
              event.payload === "speakers"
                ? "Speaker labels stopped for this session. Transcription continues."
                : "Live text stopped for this session. Final transcripts continue.",
            );
            if (event.payload === "speakers") {
              setLiveSpeakers(
                clearProvisionalThroughTurn(liveSpeakersRef.current, null),
              );
            } else {
              setLiveText(null);
            }
          }),
        ),
      ),
      scope.add(
        listen(
          "audio-output-device-missing",
          scope.guard(() => {
            // The capture already follows the system default. Record that,
            // without the restart a device change otherwise triggers.
            prevOutputDeviceRef.current = "";
            setSelectedAudioDevices((prev) => {
              const next = { ...prev, output: { id: "", name: "" } };
              safeLocalStorage.setItem(
                STORAGE_KEYS.SELECTED_AUDIO_DEVICES,
                JSON.stringify(next),
              );
              return next;
            });
          }),
        ),
      ),
      scope.add(
        listen(
          "capture-skipped-audio",
          scope.guard((event) => {
            if (!capturingRef.current) return;
            const seconds = Number(event.payload);
            const notice = `Aileron fell behind and skipped ${
              Number.isFinite(seconds) ? seconds.toFixed(1) : "some"
            }s of audio to stay live. Listening continues.`;
            setLiveNotice(notice);
            // Capture has recovered by now; clear it unless replaced.
            setTimeout(
              () => setLiveNotice((current) => (current === notice ? "" : current)),
              15_000,
            );
          }),
        ),
      ),
      scope.add(
        listen(
          "speech-speaker",
          scope.guard((event) => {
            // Allowed while stopping: the last turn's label is emitted as
            // the worker drains.
            if (!capturingRef.current && !captureStoppingRef.current) return;
            const { state, label } = applySpeakerEvent(
              liveSpeakersRef.current,
              event.payload as SpeakerEvent,
            );
            setLiveSpeakers(state);
            if (label) {
              // `updatedAt` moves so the autosave picks the label up: it does
              // not watch individual message fields.
              setConversation((prev) => ({
                ...prev,
                updatedAt: Date.now(),
                messages: prev.messages.map((message) =>
                  message.id === label.messageId
                    ? { ...message, speaker: label.speaker }
                    : message,
                ),
              }));
              setCurrentSpeaker(label.speaker);
            }
          }),
        ),
      ),
      scope.add(
        listen(
          "speech-partial",
          scope.guard((event) => {
            if (!capturingRef.current) return;
            setLiveText(
              applyPartial(
                liveTextRef.current,
                event.payload as LiveTextPartial,
              ),
            );
          }),
        ),
      ),
      scope.add(
        listen(
          "speech-detected",
          scope.guard(async (event) => {
            const generation = captureGenerationRef.current;
            // Set once this handler owns the turn, so its provisional text is
            // cleared however the handler exits (final landed, backchannel,
            // empty, error).
            let settledTurn: number | null | undefined;
            let ownsTurn = false;
            try {
              if (!capturingRef.current) return;
              if (!captureSessionWorkRef.current.isCurrent(generation)) {
                return;
              }

              const payload = event.payload as SpeechEventPayload;
              const base64Audio = payload.audio;
              const utteranceId = payload.utterance_id ?? undefined;
              // A cached utterance arrives as an id alone (its WAV is fetched
              // only if a remote provider needs it).
              if (!utteranceId && (!base64Audio || base64Audio.length < 100)) {
                return;
              }
              if (!recentSpeechEventsRef.current.claim(payload)) {
                return;
              }
              ownsTurn = true;
              settledTurn = payload.turn;

              // Deferred: the local provider transcribes by handle (below) and
              // never needs the decoded WAV, and this loop runs over every byte
              // of the utterance on the UI thread.
              const audioBlob = async () => {
                const wav =
                  base64Audio ??
                  (await invoke<string>("stt_utterance_wav", { utteranceId }));
                const binaryString = atob(wav);
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
                    utteranceId,
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
                  if (payload.turn !== undefined) {
                    // The label for this turn may already have arrived; if
                    // not, the speech-speaker listener patches the message.
                    const registered = registerTurnMessage(
                      liveSpeakersRef.current,
                      payload.turn,
                      messageId,
                    );
                    setLiveSpeakers(registered.state);
                    const speaker = registered.speaker;
                    if (speaker) {
                      setConversation((prev) => ({
                        ...prev,
                        messages: prev.messages.map((message) =>
                          message.id === messageId
                            ? { ...message, speaker }
                            : message,
                        ),
                      }));
                      setCurrentSpeaker(speaker);
                    }
                  }
                  lastUtteranceRef.current = {
                    text: transcription,
                    messageId,
                  };

                  if (
                    isLikelyQuestion(transcription) &&
                    !captureStoppingRef.current &&
                    // A transcription that lands after stop joins the
                    // transcript but does not start a new answer.
                    capturingRef.current
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
            } catch {
              if (captureSessionWorkRef.current.isCurrent(generation)) {
                setError("Failed to process speech");
              }
            } finally {
              if (ownsTurn) {
                setLiveText(clearThroughTurn(liveTextRef.current, settledTurn));
                setLiveSpeakers(
                  clearProvisionalThroughTurn(
                    liveSpeakersRef.current,
                    settledTurn,
                  ),
                );
              }
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

    const updatedMessages = [...conversation.messages];

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
        selectedAudioDevices.output.id === "default"
          ? null
          : selectedAudioDevices.output.id;

      // The record button always means a manual take, regardless of which
      // mode the current session was started in.
      await invoke<string>("start_system_audio_capture", {
        vadConfig: { ...vadConfig, enabled: false },
        deviceId: deviceId,
      });
      setIsContinuousMode(true);
    } catch (err) {
      if (isStartCancelled(err)) return;
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

      // `discard: true` is what separates this from stop-and-send: without it
      // the capture task still emits the take, and the transcript gets the
      // utterance the user just threw away.
      await invoke<string>("stop_system_audio_capture", { discard: true });

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
        }
      } catch {
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
  // transcript + speaker-label work — most of a meeting's value lands after it
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
  // otherwise keep capturing silence. FluidAudio ends the session at that
  // boundary; other providers reconnect in place.
  // Registered once; reads everything through refs.
  useEffect(() => {
    const scope = createAsyncListenerScope();
    void scope
      .add(
        listen(
          "audio-device-changed",
          scope.guard(async () => {
            try {
              if (
                requiresSessionBoundaryOnDeviceChange(
                  selectedSttProviderRef.current.provider,
                )
              ) {
                setError("Audio device changed — finishing this session…");
                await stopCaptureRef.current();
                setError(
                  "Audio device changed, so capture stopped to preserve speaker timing. Start again on the new device.",
                );
                return;
              }
              const outcome = await reconnectCapture({
                isCapturing: () => capturingRef.current,
                isStopping: () => captureStoppingRef.current,
                setStopping: (value) => {
                  captureStoppingRef.current = value;
                },
                stop: async () => {
                  setError("Audio device changed — reconnecting…");
                  await invoke("stop_system_audio_capture");
                },
                start: async () => {
                  await invoke<string>("start_system_audio_capture", {
                    vadConfig: vadConfigRef.current,
                    deviceId: null,
                  });
                },
              });
              if (outcome === "reconnected") {
                setError("");
              }
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
        // Ask the backend now rather than trusting the hook's last reading:
        // only a status that actually says "unsupported" may change the
        // user's provider. A failed check is reported and changes nothing.
        let status: {
          asr_ready: boolean;
          model_version: "v3" | null;
          live_text_ready?: boolean;
          is_supported: boolean;
        };
        try {
          status = await invoke("stt_get_status");
        } catch (err) {
          setError(
            `Couldn't check the local speech engine (${err}). Your provider is unchanged — try starting again.`,
          );
          setIsPopoverOpen(true);
          return;
        }
        if (!status.is_supported) {
          onSetSelectedSttProvider({ provider: "groq", variables: {} });
          setError(
            "Local STT requires macOS Apple Silicon — switched to cloud STT",
          );
          return;
        }

        const requestedModel = normalizeFluidAudioModel(
          selectedSttProvider.variables.MODEL,
        );

        if (!status.asr_ready || status.model_version !== requestedModel) {
          await initStt(requestedModel);
        }
        // Optional: a failed live-text load leaves capture working without it.
        if (vadConfig.enabled && vadConfig.live_text && !status.live_text_ready) {
          await initLiveText();
        }

        const statusAfter = await invoke<{
          asr_ready: boolean;
          model_version: "v3" | null;
          vad_ready: boolean;
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
      }

      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        setSetupRequired(true);
        setIsPopoverOpen(true);
        return;
      }

      // Speaker labels do not depend on which model transcribes, so this runs
      // for every provider. Optional: a failed load leaves capture working
      // without labels.
      if (vadConfig.enabled && vadConfig.live_speakers) {
        try {
          const speakerStatus = await invoke<{
            live_speakers_ready?: boolean;
            is_supported: boolean;
          }>("stt_get_status");
          if (speakerStatus.is_supported && !speakerStatus.live_speakers_ready) {
            await initLiveSpeakers();
          }
        } catch (err) {
          console.warn("Speaker labels are unavailable:", err);
        }
      }

      const isContinuous = !vadConfig.enabled;
      const deviceId =
        selectedAudioDevices.output.id === "default"
          ? null
          : selectedAudioDevices.output.id;

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
            setLiveText(null);
            setLiveSpeakers(emptyLiveSpeakerState);
            setLiveNotice("");
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
      // A stop that arrived while the start was still setting up is the
      // user's own cancel, not a failure.
      if (!isStartCancelled(err)) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(errorMessage);
        setIsPopoverOpen(true);
      }
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
    initLiveText,
    initLiveSpeakers,
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

      await invoke("stop_system_audio_capture");

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const drained = await captureSessionWorkRef.current.drain(
        generation,
        10_000,
      );
      if (drained) {
        captureSessionWorkRef.current.invalidate(generation);
      } else {
        // A transcription is still running; each is allowed 30 s. Finish
        // stopping now, but keep its session current until it lands so the
        // last words spoken are not thrown away.
        void captureSessionWorkRef.current.invalidateWhenSettled(
          generation,
          30_000,
        );
      }
      capturingRef.current = false;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // Summarize the just-ended session (fire-and-forget). Kept out of the
      // reset below so the summary survives and shows in the popover.
      generateSummaryRef.current();

      setCapturing(false);
      setLiveText(null);
      // Keep the turn bookkeeping: a label for the last turn can still land.
      setLiveSpeakers(
        clearProvisionalThroughTurn(liveSpeakersRef.current, null),
      );
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
    } catch {
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

  // Save a snapshot outside the debounce, after any save already in flight so
  // an older snapshot of the same conversation cannot land on top of it.
  const saveSnapshotNow = useCallback(async (snapshot: ChatConversation) => {
    if (inFlightSaveRef.current) {
      try {
        await inFlightSaveRef.current;
      } catch (error) {
        console.debug("Concurrent conversation save failed:", error);
      }
    }
    try {
      await saveConversation(snapshot);
    } catch (error) {
      console.error("Failed to save system audio conversation:", error);
    }
  }, []);

  useEffect(() => {
    return () => {
      const snapshot = pendingSaveConversationRef.current;
      pendingSaveConversationRef.current = null;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (snapshot) void saveSnapshotNow(snapshot);
    };
  }, [saveSnapshotNow]);

  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // The conversation was replaced inside the debounce window (new session):
    // its cancelled save would otherwise be overwritten by the next
    // conversation's snapshot, or sit here until unmount. Write it now.
    const superseded = pendingSaveConversationRef.current;
    if (superseded && superseded.id !== conversation.id) {
      pendingSaveConversationRef.current = null;
      void saveSnapshotNow(superseded);
    }

    if (
      !conversation.id ||
      conversation.updatedAt === 0 ||
      conversation.messages.length === 0
    ) {
      return;
    }

    pendingSaveConversationRef.current = conversation;

    const runSave = async () => {
      if (isSavingRef.current) {
        saveTimeoutRef.current = setTimeout(
          runSave,
          CONVERSATION_SAVE_DEBOUNCE_MS,
        );
        return;
      }
      const snapshot = pendingSaveConversationRef.current;
      pendingSaveConversationRef.current = null;
      saveTimeoutRef.current = null;
      if (!snapshot) return;
      isSavingRef.current = true;
      try {
        const save = saveConversation(snapshot);
        inFlightSaveRef.current = save;
        await save;
      } catch (error) {
        console.error("Failed to save system audio conversation:", error);
      } finally {
        isSavingRef.current = false;
        inFlightSaveRef.current = null;
      }
    };

    saveTimeoutRef.current = setTimeout(runSave, CONVERSATION_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
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
  //
  // The same goes for the output device: the running tap is bound to the
  // device it started on, so picking another one in settings has to restart
  // a listening session. (An armed manual session has no task to restart;
  // its next take starts on the newly selected device.)
  const prevVadEnabledRef = useRef(vadConfig.enabled);
  const prevOutputDeviceRef = useRef(selectedAudioDevices.output.id);
  useEffect(() => {
    const modeChanged = prevVadEnabledRef.current !== vadConfig.enabled;
    prevVadEnabledRef.current = vadConfig.enabled;
    const deviceChanged =
      prevOutputDeviceRef.current !== selectedAudioDevices.output.id;
    prevOutputDeviceRef.current = selectedAudioDevices.output.id;

    if (!capturing) {
      return;
    }

    setIsContinuousMode(!vadConfig.enabled);
    if (!vadConfig.enabled) {
      setIsRecordingInContinuousMode(false);
    }

    if (!modeChanged && !(deviceChanged && vadConfig.enabled)) {
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
            selectedAudioDevices.output.id === "default"
              ? null
              : selectedAudioDevices.output.id;
          await invoke<string>("start_system_audio_capture", {
            vadConfig: vadConfig,
            deviceId: deviceId,
          });
        }
        // Switching to manual: stay armed; the Record button starts a take.
      } catch (err) {
        if (isStartCancelled(err)) return;
        console.error("Failed to restart capture after a settings change:", err);
        setError(
          modeChanged
            ? `Failed to switch capture mode: ${err}`
            : `Failed to switch audio device: ${err}`,
        );
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
      partialTranscription,
      partialSpeaker,
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
      partialTranscription,
      partialSpeaker,
      conversation,
      sessionStartedAt,
      currentSpeaker,
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
    sttModelProgress,
    sttInitStage,
    liveNotice,
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
    currentSpeaker,
    partialTranscription,
    partialSpeaker,
  };
}
