import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect } from "react";
import { getShortcutsConfig } from "@/lib";
import {
  createOwnedValueRegistry,
  createOwnedValueSlot,
  createSingleFlightInitializer,
} from "@/lib/async-listener-scope";

// Global singleton to prevent multiple event listeners in StrictMode
let globalEventListeners: {
  focus?: UnlistenFn;
  audio?: UnlistenFn;
  screenshot?: UnlistenFn;
  systemAudio?: UnlistenFn;
  customShortcut?: UnlistenFn;
  registrationError?: UnlistenFn;
} = {};

// Global debounce for screenshot events to prevent duplicates
let lastScreenshotEventTime = 0;

const globalInput = createOwnedValueSlot<HTMLInputElement>();
const globalAudioCallback = createOwnedValueSlot<() => void>();
const globalScreenshotCallback =
  createOwnedValueSlot<() => void | Promise<void>>();
const globalSystemAudioCallback = createOwnedValueSlot<() => void>();
const globalCustomShortcutCallbacks = createOwnedValueRegistry<
  string,
  () => void
>();
let setupGlobalEventListeners: (() => Promise<void>) | null = null;
const globalListenerInitializer = createSingleFlightInitializer(async () => {
  await setupGlobalEventListeners?.();
});

export const useGlobalShortcuts = () => {
  const checkShortcutsRegistered = useCallback(async (): Promise<boolean> => {
    try {
      const registered = await invoke<boolean>("check_shortcuts_registered");
      return registered;
    } catch (error) {
      console.error("Failed to check shortcuts:", error);
      return false;
    }
  }, []);

  const getShortcuts = useCallback(async (): Promise<Record<
    string,
    string
  > | null> => {
    try {
      const shortcuts = await invoke<Record<string, string>>(
        "get_registered_shortcuts"
      );
      return shortcuts;
    } catch (error) {
      console.error("Failed to get shortcuts:", error);
      return null;
    }
  }, []);

  const updateShortcuts = useCallback(async (): Promise<boolean> => {
    try {
      const config = getShortcutsConfig();
      await invoke("update_shortcuts", { config });
      return true;
    } catch (error) {
      console.error("Failed to update shortcuts:", error);
      return false;
    }
  }, []);

  // Register input element for auto-focus
  const registerInputRef = useCallback((input: HTMLInputElement | null) => {
    if (!input) return;
    return globalInput.set(input);
  }, []);

  // Register audio callback
  const registerAudioCallback = useCallback((callback: () => void) => {
    return globalAudioCallback.set(callback);
  }, []);

  // Register screenshot callback
  const registerScreenshotCallback = useCallback(
    (callback: () => void | Promise<void>) => {
      return globalScreenshotCallback.set(callback);
    },
    []
  );

  // Register system audio callback
  const registerSystemAudioCallback = useCallback((callback: () => void) => {
    return globalSystemAudioCallback.set(callback);
  }, []);

  // Register custom shortcut callback
  const registerCustomShortcutCallback = useCallback(
    (actionId: string, callback: () => void) => {
      return globalCustomShortcutCallbacks.set(actionId, callback);
    },
    []
  );

  // Unregister custom shortcut callback
  const unregisterCustomShortcutCallback = useCallback((actionId: string) => {
    globalCustomShortcutCallbacks.delete(actionId);
  }, []);

  // Setup event listeners using global singleton
  useEffect(() => {
    setupGlobalEventListeners ??= async () => {
      try {
        // Clean up any existing global listeners first
        if (globalEventListeners.focus) {
          try {
            globalEventListeners.focus();
          } catch (error) {
            console.warn("Error cleaning up focus listener:", error);
          }
        }
        if (globalEventListeners.audio) {
          try {
            globalEventListeners.audio();
          } catch (error) {
            console.warn("Error cleaning up audio listener:", error);
          }
        }
        if (globalEventListeners.screenshot) {
          try {
            globalEventListeners.screenshot();
          } catch (error) {
            console.warn("Error cleaning up screenshot listener:", error);
          }
        }
        if (globalEventListeners.systemAudio) {
          try {
            globalEventListeners.systemAudio();
          } catch (error) {
            console.warn("Error cleaning up system audio listener:", error);
          }
        }
        if (globalEventListeners.customShortcut) {
          try {
            globalEventListeners.customShortcut();
          } catch (error) {
            console.warn("Error cleaning up custom shortcut listener:", error);
          }
        }
        if (globalEventListeners.registrationError) {
          try {
            globalEventListeners.registrationError();
          } catch (error) {
            console.warn(
              "Error cleaning up shortcut registration error listener:",
              error
            );
          }
        }
        globalEventListeners = {};

        // Listen for focus text input event
        const unlistenFocus = await listen("focus-text-input", () => {
          setTimeout(() => {
            const input = globalInput.get();
            if (input) {
              input.focus();
            }
          }, 100);
        });
        globalEventListeners.focus = unlistenFocus;

        // Listen for audio recording event
        const unlistenAudio = await listen("start-audio-recording", () => {
          const callback = globalAudioCallback.get();
          if (callback) {
            callback();
          }
        });
        globalEventListeners.audio = unlistenAudio;

        // Listen for screenshot trigger event with debouncing
        const unlistenScreenshot = await listen("trigger-screenshot", () => {
          const now = Date.now();
          const timeSinceLastEvent = now - lastScreenshotEventTime;

          // Debounce screenshot events (300ms minimum interval)
          if (timeSinceLastEvent < 300) {
            return;
          }

          lastScreenshotEventTime = now;

          const callback = globalScreenshotCallback.get();
          if (callback) {
            try {
              Promise.resolve(callback())
                .catch((error) => {
                  console.error("Screenshot shortcut callback failed:", error);
                })
                .then(() => {
                  // no-op
                });
            } catch (error) {
              console.error(
                "Failed to run screenshot shortcut callback:",
                error
              );
            }
          } else {
            console.warn(
              "Screenshot shortcut triggered but no callback registered."
            );
          }
        });
        globalEventListeners.screenshot = unlistenScreenshot;

        // Listen for system audio toggle event
        const unlistenSystemAudio = await listen("toggle-system-audio", () => {
          const callback = globalSystemAudioCallback.get();
          if (callback) {
            callback();
          }
        });
        globalEventListeners.systemAudio = unlistenSystemAudio;

        // Listen for custom shortcut events
        const unlistenCustomShortcut = await listen<{ action: string }>(
          "custom-shortcut-triggered",
          (event) => {
            const actionId = event.payload.action;
            const callback = globalCustomShortcutCallbacks.get(actionId);
            if (callback) {
              callback();
            } else {
              console.warn(
                `No callback registered for custom shortcut: ${actionId}`
              );
            }
          }
        );
        globalEventListeners.customShortcut = unlistenCustomShortcut;

        const unlistenRegistrationError = await listen<
          Array<[string, string, string]>
        >("shortcut-registration-error", (event) => {
          window.dispatchEvent(
            new CustomEvent("shortcutRegistrationError", {
              detail: event.payload,
            })
          );
        });
        globalEventListeners.registrationError = unlistenRegistrationError;
      } catch (error) {
        throw error;
      }
    };

    void globalListenerInitializer.run().catch((error) => {
      console.error("Failed to setup event listeners:", error);
    });
  }, []);

  return {
    checkShortcutsRegistered,
    getShortcuts,
    updateShortcuts,
    registerInputRef,
    registerAudioCallback,
    registerScreenshotCallback,
    registerSystemAudioCallback,
    registerCustomShortcutCallback,
    unregisterCustomShortcutCallback,
  };
};
