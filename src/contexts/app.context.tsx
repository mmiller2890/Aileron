import {
  AI_PROVIDERS,
  DEFAULT_SYSTEM_PROMPT,
  SPEECH_TO_TEXT_PROVIDERS,
  STORAGE_KEYS,
} from "@/config";
import { getPlatform, safeLocalStorage, trackAppStart, isMacOS } from "@/lib";
import { getShortcutsConfig } from "@/lib/storage";
import {
  saveSecret,
  getSecret,
  removeSecret,
} from "@/lib/storage/secure-secrets";
import {
  AI_PROVIDER_SECRET_KEY,
  STT_PROVIDER_SECRET_KEY,
  createProviderLoadGuard,
  createSerializedAsyncWriter,
  createStartupProviderSecretReader,
  decideProviderPersist,
  emitProviderConfigChanged,
  hydrateProviderSwitch,
  listenForProviderConfigChange,
  providerSecretKey,
  readScopedProviderSecret,
  serializeProviderSelection,
} from "@/lib/provider-sync";

// Provider variable names are stored/compared uppercase.
function uppercaseKeys(
  vars: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    out[k.toUpperCase()] = v as string;
  }
  return out;
}

const providerSecretStore = {
  get: getSecret,
  save: saveSecret,
  remove: removeSecret,
};

