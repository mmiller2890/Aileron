import { describe, expect, test, vi, beforeEach } from "vitest";

const { dbExecute, dbSelect, getDatabaseMock, invokeMock } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  dbSelect: vi.fn(),
  getDatabaseMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@/lib", () => ({
  safeLocalStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
}));

vi.mock("./config", () => ({
  getDatabase: getDatabaseMock,
}));

const { saveConversation, createConversation } = await import(
  "./chat-history.action"
);

const conversation = {
  id: "c1",
  title: "Title",
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { id: "m1", role: "user" as const, content: "hi", timestamp: 100 },
    { id: "m2", role: "assistant" as const, content: "yo", timestamp: 200 },
  ],
};

const sql = () => dbExecute.mock.calls.map((call) => call[0]);

beforeEach(() => {
  dbExecute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  dbSelect.mockReset().mockResolvedValue([]);
  getDatabaseMock.mockReset().mockResolvedValue({
    execute: dbExecute,
    select: dbSelect,
  });
  invokeMock.mockReset().mockResolvedValue(undefined);
});

describe("saveConversation", () => {
  test("rejects when the lookup fails and never deletes committed history", async () => {
    dbSelect.mockRejectedValue(new Error("database is locked"));
    dbExecute.mockRejectedValue(new Error("UNIQUE constraint failed"));
    invokeMock.mockRejectedValue(new Error("native save failed"));

    await expect(saveConversation(conversation as never)).rejects.toThrow();

    expect(
      sql().filter((statement) =>
        statement.includes("DELETE FROM conversations"),
      ),
    ).toHaveLength(0);
  });
});

describe("createConversation", () => {
  test("keeps an existing conversation when a duplicate create is rejected", async () => {
    dbExecute.mockRejectedValue(new Error("UNIQUE constraint failed"));
    invokeMock.mockRejectedValue(new Error("conversation already exists"));

    await expect(createConversation(conversation as never)).rejects.toThrow();

    expect(
      sql().filter((statement) =>
        statement.includes("DELETE FROM conversations"),
      ),
    ).toHaveLength(0);
  });
});