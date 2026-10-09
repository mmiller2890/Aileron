import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import {
  LIVE_CHAT_COMMAND,
  LIVE_CHAT_STATE,
  LIVE_SESSION_COMMAND,
  LIVE_SESSION_REQUEST,
  LIVE_SESSION_STATE,
  LiveChatCommand,
  LiveChatSnapshot,
  LiveSessionCommand,
  LiveSessionSnapshot,
} from "@/lib/live-session";

/**
 * Dashboard-side mirror of the overlay engine. Renders ONLY what the snapshot
 * says (mirror-only discipline): buttons emit commands and the UI updates when
 * the authoritative state arrives back. `null` snapshot = no live data yet;
 * consumers fall back to their idle (DB) behavior. `chat` mirrors the bar's
 * own conversation (typed questions and voice input) the same way.
 */
export function useLiveSession() {
  const [snapshot, setSnapshot] = useState<LiveSessionSnapshot | null>(null);
  const [chat, setChat] = useState<LiveChatSnapshot | null>(null);

  useEffect(() => {
    const unlisten = listen<LiveSessionSnapshot>(LIVE_SESSION_STATE, (event) => {
      if (event.payload && typeof event.payload.capturing === "boolean") {
        setSnapshot(event.payload);
      }
    });
    const unlistenChat = listen<LiveChatSnapshot>(LIVE_CHAT_STATE, (event) => {
      if (event.payload && typeof event.payload.answering === "boolean") {
        setChat(event.payload);
      }
    });
    emit(LIVE_SESSION_REQUEST, {}).catch(() => {
      // Overlay webview not ready yet; the next state change will arrive.
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenChat.then((fn) => fn());
    };
  }, []);

  const sendCommand = useCallback((command: LiveSessionCommand) => {
    emit(LIVE_SESSION_COMMAND, command).catch((e) =>
      console.error("Failed to send live-session command:", e)
    );
  }, []);

  const sendChatCommand = useCallback((command: LiveChatCommand) => {
    emit(LIVE_CHAT_COMMAND, command).catch((e) =>
      console.error("Failed to send live-chat command:", e)
    );
  }, []);

  return { snapshot, sendCommand, chat, sendChatCommand };
}
