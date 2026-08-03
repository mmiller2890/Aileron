import { useState, useCallback, useRef, useEffect } from "react";
import { useApp } from "@/contexts";
import { MAX_FILES } from "@/config";
import {
  fetchAIResponse,
  saveConversation,
  getConversationById,
  generateConversationTitle,
  MESSAGE_ID_OFFSET,
  generateMessageId,
  generateRequestId,
  getResponseSettings,
  isMacOS,
  createTokenBatcher,
  buildAIHistory,
} from "@/lib";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createAsyncListenerScope } from "@/lib/async-listener-scope";
import {
  appendWithinLimit,
  collectImagesBase64,
  selectImageFilesWithinLimit,
} from "@/lib/attachments";

// Types for completion
interface AttachedFile {
  id: string;
  name: string;
  type: string;
  base64: string;
  size: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatCompletionState {
  input: string;
  isLoading: boolean;
  error: string | null;
  attachedFiles: AttachedFile[];
}

export const useChatCompletion = (
  conversationId: string,
  messages: ChatConversation | null,
  setMessages: (messages: ChatConversation | null) => void
) => {
  const {
    selectedAIProvider,
    allAiProviders,
    systemPrompt,
    screenshotConfiguration,
    setScreenshotConfiguration,
    selectedSttProvider,
    allSttProviders,
    selectedAudioDevices,
    hasActiveLicense,
  } = useApp();

  const [state, setState] = useState<ChatCompletionState>({
    input: "",
    isLoading: false,
    error: null,
    attachedFiles: [],
  });

  const [micOpen, setMicOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isFilesPopoverOpen, setIsFilesPopoverOpen] = useState(false);
  const [isScreenshotLoading, setIsScreenshotLoading] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeBatcherRef = useRef<ReturnType<typeof createTokenBatcher> | null>(
    null
  );
  const currentRequestIdRef = useRef<string | null>(null);
  const isProcessingScreenshotRef = useRef(false);
  const screenshotConfigRef = useRef(screenshotConfiguration);
  const hasCheckedPermissionRef = useRef(false);
  const screenshotInitiatedByThisContext = useRef(false);

  useEffect(() => {
    screenshotConfigRef.current = screenshotConfiguration;
  }, [screenshotConfiguration]);

  const scrollToBottom = () => {
    const responseSettings = getResponseSettings();
    if (responseSettings.autoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  };

  const setInput = useCallback((value: string) => {
    setState((prev) => ({ ...prev, input: value }));
  }, []);

  const addFile = useCallback(async (file: File) => {
    try {
      const base64 = await fileToBase64(file);
      const attachedFile: AttachedFile = {
        id: Date.now().toString(),
        name: file.name,
        type: file.type,
        base64,
        size: file.size,
      };

      setState((prev) => ({
        ...prev,
        attachedFiles: appendWithinLimit(prev.attachedFiles, [attachedFile]),
      }));
    } catch (error) {
      console.error("Failed to process file:", error);
    }
  }, []);

  const removeFile = useCallback((fileId: string) => {
    setState((prev) => ({
      ...prev,
      attachedFiles: prev.attachedFiles.filter((f) => f.id !== fileId),
    }));
  }, []);

  const clearFiles = useCallback(() => {
    setState((prev) => ({ ...prev, attachedFiles: [] }));
  }, []);

  const submit = useCallback(
    async (speechText?: string, extraImagesBase64?: string[]) => {
      const input = speechText || state.input;

      if (!input.trim()) {
        return;
      }

      if (speechText) {
        setState((prev) => ({
          ...prev,
          input: speechText,
        }));
      }

      // Generate unique request ID
      const requestId = generateRequestId();
      currentRequestIdRef.current = requestId;

      // Cancel any existing request
      activeBatcherRef.current?.cancel();
      activeBatcherRef.current = null;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;

      try {
        // Prepare message history for the AI
        const messageHistory = buildAIHistory(messages?.messages || []);

        // Handle image attachments. `extraImagesBase64` carries images handed
        // over explicitly (the screenshot auto-submit path): the closure's
        // `state.attachedFiles` predates the setState that added the
        // screenshot, so relying on state alone silently dropped it.
        const imagesBase64 = collectImagesBase64(
          state.attachedFiles,
          extraImagesBase64
        );

        // Check if AI provider is configured
        if (!selectedAIProvider.provider) {
          setState((prev) => ({
            ...prev,
            error: "Please select an AI provider in settings",
          }));
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider) {
          setState((prev) => ({
            ...prev,
            error: "Invalid provider selected",
          }));
          return;
        }

        // Add user message to UI immediately
        const timestamp = Date.now();
        const userMsg: ChatMessage = {
          id: generateMessageId("user", timestamp),
          role: "user",
          content: input,
          timestamp,
        };

        const updatedMessages = {
          ...messages!,
          messages: [...(messages?.messages || []), userMsg],
        };
        setMessages(updatedMessages);

        // Clear input and set loading state
        setState((prev) => ({
          ...prev,
          input: "",
          isLoading: true,
          error: null,
          attachedFiles: [],
        }));

        // Scroll to bottom after adding user message
        setTimeout(scrollToBottom, 100);

        let fullResponse = "";

        try {
          const assistantMsg: ChatMessage = {
            id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
            role: "assistant",
            content: "",
            timestamp: timestamp + MESSAGE_ID_OFFSET,
          };

          // Rendering re-parses the whole markdown string, so batch tokens
          // instead of re-rendering the message per token.
          const isCurrent = () =>
            currentRequestIdRef.current === requestId && !signal.aborted;
          const batcher = createTokenBatcher(
            () => {
              assistantMsg.content = fullResponse;

              const baseMsgs = updatedMessages.messages;
              const last = baseMsgs[baseMsgs.length - 1];
              if (last && last.role === "assistant") {
                setMessages({
                  ...updatedMessages,
                  messages: [
                    ...baseMsgs.slice(0, -1),
                    { ...assistantMsg },
                  ],
                });
              } else {
                setMessages({
                  ...updatedMessages,
                  messages: [...baseMsgs, { ...assistantMsg }],
                });
              }

              scrollToBottom();
            },
            undefined,
            isCurrent
          );
          activeBatcherRef.current = batcher;

          try {
            for await (const chunk of fetchAIResponse({
              provider,
              selectedProvider: selectedAIProvider,
              systemPrompt: systemPrompt || undefined,
              history: messageHistory,
              userMessage: input,
              imagesBase64,
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
          } catch (streamError) {
            batcher.cancel();
            throw streamError;
          } finally {
            if (activeBatcherRef.current === batcher) {
              activeBatcherRef.current = null;
            }
          }
        } catch (e: any) {
          // Only show error if this is still the current request and not aborted
          if (currentRequestIdRef.current === requestId && !signal.aborted) {
            setState((prev) => ({
              ...prev,
              isLoading: false,
              error: e.message || "An error occurred",
            }));
          }
          return;
        }

        // Only proceed if this is still the current request
        if (currentRequestIdRef.current !== requestId || signal.aborted) {
          return;
        }

        setState((prev) => ({ ...prev, isLoading: false }));

        // Focus input after AI response is complete
        setTimeout(() => {
          inputRef.current?.focus();
        }, 100);

        // Save the conversation after successful completion
        if (fullResponse) {
          const assistantMsg: ChatMessage = {
            id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
            role: "assistant",
            content: fullResponse,
            timestamp: timestamp + MESSAGE_ID_OFFSET,
          };

          const newMessages = [
            ...(messages?.messages || []),
            userMsg,
            assistantMsg,
          ];

          // Get existing conversation if updating
          let existingConversation = null;
          if (conversationId) {
            try {
              existingConversation = await getConversationById(conversationId);
            } catch (error) {
              console.error("Failed to get existing conversation:", error);
            }
          }

          const title =
            existingConversation?.title ||
            messages?.title ||
            generateConversationTitle(input);

          const conversation: ChatConversation = {
            id: conversationId,
            title,
            messages: newMessages,
            createdAt:
              existingConversation?.createdAt ||
              messages?.createdAt ||
              timestamp,
            updatedAt: timestamp,
          };

          try {
            await saveConversation(conversation);

            // Reload conversation from database to ensure consistency
            const updatedConversation = await getConversationById(
              conversationId
            );
            if (updatedConversation) {
              setMessages(updatedConversation);
            }
          } catch (error) {
            console.error("Failed to save conversation:", error);
            setState((prev) => ({
              ...prev,
              error: "Failed to save conversation. Please try again.",
            }));
          }
        }
      } catch (error) {
        // Only show error if not aborted
        if (!signal?.aborted && currentRequestIdRef.current === requestId) {
          setState((prev) => ({
            ...prev,
            error: error instanceof Error ? error.message : "An error occurred",
            isLoading: false,
          }));
        }
      }
    },
    [
      state.input,
      state.attachedFiles,
      selectedAIProvider,
      allAiProviders,
      systemPrompt,
      messages,
      conversationId,
      setMessages,
    ]
  );

  const cancel = useCallback(() => {
    activeBatcherRef.current?.cancel();
    activeBatcherRef.current = null;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    currentRequestIdRef.current = null;
    setState((prev) => ({ ...prev, isLoading: false }));
  }, []);

  // Helper function to convert file to base64
  const fileToBase64 = useCallback(async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64 = (reader.result as string)?.split(",")[1] || "";
        resolve(base64);
      };
      reader.onerror = reject;
    });
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const selectedFiles = selectImageFilesWithinLimit(
      files,
      state.attachedFiles.length
    );
    selectedFiles.forEach((file) => {
      addFile(file);
    });

    // Reset input so same file can be selected again
    e.target.value = "";
  };

  const handleScreenshotSubmit = useCallback(
    async (base64: string, prompt?: string) => {
      if (state.attachedFiles.length >= MAX_FILES) {
        setState((prev) => ({
          ...prev,
          error: `You can only upload ${MAX_FILES} files`,
        }));
        return;
      }

      try {
        if (prompt) {
          // Auto mode: submit the screenshot with the prompt, passing the
          // image explicitly so the request carries it regardless of React
          // state timing (the setTimeout race previously submitted with an
          // empty imagesBase64).
          await submit(prompt, [base64]);
        } else {
          // Manual mode: Add to attached files
          const attachedFile: AttachedFile = {
            id: Date.now().toString(),
            name: `screenshot_${Date.now()}.png`,
            type: "image/png",
            base64: base64,
            size: base64.length,
          };

          setState((prev) => ({
            ...prev,
            attachedFiles: [...prev.attachedFiles, attachedFile],
          }));
        }
      } catch (error) {
        console.error("Failed to process screenshot:", error);
        setState((prev) => ({
          ...prev,
          error:
            error instanceof Error
              ? error.message
              : "An error occurred processing screenshot",
          isLoading: false,
        }));
      }
    },
    [state.attachedFiles.length, submit]
  );

  const onRemoveAllFiles = () => {
    clearFiles();
    setIsFilesPopoverOpen(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!state.isLoading && state.input.trim()) {
        submit();
      }
    }
  };

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      // Check if clipboard contains images
      const items = e.clipboardData?.items;
      if (!items) return;

      const hasImages = Array.from(items).some((item) =>
        item.type.startsWith("image/")
      );

      // If we have images, prevent default text pasting and process images
      if (hasImages) {
        e.preventDefault();

        const clipboardFiles = Array.from(items)
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null);
        const processedFiles = selectImageFilesWithinLimit(
          clipboardFiles,
          state.attachedFiles.length
        );

        // Process all files
        await Promise.all(processedFiles.map((file) => addFile(file)));
      }
    },
    [state.attachedFiles.length, addFile]
  );

  const captureScreenshot = useCallback(async () => {
    if (!handleScreenshotSubmit) return;

    const config = screenshotConfigRef.current;

    // Mark that this context initiated the screenshot
    screenshotInitiatedByThisContext.current = true;

    setIsScreenshotLoading(true);

    try {
      // Check screen recording permission on macOS
      if (isMacOS() && !hasCheckedPermissionRef.current) {
        const {
          checkScreenRecordingPermission,
          requestScreenRecordingPermission,
        } = await import("tauri-plugin-macos-permissions-api");

        const hasPermission = await checkScreenRecordingPermission();

        if (!hasPermission) {
          // Request permission
          await requestScreenRecordingPermission();

          // Wait a moment and check again
          await new Promise((resolve) => setTimeout(resolve, 2000));

          const hasPermissionNow = await checkScreenRecordingPermission();

          if (!hasPermissionNow) {
            setState((prev) => ({
              ...prev,
              error:
                "Screen Recording permission required. Please enable it by going to System Settings > Privacy & Security > Screen & System Audio Recording. If you don't see Aileron in the list, click the '+' button to add it. If it's already listed, make sure it's enabled. Then restart the app.",
            }));
            setIsScreenshotLoading(false);
            screenshotInitiatedByThisContext.current = false;
            return;
          }
        }
        hasCheckedPermissionRef.current = true;
      }

      if (config.enabled) {
        const base64 = await invoke("capture_to_base64");

        if (config.mode === "auto") {
          // Auto mode: Submit directly to AI with the configured prompt
          await handleScreenshotSubmit(base64 as string, config.autoPrompt);
        } else if (config.mode === "manual") {
          // Manual mode: Add to attached files without prompt
          await handleScreenshotSubmit(base64 as string);
        }
        // Reset flag after processing
        screenshotInitiatedByThisContext.current = false;
      } else {
        // Selection Mode: Open overlay to select an area
        // Only allow if user has active license
        if (!hasActiveLicense) {
          setState((prev) => ({
            ...prev,
            error: "Selection mode requires an active license",
          }));
          setIsScreenshotLoading(false);
          screenshotInitiatedByThisContext.current = false;
          return;
        }
        isProcessingScreenshotRef.current = false;
        await invoke("start_screen_capture");
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        error: "Failed to capture screenshot. Please try again.",
      }));
      isProcessingScreenshotRef.current = false;
      screenshotInitiatedByThisContext.current = false;
    } finally {
      if (config.enabled) {
        setIsScreenshotLoading(false);
      }
    }
  }, [handleScreenshotSubmit, hasActiveLicense]);

  useEffect(() => {
    const scope = createAsyncListenerScope();
    void scope
      .add(
        listen<string>(
          "captured-selection",
          scope.guard(async (event) => {
            if (!screenshotInitiatedByThisContext.current) {
              return;
            }

            if (isProcessingScreenshotRef.current) {
              return;
            }

            isProcessingScreenshotRef.current = true;
            const base64 = event.payload;
            const config = screenshotConfigRef.current;

            try {
              if (config.mode === "auto") {
                // Auto mode: Submit directly to AI with the configured prompt
                await handleScreenshotSubmit(base64, config.autoPrompt);
              } else if (config.mode === "manual") {
                // Manual mode: Add to attached files without prompt
                await handleScreenshotSubmit(base64);
              }
            } catch (error) {
              console.error("Error processing selection:", error);
            } finally {
              setIsScreenshotLoading(false);
              screenshotInitiatedByThisContext.current = false;
              setTimeout(() => {
                isProcessingScreenshotRef.current = false;
              }, 100);
            }
          })
        )
      )
      .catch((error) => {
        console.error("Failed to listen for captured selection:", error);
      });

    return () => {
      scope.dispose();
    };
  }, [handleScreenshotSubmit]);

  useEffect(() => {
    const scope = createAsyncListenerScope();
    void scope
      .add(
        listen(
          "capture-closed",
          scope.guard(() => {
            setIsScreenshotLoading(false);
            isProcessingScreenshotRef.current = false;
            screenshotInitiatedByThisContext.current = false;
          })
        )
      )
      .catch((error) => {
        console.error("Failed to listen for capture close:", error);
      });

    return () => {
      scope.dispose();
    };
  }, []);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      activeBatcherRef.current?.cancel();
      activeBatcherRef.current = null;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      currentRequestIdRef.current = null;
    };
  }, []);

  return {
    input: state.input,
    setInput,
    isLoading: state.isLoading,
    error: state.error,
    attachedFiles: state.attachedFiles,
    addFile,
    removeFile,
    clearFiles,
    submit,
    cancel,
    setState,
    isRecording,
    setIsRecording,
    micOpen,
    setMicOpen,
    screenshotConfiguration,
    setScreenshotConfiguration,
    handleScreenshotSubmit,
    handleFileSelect,
    handleKeyPress,
    handlePaste,
    isFilesPopoverOpen,
    setIsFilesPopoverOpen,
    onRemoveAllFiles,
    inputRef,
    captureScreenshot,
    isScreenshotLoading,
    messagesEndRef,
    selectedSttProvider,
    allSttProviders,
    selectedAudioDevices,
    hasActiveLicense,
  };
};
