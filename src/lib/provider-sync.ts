/**
 * Cross-window sync for provider configuration.
 *
 * The overlay and the dashboard are separate webviews, each with its own
 * React tree and its own copy of the provider config. Keeping them in step
 * used to rely on the `storage` event, which misses this case twice over:
 *
 *  - Editing only a *variable* (the model name, an API key) rewrites
 *    `SELECTED_AI_PROVIDER` with an identical `{"provider":"..."}` value, and
 *    `storage` only fires when the value actually changes.
 *  - The variables themselves live under a separate secret key that the
 *    listener never watched.
 *
 * The result: the dashboard could answer a question while the overlay
 * insisted the model was missing. A Tauri event doesn't depend on either
 * detail, and works across webviews where `storage` is unreliable.
 */
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Any window → all windows: provider config changed, re-read it. */
export const PROVIDER_CONFIG_CHANGED = "provider-config-changed";
export const AI_PROVIDER_SECRET_KEY = "selected_ai_provider_variables";
export const STT_PROVIDER_SECRET_KEY = "selected_stt_provider_variables";

export interface ProviderSelection {
  provider: string;
  variables?: Record<string, string>;
}

export function providerSecretKey(baseKey: string, providerId: string): string {
  return `${baseKey}:${encodeURIComponent(providerId)}`;
}

/**
 * Decide whether startup must switch away from local-fluidaudio.
 *
 * Only a user who actually *saved* local-fluidaudio should be moved to groq —
 * on every launch, an unconditional fallback clobbered whatever provider was
 * stored (e.g. openai-whisper). The saved id is read from storage, not from
 * React state, so the decision does not depend on render timing.
 */
export function shouldFallbackSttProvider(
  savedProviderId: string,
  platform: "macos" | "other",
  isFluidaudioSupported: boolean
): boolean {
  if (savedProviderId !== "local-fluidaudio") return false;
  if (platform !== "macos") return true;
  return !isFluidaudioSupported;
}

export async function readScopedProviderSecret(
  baseKey: string,
  provider: string,
  read: (key: string) => Promise<string | null>
): Promise<string | null> {
  return read(providerSecretKey(baseKey, provider));
}

