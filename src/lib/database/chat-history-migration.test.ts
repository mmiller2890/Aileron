import { describe, expect, test, vi, beforeEach } from "vitest";

const { storage, dbExecute, dbSelect, getDatabaseMock } = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return {
    storage,
    dbExecute: vi.fn(),
    dbSelect: vi.fn(),
    getDatabaseMock: vi.fn(),
  };
});

vi.mock("@/lib", () => ({
  safeLocalStorage: {
    getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
}));

vi.mock("./config", () => ({
  getDatabase: getDatabaseMock,
}));

const { migrateLocalStorageToSQLite } = await import("./chat-history.action");

const LEGACY_KEY = "chat_history";
const MIGRATION_KEY = "chat_history_migrated_to_sqlite";

const conversation = (id: string, title: string) => ({
  id,
  title,
  messages: [
    { id: `${id}-m1`, role: "user", content: "hi", timestamp: 100 },
  ],
});

beforeEach(() => {
  storage.clear();
  dbExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  dbSelect.mockReset().mockResolvedValue([]);
  getDatabaseMock.mockReset().mockResolvedValue({
    execute: dbExecute,
    select: dbSelect,
  });
});

describe("migrateLocalStorageToSQLite", () => {
  test("keeps the legacy data and marker unset when some conversations fail", async () => {
    storage.set(
      LEGACY_KEY,
      JSON.stringify([conversation("c1", "Good"), { id: "c2" }])
    );

    const result = await migrateLocalStorageToSQLite();

    expect(result).toEqual({
      success: false,
      migratedCount: 1,
      error: "1 conversations failed to migrate",
    });
    // A partial failure must not destroy the source data: the legacy key
    // stays so a later launch can retry the failed conversation.
    expect(storage.has(LEGACY_KEY)).toBe(true);
    expect(storage.get(MIGRATION_KEY)).toBeUndefined();
  });

  test("keeps the legacy data and marker unset when an insert throws", async () => {
    storage.set(
      LEGACY_KEY,
      JSON.stringify([conversation("c1", "Good"), conversation("c2", "Bad")])
    );
    dbExecute
      .mockResolvedValueOnce({ rowsAffected: 1 })
      .mockRejectedValueOnce(new Error("db locked"))
      .mockResolvedValueOnce({ rowsAffected: 1 });

    const result = await migrateLocalStorageToSQLite();

    expect(result).toEqual({
      success: false,
      migratedCount: 1,
      error: "1 conversations failed to migrate",
    });
    expect(storage.has(LEGACY_KEY)).toBe(true);
    expect(storage.get(MIGRATION_KEY)).toBeUndefined();
  });

  test("marks migration complete and clears legacy data on full success", async () => {
    storage.set(
      LEGACY_KEY,
      JSON.stringify([conversation("c1", "Good"), conversation("c2", "Also good")])
    );

    const result = await migrateLocalStorageToSQLite();

    expect(result).toEqual({ success: true, migratedCount: 2, error: undefined });
    expect(storage.has(LEGACY_KEY)).toBe(false);
    expect(storage.get(MIGRATION_KEY)).toBe("true");
  });
});
