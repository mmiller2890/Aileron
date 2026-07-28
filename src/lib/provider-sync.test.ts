import { describe, it, expect, vi, beforeEach } from "vitest";

const emitted: { event: string; payload: any }[] = [];
let handler: ((event: { payload: any }) => void) | null = null;
let label = "main";

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: any) => {
    emitted.push({ event, payload });
    return Promise.resolve();
  },
  listen: (_event: string, cb: (e: { payload: any }) => void) => {
    handler = cb;
    return Promise.resolve(() => {
      handler = null;
    });
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ get label() { return label; } }),
}));

const {
  emitProviderConfigChanged,
  listenForProviderConfigChange,
  decideProviderPersist,
  serializeProviderSelection,
  PROVIDER_CONFIG_CHANGED,
  providerSecretKey,
  createProviderLoadGuard,
  createSerializedAsyncWriter,
  hydrateProviderSwitch,
  readInitialProviderSecret,
  readScopedProviderSecret,
  removeProviderAndSecret,
  createStartupProviderSecretReader,
  syncProviderMetadataChange,
} = await import("./provider-sync");

beforeEach(() => {
  emitted.length = 0;
  handler = null;
  label = "main";
});

describe("provider config cross-window sync", () => {
  it("tags the emit with the sending window's label", () => {
    label = "dashboard";
    emitProviderConfigChanged();
    expect(emitted).toEqual([
      { event: PROVIDER_CONFIG_CHANGED, payload: { source: "dashboard" } },
    ]);
  });

  it("reloads on a change from another window", async () => {
    label = "main";
    const onChange = vi.fn();
    await listenForProviderConfigChange(onChange);

    handler!({ payload: { source: "dashboard" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // Without this, the reload would re-run the emitting window's persist effect
  // and echo the event back, ping-ponging between windows forever.
  it("ignores its own echo", async () => {
    label = "dashboard";
    const onChange = vi.fn();
    await listenForProviderConfigChange(onChange);

    handler!({ payload: { source: "dashboard" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still reloads when the payload carries no source", async () => {
    const onChange = vi.fn();
    await listenForProviderConfigChange(onChange);

    handler!({ payload: {} });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after unlisten", async () => {
    const onChange = vi.fn();
    const unlisten = await listenForProviderConfigChange(onChange);
    unlisten();
    expect(handler).toBeNull();
  });

  it("announces provider metadata changes before reloading locally", () => {
    const order: string[] = [];
    const reload = vi.fn(() => order.push("reload"));

    syncProviderMetadataChange(reload);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe(PROVIDER_CONFIG_CHANGED);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("decideProviderPersist", () => {
  const sel = (provider: string, variables?: Record<string, string>) => ({
    provider,
    variables,
  });

  it("does nothing when the value is unchanged", () => {
    const first = decideProviderPersist(null, sel("ollama", { MODEL: "a" }));
    const again = decideProviderPersist(
      first.serialized,
      sel("ollama", { MODEL: "a" })
    );
    expect(again.skip).toBe(true);
    expect(again.writeSecret).toBe(false);
    expect(again.emit).toBe(false);
  });

  // The hydration race: provider id lands synchronously, variables a tick
  // later. Writing that first empty render would clobber the stored secret.
  it("does not write the secret on a first persist with no variables", () => {
    const d = decideProviderPersist(null, sel("lm-studio", {}));
    expect(d.skip).toBe(false);
    expect(d.writeSecret).toBe(false);
    expect(d.emit).toBe(false);
  });

  it("writes but stays quiet when hydrating a provider that has variables", () => {
    const d = decideProviderPersist(null, sel("lm-studio", { MODEL: "x" }));
    expect(d.writeSecret).toBe(true);
    expect(d.emit).toBe(false);
  });

  it("writes and announces a genuine edit", () => {
    const hydrated = decideProviderPersist(null, sel("lm-studio", { MODEL: "x" }));
    const edited = decideProviderPersist(
      hydrated.serialized,
      sel("lm-studio", { MODEL: "xy" })
    );
    expect(edited.writeSecret).toBe(true);
    expect(edited.emit).toBe(true);
  });

  it("persists a deliberate clear, since it is no longer the first write", () => {
    const hydrated = decideProviderPersist(null, sel("lm-studio", { MODEL: "x" }));
    const cleared = decideProviderPersist(hydrated.serialized, sel("lm-studio", {}));
    expect(cleared.writeSecret).toBe(true);
    expect(cleared.emit).toBe(true);
  });

  it("treats a provider switch as a change", () => {
    const a = decideProviderPersist(null, sel("ollama", { MODEL: "x" }));
    const b = decideProviderPersist(a.serialized, sel("lm-studio", { MODEL: "x" }));
    expect(b.skip).toBe(false);
    expect(b.emit).toBe(true);
  });

  // The regression this whole mechanism exists to prevent: a window that
  // reloaded because another window changed must not write back and re-emit,
  // because that echo overwrites the field being typed in.
  it("goes quiet once a remote value has been recorded as persisted", () => {
    const typed = decideProviderPersist(null, sel("lm-studio", { MODEL: "LFM" }));
    // Remote window loads the same value and records it...
    const remoteRecorded = serializeProviderSelection(sel("lm-studio", { MODEL: "LFM" }));
    // ...so its persist effect finds nothing to do.
    const echo = decideProviderPersist(remoteRecorded, sel("lm-studio", { MODEL: "LFM" }));
    expect(typed.emit).toBe(false); // first write, hydration
    expect(echo.skip).toBe(true);
    expect(echo.emit).toBe(false);
  });
});

describe("provider secret persistence", () => {
  it("uses a distinct key for every provider", () => {
    expect(providerSecretKey("selected_ai_provider_variables", "ollama")).toBe(
      "selected_ai_provider_variables:ollama"
    );
    expect(
      providerSecretKey("selected_ai_provider_variables", "custom/a:b")
    ).toBe("selected_ai_provider_variables:custom%2Fa%3Ab");
  });

  it("rejects a stale load after an A-B-A provider switch", () => {
    const guard = createProviderLoadGuard();
    const firstA = guard.begin("ollama");
    guard.begin("lm-studio");
    const secondA = guard.begin("ollama");

    expect(guard.canApply(firstA, "ollama")).toBe(false);
    expect(guard.canApply(secondA, "ollama")).toBe(true);
    expect(guard.canApply(secondA, "lm-studio")).toBe(false);
  });

  it("reads only the provider-scoped key during a switch", async () => {
    const read = vi.fn().mockResolvedValue("scoped");

    await expect(
      readScopedProviderSecret("selected_ai_provider_variables", "provider-b", read)
    ).resolves.toBe("scoped");
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(
      "selected_ai_provider_variables:provider-b"
    );
  });

  it("migrates the startup provider legacy secret before removing it", async () => {
    const operations: string[] = [];
    const store = {
      get: vi.fn(async (key: string) => {
        operations.push(`get:${key}`);
        return key === "selected_ai_provider_variables" ? "legacy" : null;
      }),
      save: vi.fn(async (key: string, value: string) => {
        operations.push(`save:${key}:${value}`);
      }),
      remove: vi.fn(async (key: string) => {
        operations.push(`remove:${key}`);
      }),
    };

    await expect(
      readInitialProviderSecret(
        "selected_ai_provider_variables",
        "provider-a",
        store
      )
    ).resolves.toBe("legacy");
    expect(operations).toEqual([
      "get:selected_ai_provider_variables:provider-a",
      "get:selected_ai_provider_variables",
      "save:selected_ai_provider_variables:provider-a:legacy",
      "remove:selected_ai_provider_variables",
    ]);
  });

  it("allows legacy migration only on the first startup-provider read", async () => {
    const store = {
      get: vi.fn(async (key: string) =>
        key === "selected_ai_provider_variables" ? "legacy" : null
      ),
      save: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const reader = createStartupProviderSecretReader("provider-a", store);

    await expect(
      reader.read("selected_ai_provider_variables", "provider-a")
    ).resolves.toBe("legacy");
    await expect(
      reader.read("selected_ai_provider_variables", "provider-b")
    ).resolves.toBeNull();

    expect(store.get.mock.calls.map(([key]) => key)).toEqual([
      "selected_ai_provider_variables:provider-a",
      "selected_ai_provider_variables",
      "selected_ai_provider_variables:provider-b",
    ]);
  });

  it("does not migrate legacy data if a different provider is read first", async () => {
    const store = {
      get: vi.fn(async (key: string) =>
        key === "selected_ai_provider_variables" ? "legacy" : null
      ),
      save: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const reader = createStartupProviderSecretReader("provider-a", store);

    await expect(
      reader.read("selected_ai_provider_variables", "provider-b")
    ).resolves.toBeNull();
    await expect(
      reader.read("selected_ai_provider_variables", "provider-a")
    ).resolves.toBeNull();
    expect(store.get).not.toHaveBeenCalledWith(
      "selected_ai_provider_variables"
    );
  });

  it("announces a hydrated switch even when no secret exists", async () => {
    const apply = vi.fn();
    const announce = vi.fn();

    await expect(
      hydrateProviderSwitch({
        provider: "ollama",
        readSecret: async () => null,
        canApply: () => true,
        parseVariables: JSON.parse,
        apply,
        announce,
      })
    ).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith({
      provider: "ollama",
      variables: {},
    });
    expect(announce).toHaveBeenCalledOnce();
  });

  it("does not apply or announce a stale switch load", async () => {
    const apply = vi.fn();
    const announce = vi.fn();

    await expect(
      hydrateProviderSwitch({
        provider: "ollama",
        readSecret: async () => JSON.stringify({ MODEL: "stale" }),
        canApply: () => false,
        parseVariables: JSON.parse,
        apply,
        announce,
      })
    ).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("removes a deleted custom provider's scoped secret", async () => {
    const removeProvider = vi.fn().mockReturnValue(true);
    const removeSecret = vi.fn().mockResolvedValue(undefined);

    await expect(
      removeProviderAndSecret({
        providerId: "custom/a",
        baseKey: "selected_ai_provider_variables",
        removeProvider,
        removeSecret,
      })
    ).resolves.toBe(true);
    expect(removeSecret).toHaveBeenCalledWith(
      "selected_ai_provider_variables:custom%2Fa"
    );
  });

  it("starts async writes in enqueue order", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const writer = createSerializedAsyncWriter<string>(
      (value) =>
        new Promise<void>((resolve) => {
          started.push(value);
          releases.push(resolve);
        })
    );

    const first = writer.enqueue("old");
    const second = writer.enqueue("new");
    await Promise.resolve();
    expect(started).toEqual(["old"]);

    releases.shift()!();
    await first;
    await Promise.resolve();
    expect(started).toEqual(["old", "new"]);

    releases.shift()!();
    await second;
  });

  it("continues with the next write after a failed write", async () => {
    const started: string[] = [];
    const writer = createSerializedAsyncWriter<string>(async (value) => {
      started.push(value);
      if (value === "bad") throw new Error("failed");
    });

    await expect(writer.enqueue("bad")).rejects.toThrow("failed");
    await expect(writer.enqueue("good")).resolves.toBeUndefined();
    expect(started).toEqual(["bad", "good"]);
  });
});