export interface ProviderSecretStore {
  get(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export async function readInitialProviderSecret(
  baseKey: string,
  provider: string,
  store: ProviderSecretStore
): Promise<string | null> {
  const scopedKey = providerSecretKey(baseKey, provider);
  const scoped = await store.get(scopedKey);
  if (scoped !== null) return scoped;

  const legacy = await store.get(baseKey);
  if (legacy === null) return null;

  await store.save(scopedKey, legacy);
  await store.remove(baseKey);
  return legacy;
}

export function createStartupProviderSecretReader(
  startupProvider: string,
  store: ProviderSecretStore
) {
  let firstRead = true;

  return {
    read(baseKey: string, provider: string): Promise<string | null> {
      const canMigrate = firstRead && provider === startupProvider;
      firstRead = false;
      return canMigrate
        ? readInitialProviderSecret(baseKey, provider, store)
        : readScopedProviderSecret(baseKey, provider, store.get);
    },
  };
}

export interface ProviderSwitchHydration {
  provider: string;
  readSecret(): Promise<string | null>;
  canApply(): boolean;
  parseVariables(secret: string): Record<string, string>;
  apply(value: Required<ProviderSelection>): void;
  announce(): void;
}

export async function hydrateProviderSwitch({
  provider,
  readSecret,
  canApply,
  parseVariables,
  apply,
  announce,
}: ProviderSwitchHydration): Promise<boolean> {
  const secret = await readSecret();
  if (!canApply()) return false;

  let variables: Record<string, string> = {};
  if (secret) {
    try {
      variables = parseVariables(secret);
    } catch {}
  }

  if (!canApply()) return false;
  apply({ provider, variables });
  announce();
  return true;
}

export async function removeProviderAndSecret({
  providerId,
  baseKey,
  removeProvider,
  removeSecret,
}: {
  providerId: string;
  baseKey: string;
  removeProvider: (providerId: string) => boolean;
  removeSecret: (key: string) => Promise<void>;
}): Promise<boolean> {
  if (!removeProvider(providerId)) return false;
  await removeSecret(providerSecretKey(baseKey, providerId));
  return true;
}

export interface ProviderLoadToken {
  provider: string;
  generation: number;
}

export function createProviderLoadGuard() {
  let generation = 0;

  return {
    begin(provider: string): ProviderLoadToken {
      generation += 1;
      return { provider, generation };
    },
    invalidate(): void {
      generation += 1;
    },
    isCurrent(token: ProviderLoadToken): boolean {
      return token.generation === generation;
    },
    canApply(token: ProviderLoadToken, currentProvider: string): boolean {
      return (
        token.generation === generation && token.provider === currentProvider
      );
    },
  };
}

export function createSerializedAsyncWriter<T>(
  write: (value: T) => Promise<void>
) {
  let tail = Promise.resolve();

  return {
    enqueue(value: T): Promise<void> {
      const next = tail.then(
        () => write(value),
        () => write(value)
      );
      tail = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    },
  };
}

export interface PersistDecision {
  /** Serialized form to record as "last persisted". */
  serialized: string;
  /** Nothing changed; do no work at all. */
  skip: boolean;
  /** Write the variables to the keychain/fallback. */
  writeSecret: boolean;
  /** Tell other windows to re-read. */
  emit: boolean;
}

export function serializeProviderSelection(value: ProviderSelection): string {
  return JSON.stringify({
    provider: value.provider,
    variables: value.variables || {},
  });
}

/**
 * Decide what persisting a provider selection should actually do.
 *
 * Three cases have each caused a real bug, so they are spelled out here rather
 * than left implicit in an effect:
 *
 *  - **Unchanged** (`lastPersisted` matches): do nothing. This is what stops a
 *    window that reloaded in response to another window's change from writing
 *    the value back and emitting an echo — an echo lands in whichever window
 *    is being typed in and replaces the field contents mid-keystroke.
 *  - **First write with no variables**: the provider id loads synchronously
 *    while variables arrive from an async secret read a tick later, so the
 *    first render carries `{}`. Writing it would clobber the stored secret
 *    before the read that restores it lands.
 *  - **First write generally**: hydrating from storage is not a change other
 *    windows need to hear about.
 */
export function decideProviderPersist(
  lastPersisted: string | null,
  next: ProviderSelection
): PersistDecision {
  const serialized = serializeProviderSelection(next);

  if (lastPersisted === serialized) {
    return { serialized, skip: true, writeSecret: false, emit: false };
  }

  const isFirstPersist = lastPersisted === null;
  const hasVariables = Object.keys(next.variables || {}).length > 0;

  return {
    serialized,
    skip: false,
    writeSecret: !(isFirstPersist && !hasVariables),
    emit: !isFirstPersist,
  };
}

export interface ProviderConfigChangedPayload {
  /** Label of the window that made the change, so it can ignore its own echo. */
  source: string;
}

function currentLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return "";
  }
}

/**
 * Announce that provider config changed.
 *
 * Call *after* the secret has been persisted — a listener that reloads before
 * the async write lands would read the previous value straight back.
 */
export function emitProviderConfigChanged(): void {
  void emit(PROVIDER_CONFIG_CHANGED, {
    source: currentLabel(),
  } satisfies ProviderConfigChangedPayload).catch(() => {
    /* best-effort: the storage-event path still covers same-window updates */
  });
}

export function syncProviderMetadataChange(reload: () => void): void {
  emitProviderConfigChanged();
  reload();
}

/**
 * Run `onChange` when another window changes provider config.
 *
 * Self-emitted events are skipped: the emitting window already holds the new
 * value, and reloading there would re-run its persist effect and echo again.
 */
export function listenForProviderConfigChange(
  onChange: () => void
): Promise<() => void> {
  const self = currentLabel();
  return listen<ProviderConfigChangedPayload>(
    PROVIDER_CONFIG_CHANGED,
    (event) => {
      if (event.payload?.source && event.payload.source === self) return;
      onChange();
    }
  );
}
