import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory fake of the keychain plugin, configurable per test.
const keychain = new Map<string, string>();
let keychainMode: "ok" | "throws" | "lies" = "ok";

vi.mock("tauri-plugin-keychain", () => ({
  saveItem: vi.fn(async (key: string, password: string) => {
    if (keychainMode === "throws") throw new Error("keychain unavailable");
    // "lies": accepts the write but never actually stores it (the unsigned
    // dev-build failure mode where a write succeeds but can't be read back).
    if (keychainMode === "lies") return;
    keychain.set(key, password);
  }),
  getItem: vi.fn(async (key: string) => {
    if (keychainMode === "throws") throw new Error("keychain unavailable");
    return keychain.has(key) ? keychain.get(key)! : null;
  }),
  removeItem: vi.fn(async (key: string) => {
    keychain.delete(key);
  }),
}));

import { saveSecret, getSecret, removeSecret } from "./secure-secrets";

// jsdom-free localStorage shim.
const store = new Map<string, string>();
beforeEach(() => {
  keychain.clear();
  store.clear();
  keychainMode = "ok";
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("secure-secrets", () => {
  it("stores in the keychain and leaves no plaintext fallback when it works", async () => {
    await saveSecret("api", "sk-123");
    expect(keychain.get("api")).toBe("sk-123");
    expect(store.get("secure_fallback_api")).toBeUndefined();
    expect(await getSecret("api")).toBe("sk-123");
  });

  it("falls back to localStorage when the keychain throws", async () => {
    keychainMode = "throws";
    await saveSecret("api", "sk-123");
    expect(store.get("secure_fallback_api")).toBe("sk-123");
    expect(await getSecret("api")).toBe("sk-123");
  });

  it("keeps the fallback when the keychain accepts a write but can't read it back", async () => {
    // The dangerous unsigned-dev-build case: never lose the secret.
    keychainMode = "lies";
    await saveSecret("api", "sk-123");
    expect(store.get("secure_fallback_api")).toBe("sk-123");
    expect(await getSecret("api")).toBe("sk-123");
  });

  it("removes the fallback once the keychain starts round-tripping", async () => {
    keychainMode = "throws"; // first save lands in fallback
    await saveSecret("api", "sk-1");
    expect(store.get("secure_fallback_api")).toBe("sk-1");

    keychainMode = "ok"; // keychain now works; re-save should clean up plaintext
    await saveSecret("api", "sk-2");
    expect(store.get("secure_fallback_api")).toBeUndefined();
    expect(await getSecret("api")).toBe("sk-2");
  });

  it("prefers a pending update over an older keychain value", async () => {
    await saveSecret("api", "old-value");
    keychainMode = "lies";
    await saveSecret("api", "new-value");
    expect(await getSecret("api")).toBe("new-value");
  });

  it("returns a legitimately empty pending value instead of keychain data", async () => {
    await saveSecret("api", "old-value");
    keychainMode = "lies";
    await saveSecret("api", "");
    expect(await getSecret("api")).toBe("");
  });

  it("rejects the save when neither backend can retain the value", async () => {
    keychainMode = "throws";
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("localStorage unavailable");
      },
      removeItem: () => undefined,
    });

    await expect(saveSecret("api", "sk-123")).rejects.toThrow();
  });

  it("removeSecret clears both keychain and fallback", async () => {
    keychainMode = "throws";
    await saveSecret("api", "sk-1"); // fallback
    keychainMode = "ok";
    await saveSecret("other", "sk-2"); // keychain
    await removeSecret("api");
    await removeSecret("other");
    expect(await getSecret("api")).toBeNull();
    expect(await getSecret("other")).toBeNull();
  });
});
