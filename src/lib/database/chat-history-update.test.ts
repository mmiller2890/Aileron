import { describe, expect, test, vi, beforeEach } from "vitest";

const { dbExecute, dbSelect, getDatabaseMock } = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  dbSelect: vi.fn(),
  getDatabaseMock: vi.fn(),
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

const { updateConversation } = await import("./chat-history.action");

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
});

describe("updateConversation", () => {
  test("wraps the delete-and-reinsert in a committed transaction", async () => {
    await updateConversation(conversation as never);

    const statements = sql();
    expect(statements[0]).toBe("BEGIN");
    expect(statements[statements.length - 1]).toBe("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
    expect(
      statements.filter((s) => s.startsWith("INSERT INTO messages")),
    ).toHaveLength(2);
  });

  test("rolls back and rethrows when a message insert fails", async () => {
    dbExecute.mockImplementation((statement: string) =>
      statement.startsWith("INSERT INTO messages")
        ? Promise.reject(new Error("disk I/O error"))
        : Promise.resolve({ rowsAffected: 1 }),
    );

    await expect(updateConversation(conversation as never)).rejects.toThrow(
      "disk I/O error",
    );

    const statements = sql();
    expect(statements[0]).toBe("BEGIN");
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  test("rolls back when the conversation row is missing", async () => {
    dbExecute.mockImplementation((statement: string) =>
      statement.startsWith("UPDATE conversations")
        ? Promise.resolve({ rowsAffected: 0 })
        : Promise.resolve({ rowsAffected: 1 }),
    );

    await expect(updateConversation(conversation as never)).rejects.toThrow(
      "Conversation not found",
    );

    const statements = sql();
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain(
      "DELETE FROM messages WHERE conversation_id = ?",
    );
  });
});
