import { useEffect } from "react";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

interface UseShortcutsProps {
  onAudioRecording?: () => void;
  onScreenshot?: () => void;
  onSystemAudio?: () => void;
  customShortcuts?: Record<string, () => void>;
}

/**
 * Hook to manage global shortcuts for the application
 * Automatically registers callbacks for all shortcut actions
 */
export const useShortcuts = ({
  onAudioRecording,
  onScreenshot,
  onSystemAudio,
  customShortcuts = {},
}: UseShortcutsProps = {}) => {
  const {
    registerAudioCallback,
    registerScreenshotCallback,
    registerSystemAudioCallback,
    registerCustomShortcutCallback,
  } = useGlobalShortcuts();

  // Register standard callbacks
  useEffect(() => {
    if (onAudioRecording) {
      return registerAudioCallback(onAudioRecording);
    }
  }, [onAudioRecording, registerAudioCallback]);

  useEffect(() => {
    if (onScreenshot) {
      return registerScreenshotCallback(onScreenshot);
    }
  }, [onScreenshot, registerScreenshotCallback]);

  useEffect(() => {
    if (onSystemAudio) {
      return registerSystemAudioCallback(onSystemAudio);
    }
  }, [onSystemAudio, registerSystemAudioCallback]);

  // Register custom shortcut callbacks
  useEffect(() => {
    const disposers = Object.entries(customShortcuts).map(
      ([actionId, callback]) =>
        registerCustomShortcutCallback(actionId, callback)
    );

    return () => {
      disposers.forEach((dispose) => dispose());
    };
  }, [customShortcuts, registerCustomShortcutCallback]);

  return useGlobalShortcuts();
};