function storedProviderId(key: string): string {
  const saved = safeLocalStorage.getItem(key);
  if (!saved) return "";
  try {
    return JSON.parse(saved).provider ?? "";
  } catch {
    return "";
  }
}
import {
  getCustomizableState,
  setCustomizableState,
  updateAppIconVisibility,
  updateAlwaysOnTop,
  updateAutostart,
  CustomizableState,
  DEFAULT_CUSTOMIZABLE_STATE,
  CursorType,
  updateCursorType,
} from "@/lib/storage";
import { IContextType, ScreenshotConfig, TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { enable, disable } from "@tauri-apps/plugin-autostart";
import {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

const validateAndProcessCurlProviders = (
  providersJson: string,
  providerType: "AI" | "STT"
): TYPE_PROVIDER[] => {
  try {
    const parsed = JSON.parse(providersJson);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((p) => {
        try {
          curl2Json(p.curl);
          return true;
        } catch (e) {
          return false;
        }
      })
      .map((p) => {
        const provider = { ...p, isCustom: true };
        if (providerType === "STT" && provider.curl) {
          provider.curl = provider.curl.replace(/AUDIO_BASE64/g, "AUDIO");
        }
        return provider;
      });
  } catch (e) {
    console.warn(`Failed to parse custom ${providerType} providers`, e);
    return [];
  }
};

// Create the context
const AppContext = createContext<IContextType | undefined>(undefined);

// Create the provider component
export const AppProvider = ({ children }: { children: ReactNode }) => {
  const [systemPrompt, setSystemPrompt] = useState<string>(
    safeLocalStorage.getItem(STORAGE_KEYS.SYSTEM_PROMPT) ||
      DEFAULT_SYSTEM_PROMPT
  );

  const [selectedAudioDevices, setSelectedAudioDevices] = useState<{
    input: { id: string; name: string };
    output: { id: string; name: string };
  }>(() => {
    const savedDevices = safeLocalStorage.getItem(
      STORAGE_KEYS.SELECTED_AUDIO_DEVICES
    );
    if (savedDevices) {
      try {
        return JSON.parse(savedDevices);
      } catch {
        // Return default on parse error
      }
    }

    return {
      input: { id: "", name: "" },
      output: { id: "", name: "" },
    };
  });

  // AI Providers
  const [customAiProviders, setCustomAiProviders] = useState<TYPE_PROVIDER[]>(
    []
  );

  const [selectedAIProvider, setSelectedAIProvider] = useState<{
    provider: string;
    variables: Record<string, string>;
  }>({ provider: "", variables: {} });

  // STT Providers
  const [customSttProviders, setCustomSttProviders] = useState<TYPE_PROVIDER[]>(
    []
  );
  const [selectedSttProvider, setSelectedSttProvider] = useState<{
    provider: string;
    variables: Record<string, string>;
  }>({ provider: isMacOS() ? "local-fluidaudio" : "local-whisper", variables: { MODEL: "openai/whisper-large-v3-turbo" } });

  const [screenshotConfiguration, setScreenshotConfiguration] =
    useState<ScreenshotConfig>({
      mode: "manual",
      autoPrompt: "Analyze this screenshot and provide insights",
      enabled: true,
    });

  // Unified Customizable State
  const [customizable, setCustomizable] = useState<CustomizableState>(
    DEFAULT_CUSTOMIZABLE_STATE
  );
  const [hasActiveLicense, setHasActiveLicense] = useState<boolean>(true);
  const [supportsImages, setSupportsImagesState] = useState<boolean>(() => {
    const stored = safeLocalStorage.getItem(STORAGE_KEYS.SUPPORTS_IMAGES);
    return stored === null ? true : stored === "true";
  });

  // Wrapper to sync supportsImages to localStorage
  const setSupportsImages = (value: boolean) => {
    setSupportsImagesState(value);
    safeLocalStorage.setItem(STORAGE_KEYS.SUPPORTS_IMAGES, String(value));
  };

  // Assistant API State (hosted API removed — always disabled)
  const [localApiEnabled, setLocalApiEnabledState] = useState<boolean>(false);

  const getActiveLicenseStatus = async () => {
    // Hosted license validation has been removed in this local-only fork.
    // All features are unlocked.
    setHasActiveLicense(true);
    setLocalApiEnabled(false);
  };

  useEffect(() => {
    const syncLicenseState = async () => {
      try {
        // License-state syncing to the backend has been removed; only sync shortcuts.
        const config = getShortcutsConfig();
        await invoke("update_shortcuts", { config });
      } catch (error) {
        console.error("Failed to synchronize shortcuts:", error);
      }
    };

    syncLicenseState();
  }, []);

  // Serialized form of the last provider config this window wrote, used by the
  // persist effects below to tell a real edit from a value that merely came
  // back out of storage.
  const lastAiPersistRef = useRef<string | null>(null);
  const lastSttPersistRef = useRef<string | null>(null);
  const aiLoadGuardRef = useRef(createProviderLoadGuard());
  const sttLoadGuardRef = useRef(createProviderLoadGuard());
  const aiStartupSecretReaderRef = useRef<ReturnType<
    typeof createStartupProviderSecretReader
  > | null>(null);
  const sttStartupSecretReaderRef = useRef<ReturnType<
    typeof createStartupProviderSecretReader
  > | null>(null);
  if (!aiStartupSecretReaderRef.current) {
    aiStartupSecretReaderRef.current = createStartupProviderSecretReader(
      storedProviderId(STORAGE_KEYS.SELECTED_AI_PROVIDER),
      providerSecretStore
    );
  }
  if (!sttStartupSecretReaderRef.current) {
    sttStartupSecretReaderRef.current = createStartupProviderSecretReader(
      storedProviderId(STORAGE_KEYS.SELECTED_STT_PROVIDER),
      providerSecretStore
    );
  }
  const aiSecretWriterRef = useRef(
    createSerializedAsyncWriter<{
      key: string;
      value: string;
      serialized: string;
      emit: boolean;
    }>(async (job) => {
      await saveSecret(job.key, job.value);
      if (job.emit && lastAiPersistRef.current === job.serialized) {
        emitProviderConfigChanged();
      }
    })
  );
  const sttSecretWriterRef = useRef(
    createSerializedAsyncWriter<{
      key: string;
      value: string;
      serialized: string;
      emit: boolean;
    }>(async (job) => {
      await saveSecret(job.key, job.value);
      if (job.emit && lastSttPersistRef.current === job.serialized) {
        emitProviderConfigChanged();
      }
    })
  );

  /**
   * Record a provider config as already-persisted.
   *
   * Applying values that came *from* storage must not look like a local edit.
   * Without this the reload triggered by another window's change would run the
   * persist effect, write the values straight back, and emit again — and that
   * echo lands in the window where someone is typing, replacing the field's
   * contents with a value that is one async write behind the keystrokes.
   */
  const markAiPersisted = (value: {
    provider: string;
    variables?: Record<string, string>;
  }) => {
    lastAiPersistRef.current = serializeProviderSelection(value);
  };
  const markSttPersisted = (value: {
    provider: string;
    variables?: Record<string, string>;
  }) => {
    lastSttPersistRef.current = serializeProviderSelection(value);
  };

  // Function to load AI, STT, system prompt and screenshot config data from storage
  const loadData = () => {
    // Load system prompt
    const savedSystemPrompt = safeLocalStorage.getItem(
      STORAGE_KEYS.SYSTEM_PROMPT
    );
    if (savedSystemPrompt) {
      setSystemPrompt(savedSystemPrompt || DEFAULT_SYSTEM_PROMPT);
    }

    // Load screenshot configuration
    const savedScreenshotConfig = safeLocalStorage.getItem(
      STORAGE_KEYS.SCREENSHOT_CONFIG
    );
    if (savedScreenshotConfig) {
      try {
        const parsed = JSON.parse(savedScreenshotConfig);
        if (typeof parsed === "object" && parsed !== null) {
          setScreenshotConfiguration({
            mode: parsed.mode || "manual",
            autoPrompt:
              parsed.autoPrompt ||
              "Analyze this screenshot and provide insights",
            enabled: parsed.enabled !== undefined ? parsed.enabled : false,
          });
        }
      } catch {
        console.warn("Failed to parse screenshot configuration");
      }
    }

    // Load custom AI providers
    const savedAi = safeLocalStorage.getItem(STORAGE_KEYS.CUSTOM_AI_PROVIDERS);
    let aiList: TYPE_PROVIDER[] = [];
    if (savedAi) {
      aiList = validateAndProcessCurlProviders(savedAi, "AI");
    }
    setCustomAiProviders(aiList);

    // Load custom STT providers
    const savedStt = safeLocalStorage.getItem(
      STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS
    );
    let sttList: TYPE_PROVIDER[] = [];
    if (savedStt) {
      sttList = validateAndProcessCurlProviders(savedStt, "STT");
    }
    setCustomSttProviders(sttList);

    // Load selected AI provider (empty until the user picks one on first run).
    // Provider id lives in localStorage; secret variables live in the keychain.
    const savedSelectedAi = safeLocalStorage.getItem(
      STORAGE_KEYS.SELECTED_AI_PROVIDER
    );
    if (savedSelectedAi) {
      try {
        const parsed = JSON.parse(savedSelectedAi);
        const inlineVars = parsed.variables
          ? uppercaseKeys(parsed.variables)
          : undefined;
        // Set immediately from whatever localStorage holds (old blobs still
        // carry inline variables), so the provider is usable right away.
        const provider = parsed.provider ?? "";
        const loadedAi = {
          provider,
          variables: inlineVars ?? {},
        };
        const loadToken = aiLoadGuardRef.current.begin(provider);
        markAiPersisted(loadedAi);
        setSelectedAIProvider(loadedAi);
        // Then reconcile secrets with the keychain (async).
        void (async () => {
          if (inlineVars && Object.keys(inlineVars).length) {
            // Migrate legacy plaintext: move secrets to the keychain, then
            // strip them from localStorage (saveSecret guarantees the value is
            // stored before we drop the plaintext copy).
            await saveSecret(
              providerSecretKey(AI_PROVIDER_SECRET_KEY, provider),
              JSON.stringify(inlineVars)
            );
            await removeSecret(AI_PROVIDER_SECRET_KEY);
            if (aiLoadGuardRef.current.isCurrent(loadToken)) {
              safeLocalStorage.setItem(
                STORAGE_KEYS.SELECTED_AI_PROVIDER,
                JSON.stringify({ provider })
              );
            }
          } else {
            const secret = await aiStartupSecretReaderRef.current!.read(
              AI_PROVIDER_SECRET_KEY,
              provider
            );
            if (secret) {
              try {
                const vars = uppercaseKeys(JSON.parse(secret));
                setSelectedAIProvider((prev) => {
                  if (!aiLoadGuardRef.current.canApply(loadToken, prev.provider)) {
                    return prev;
                  }
                  const next = { ...prev, variables: vars };
                  markAiPersisted(next);
                  return next;
                });
              } catch {
                /* corrupt secret blob — leave variables empty */
              }
            }
          }
        })();
      } catch {
        setSelectedAIProvider({ provider: "", variables: {} });
      }
    }

    // Load selected STT provider (provider id in localStorage, secrets in the
    // keychain — same scheme as the AI provider above).
    const savedSelectedStt = safeLocalStorage.getItem(
      STORAGE_KEYS.SELECTED_STT_PROVIDER
    );
    if (savedSelectedStt) {
      try {
        const parsed = JSON.parse(savedSelectedStt);
        const inlineVars = parsed.variables
          ? uppercaseKeys(parsed.variables)
          : undefined;
        const provider = parsed.provider ?? "";
        const loadedStt = {
          provider,
          variables: inlineVars ?? {},
        };
        const loadToken = sttLoadGuardRef.current.begin(provider);
        markSttPersisted(loadedStt);
        setSelectedSttProvider(loadedStt);
        void (async () => {
          if (inlineVars && Object.keys(inlineVars).length) {
            await saveSecret(
              providerSecretKey(STT_PROVIDER_SECRET_KEY, provider),
              JSON.stringify(inlineVars)
            );
            await removeSecret(STT_PROVIDER_SECRET_KEY);
            if (sttLoadGuardRef.current.isCurrent(loadToken)) {
              safeLocalStorage.setItem(
                STORAGE_KEYS.SELECTED_STT_PROVIDER,
                JSON.stringify({ provider })
              );
            }
          } else {
            const secret = await sttStartupSecretReaderRef.current!.read(
              STT_PROVIDER_SECRET_KEY,
              provider
            );
            if (secret) {
              try {
                const vars = uppercaseKeys(JSON.parse(secret));
                setSelectedSttProvider((prev) => {
                  if (
                    !sttLoadGuardRef.current.canApply(
                      loadToken,
                      prev.provider
                    )
                  ) {
                    return prev;
                  }
                  const next = { ...prev, variables: vars };
                  markSttPersisted(next);
                  return next;
                });
              } catch {
                /* corrupt secret blob — leave variables empty */
              }
            }
          }
        })();
      } catch {
        setSelectedSttProvider({
          provider: isMacOS() ? "local-fluidaudio" : "local-whisper",
          variables: { MODEL: "openai/whisper-large-v3-turbo" },
        });
      }
    }

    // Load customizable state
    const customizableState = getCustomizableState();
    setCustomizable(customizableState);

    updateCursor(customizableState.cursor.type || "invisible");

    const stored = safeLocalStorage.getItem(STORAGE_KEYS.CUSTOMIZABLE);
    if (!stored) {
      // save the default state
      setCustomizableState(customizableState);
    } else {
      // check if we need to update the schema
      try {
        const parsed = JSON.parse(stored);
        if (!parsed.autostart) {
          // save the merged state with new autostart property
          setCustomizableState(customizableState);
          updateCursor(customizableState.cursor.type || "invisible");
        }
      } catch (error) {
        console.debug("Failed to check customizable state schema:", error);
      }
    }

    // Load Assistant API enabled state (hosted API removed — always disabled)
    setLocalApiEnabledState(false);

    // Load selected audio devices
    const savedAudioDevices = safeLocalStorage.getItem(
      STORAGE_KEYS.SELECTED_AUDIO_DEVICES
    );
    if (savedAudioDevices) {
      try {
        const parsed = JSON.parse(savedAudioDevices);
        if (parsed && typeof parsed === "object") {
          setSelectedAudioDevices(parsed);
        }
      } catch {
        console.warn("Failed to parse selected audio devices");
      }
    }
  };

  const updateCursor = (type: CursorType | undefined) => {
    try {
      const currentWindow = getCurrentWindow();
      const platform = getPlatform();
      // For Linux, always use default cursor
      if (platform === "linux") {
        document.documentElement.style.setProperty("--cursor-type", "default");
        return;
      }
      const windowLabel = currentWindow.label;

      if (windowLabel === "dashboard") {
        // For dashboard, always use default cursor
        document.documentElement.style.setProperty("--cursor-type", "default");
        return;
      }

      // For overlay windows (main, capture-overlay-*)
      const safeType = type || "invisible";
      const cursorValue = type === "invisible" ? "none" : safeType;
      document.documentElement.style.setProperty("--cursor-type", cursorValue);
    } catch (error) {
      document.documentElement.style.setProperty("--cursor-type", "default");
    }
  };

  // Load data on mount
  useEffect(() => {
    const initializeApp = async () => {
      // Load license and data
      await getActiveLicenseStatus();

      // Track app start (telemetry removed — no-op)
      try {
        const appVersion = await invoke<string>("get_app_version");
        await trackAppStart(appVersion, "");
      } catch (error) {
        console.debug("Failed to track app start:", error);
      }

      // Platform gating: local-fluidaudio requires macOS Apple Silicon.
      if (isMacOS()) {
        try {
          const status = await invoke<{
            is_supported: boolean;
          }>("stt_get_status");
          if (!status.is_supported) {
            onSetSelectedSttProvider({ provider: "groq", variables: {} });
          }
        } catch (error) {
          console.debug("Failed to check STT status:", error);
        }
      } else {
        if (selectedSttProvider.provider === "local-fluidaudio") {
          onSetSelectedSttProvider({ provider: "groq", variables: {} });
        }
      }
    };
    // Load data
    loadData();
    initializeApp();
  }, []);

  // Handle customizable settings on state changes
  useEffect(() => {
    const applyCustomizableSettings = async () => {
      try {
        await Promise.all([
          invoke("set_app_icon_visibility", {
            visible: customizable.appIcon.isVisible,
          }),
          invoke("set_always_on_top", {
            enabled: customizable.alwaysOnTop.isEnabled,
          }),
        ]);
      } catch (error) {
        console.error("Failed to apply customizable settings:", error);
      }
    };

    applyCustomizableSettings();
  }, [customizable]);

  useEffect(() => {
    const initializeAutostart = async () => {
      try {
        const autostartInitialized = safeLocalStorage.getItem(
          STORAGE_KEYS.AUTOSTART_INITIALIZED
        );

        // Only apply autostart on the very first launch
        if (!autostartInitialized) {
          const autostartEnabled = customizable?.autostart?.isEnabled ?? true;

          if (autostartEnabled) {
            await enable();
          } else {
            await disable();
          }

          // Mark as initialized so this never runs again
          safeLocalStorage.setItem(STORAGE_KEYS.AUTOSTART_INITIALIZED, "true");
        }
      } catch (error) {
        console.debug("Autostart initialization skipped:", error);
      }
    };

    initializeAutostart();
  }, []);

  // Listen for app icon hide/show events when window is toggled
  useEffect(() => {
    const handleAppIconVisibility = async (isVisible: boolean) => {
      try {
        await invoke("set_app_icon_visibility", { visible: isVisible });
      } catch (error) {
        console.error("Failed to set app icon visibility:", error);
      }
    };

    const unlistenHide = listen("handle-app-icon-on-hide", async () => {
      const currentState = getCustomizableState();
      // Only hide app icon if user has set it to hide mode
      if (!currentState.appIcon.isVisible) {
        await handleAppIconVisibility(false);
      }
    });

    const unlistenShow = listen("handle-app-icon-on-show", async () => {
      // Always show app icon when window is shown, regardless of user setting
      await handleAppIconVisibility(true);
    });

    return () => {
      unlistenHide.then((fn) => fn());
      unlistenShow.then((fn) => fn());
    };
  }, []);

  // Listen to storage events for real-time sync (e.g., multi-tab).
  // Debounce loadData to avoid repeated full reloads when multiple keys
  // change in rapid succession (e.g. screenshot config updates).
  const loadDataRef = useRef(loadData);
  loadDataRef.current = loadData;

  useEffect(() => {
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const RELOAD_DEBOUNCE_MS = 200;

    const handleStorageChange = (e: StorageEvent) => {
      // Sync supportsImages across windows
      if (e.key === STORAGE_KEYS.SUPPORTS_IMAGES && e.newValue !== null) {
        setSupportsImagesState(e.newValue === "true");
      }

      if (
        e.key === STORAGE_KEYS.CUSTOM_AI_PROVIDERS ||
        e.key === STORAGE_KEYS.SELECTED_AI_PROVIDER ||
        e.key === STORAGE_KEYS.CUSTOM_SPEECH_PROVIDERS ||
        e.key === STORAGE_KEYS.SELECTED_STT_PROVIDER ||
        e.key === STORAGE_KEYS.SYSTEM_PROMPT ||
        e.key === STORAGE_KEYS.SCREENSHOT_CONFIG ||
        e.key === STORAGE_KEYS.CUSTOMIZABLE ||
        e.key === STORAGE_KEYS.SELECTED_AUDIO_DEVICES ||
        // Provider *variables* (model name, API key) live under their own
        // keys, so a change to them never touches the provider-id key above.
        e.key?.startsWith(
          `secure_fallback_${AI_PROVIDER_SECRET_KEY}:`
        ) ||
        e.key?.startsWith(
          `secure_fallback_${STT_PROVIDER_SECRET_KEY}:`
        )
      ) {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          loadDataRef.current();
        }, RELOAD_DEBOUNCE_MS);
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => {
      window.removeEventListener("storage", handleStorageChange);
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  }, []);

  // Authoritative cross-window sync. The `storage` listener above cannot see a
  // variable-only edit (the provider-id value it watches is unchanged, so no
  // event fires) and is unreliable across separate webviews regardless.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listenForProviderConfigChange(() => {
      if (!disposed) loadDataRef.current();
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to listen for provider config changes:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Check if the current AI provider/model supports images
  useEffect(() => {
    const checkImageSupport = async () => {
      // Hosted Assistant API has been removed; always evaluate custom provider image support.
      const provider = allAiProviders.find(
        (p) => p.id === selectedAIProvider.provider
      );
      if (provider) {
        const hasImageSupport = provider.curl?.includes("{{IMAGE}}") ?? false;
        setSupportsImages(hasImageSupport);
      } else {
        setSupportsImages(true);
      }
    };

    checkImageSupport();
  }, [selectedAIProvider.provider]);

  // Persist selected AI: provider id in localStorage, secrets in the keychain.
  //
  // The announce-after-write is what keeps the overlay in step: the provider id
  // in localStorage is unchanged when only a variable is edited, so nothing
  // else tells the other window its model just changed. Guarded by the last
  // persisted value so a window reloading in response doesn't echo back.
  useEffect(() => {
    if (!selectedAIProvider.provider) return;

    const decision = decideProviderPersist(
      lastAiPersistRef.current,
      selectedAIProvider
    );
    if (decision.skip) return;
    lastAiPersistRef.current = decision.serialized;

    safeLocalStorage.setItem(
      STORAGE_KEYS.SELECTED_AI_PROVIDER,
      JSON.stringify({ provider: selectedAIProvider.provider })
    );
    if (!decision.writeSecret) return;

    void aiSecretWriterRef.current
      .enqueue({
        key: providerSecretKey(
          AI_PROVIDER_SECRET_KEY,
          selectedAIProvider.provider
        ),
        value: JSON.stringify(selectedAIProvider.variables || {}),
        serialized: decision.serialized,
        emit: decision.emit,
      })
      .catch((error) => {
        console.error("Failed to persist AI provider variables:", error);
      });
  }, [selectedAIProvider]);

  // Persist selected STT: provider id in localStorage, secrets in the keychain.
  useEffect(() => {
    if (!selectedSttProvider.provider) return;

    const decision = decideProviderPersist(
      lastSttPersistRef.current,
      selectedSttProvider
    );
    if (decision.skip) return;
    lastSttPersistRef.current = decision.serialized;

    safeLocalStorage.setItem(
      STORAGE_KEYS.SELECTED_STT_PROVIDER,
      JSON.stringify({ provider: selectedSttProvider.provider })
    );
    if (!decision.writeSecret) return;

    void sttSecretWriterRef.current
      .enqueue({
        key: providerSecretKey(
          STT_PROVIDER_SECRET_KEY,
          selectedSttProvider.provider
        ),
        value: JSON.stringify(selectedSttProvider.variables || {}),
        serialized: decision.serialized,
        emit: decision.emit,
      })
      .catch((error) => {
        console.error("Failed to persist STT provider variables:", error);
      });
  }, [selectedSttProvider]);

  // Computed all AI providers
  const allAiProviders: TYPE_PROVIDER[] = [
    ...AI_PROVIDERS,
    ...customAiProviders,
  ];

  // Computed all STT providers
  const allSttProviders: TYPE_PROVIDER[] = [
    ...SPEECH_TO_TEXT_PROVIDERS,
    ...customSttProviders,
  ];

  // Validate selected STT provider exists in the available providers.
  // Handles migration when providers are removed (e.g., local-parakeet, local-nemotron).
  useEffect(() => {
    if (
      selectedSttProvider.provider &&
      !allSttProviders.some((p) => p.id === selectedSttProvider.provider)
    ) {
      const fallback = isMacOS()
        ? { provider: "local-fluidaudio" as const, variables: {} as Record<string, string> }
        : {
            provider: "local-whisper" as const,
            variables: { MODEL: "openai/whisper-large-v3-turbo" } as Record<string, string>,
          };
      console.warn(
        `Saved STT provider "${selectedSttProvider.provider}" no longer exists; falling back to "${fallback.provider}"`
      );
      setSelectedSttProvider(fallback);
    }
  }, [selectedSttProvider.provider, allSttProviders]);

  const onSetSelectedAIProvider = ({
    provider,
    variables,
  }: {
    provider: string;
    variables: Record<string, string>;
  }) => {
    if (provider && !allAiProviders.some((p) => p.id === provider)) {
      console.warn(`Invalid AI provider ID: ${provider}`);
      return;
    }

    // Update supportsImages immediately when provider changes
    {
      const selectedProvider = allAiProviders.find((p) => p.id === provider);
      if (selectedProvider) {
        const hasImageSupport =
          selectedProvider.curl?.includes("{{IMAGE}}") ?? false;
        setSupportsImages(hasImageSupport);
      } else {
        setSupportsImages(true);
      }
    }

    const isProviderSwitch = provider !== selectedAIProvider.provider;
    const hasProvidedVariables = Object.keys(variables).length > 0;
    if (!isProviderSwitch || hasProvidedVariables || !provider) {
      aiLoadGuardRef.current.invalidate();
      setSelectedAIProvider({ provider, variables });
      return;
    }

    const loadToken = aiLoadGuardRef.current.begin(provider);
    const loadingValue = { provider, variables: {} };
    markAiPersisted(loadingValue);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SELECTED_AI_PROVIDER,
      JSON.stringify({ provider })
    );
    setSelectedAIProvider(loadingValue);

    void hydrateProviderSwitch({
      provider,
      readSecret: () =>
        readScopedProviderSecret(
          AI_PROVIDER_SECRET_KEY,
          provider,
          getSecret
        ),
      canApply: () => aiLoadGuardRef.current.isCurrent(loadToken),
      parseVariables: (secret) => uppercaseKeys(JSON.parse(secret)),
      apply: (next) => {
        markAiPersisted(next);
        setSelectedAIProvider(next);
      },
      announce: emitProviderConfigChanged,
    });
  };

  // Setter for selected STT with validation
  const onSetSelectedSttProvider = ({
    provider,
    variables,
  }: {
    provider: string;
    variables: Record<string, string>;
  }) => {
    if (provider && !allSttProviders.some((p) => p.id === provider)) {
      console.warn(`Invalid STT provider ID: ${provider}`);
      return;
    }

    const isProviderSwitch = provider !== selectedSttProvider.provider;
    const hasProvidedVariables = Object.keys(variables).length > 0;
    if (!isProviderSwitch || hasProvidedVariables || !provider) {
      sttLoadGuardRef.current.invalidate();
      setSelectedSttProvider({ provider, variables });
      return;
    }

    const loadToken = sttLoadGuardRef.current.begin(provider);
    const loadingValue = { provider, variables: {} };
    markSttPersisted(loadingValue);
    safeLocalStorage.setItem(
      STORAGE_KEYS.SELECTED_STT_PROVIDER,
      JSON.stringify({ provider })
    );
    setSelectedSttProvider(loadingValue);

    void hydrateProviderSwitch({
      provider,
      readSecret: () =>
        readScopedProviderSecret(
          STT_PROVIDER_SECRET_KEY,
          provider,
          getSecret
        ),
      canApply: () => sttLoadGuardRef.current.isCurrent(loadToken),
      parseVariables: (secret) => uppercaseKeys(JSON.parse(secret)),
      apply: (next) => {
        markSttPersisted(next);
        setSelectedSttProvider(next);
      },
      announce: emitProviderConfigChanged,
    });
  };

  // Toggle handlers
  const toggleAppIconVisibility = async (isVisible: boolean) => {
    const newState = updateAppIconVisibility(isVisible);
    setCustomizable(newState);
    try {
      await invoke("set_app_icon_visibility", { visible: isVisible });
      loadData();
    } catch (error) {
      console.error("Failed to toggle app icon visibility:", error);
    }
  };

  const toggleAlwaysOnTop = async (isEnabled: boolean) => {
    const newState = updateAlwaysOnTop(isEnabled);
    setCustomizable(newState);
    try {
      await invoke("set_always_on_top", { enabled: isEnabled });
      loadData();
    } catch (error) {
      console.error("Failed to toggle always on top:", error);
    }
  };

  const toggleAutostart = async (isEnabled: boolean) => {
    const newState = updateAutostart(isEnabled);
    setCustomizable(newState);
    try {
      if (isEnabled) {
        await enable();
      } else {
        await disable();
      }
      loadData();
    } catch (error) {
      console.error("Failed to toggle autostart:", error);
      const revertedState = updateAutostart(!isEnabled);
      setCustomizable(revertedState);
    }
  };

  const setCursorType = (type: CursorType) => {
    setCustomizable((prev) => ({ ...prev, cursor: { type } }));
    updateCursor(type);
    updateCursorType(type);
    loadData();
  };

  const setLocalApiEnabled = async (_enabled: boolean) => {
    // Hosted Assistant API has been removed; this setter is retained as a no-op for compatibility.
    setLocalApiEnabledState(false);
  };

  // Create the context value (extend IContextType accordingly)
  const value: IContextType = {
    systemPrompt,
    setSystemPrompt,
    allAiProviders,
    customAiProviders,
    selectedAIProvider,
    onSetSelectedAIProvider,
    allSttProviders,
    customSttProviders,
    selectedSttProvider,
    onSetSelectedSttProvider,
    screenshotConfiguration,
    setScreenshotConfiguration,
    customizable,
    toggleAppIconVisibility,
    toggleAlwaysOnTop,
    toggleAutostart,
    loadData,
    localApiEnabled,
    setLocalApiEnabled,
    hasActiveLicense,
    setHasActiveLicense,
    getActiveLicenseStatus,
    selectedAudioDevices,
    setSelectedAudioDevices,
    setCursorType,
    supportsImages,
    setSupportsImages,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

// Create a hook to access the context
export const useApp = () => {
  const context = useContext(AppContext);

  if (!context) {
    throw new Error("useApp must be used within a AppProvider");
  }

  return context;
};
