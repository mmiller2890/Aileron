import { describe, expect, test, vi, beforeEach } from "vitest";

const { invokeMock, getDatabaseMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  getDatabaseMock: vi.fn(),
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

const { createConversation, updateConversation, saveConversation } =
  await import("./chat-history.action");

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

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  getDatabaseMock.mockReset();
});

describe("native save delegation", () => {
  test("updateConversation delegates to the native command and returns the input conversation", async () => {
    const result = await updateConversation(conversation as never);

    expect(invokeMock).toHaveBeenCalledWith("db_save_conversation", {
      conversation: expect.objectContaining({
        id: "c1",
        title: "Title",
        createdAt: 1,
        updatedAt: 2,
      }),
      operation: "update",
    });
    expect(result).toBe(conversation);
  });

  test("createConversation delegates with the create operation", async () => {
    await createConversation(conversation as never);

    expect(invokeMock).toHaveBeenCalledWith("db_save_conversation", {
      conversation: expect.objectContaining({ id: "c1" }),
      operation: "create",
    });
  });

  test("saveConversation delegates with the upsert operation", async () => {
    await saveConversation(conversation as never);

    expect(invokeMock).toHaveBeenCalledWith("db_save_conversation", {
      conversation: expect.objectContaining({ id: "c1" }),
      operation: "upsert",
    });
  });

  test("propagates native command errors", async () => {
    invokeMock.mockRejectedValue(new Error("Conversation not found"));

    await expect(updateConversation(conversation as never)).rejects.toThrow(
      "Conversation not found",
    );
  });

  test("rejects invalid conversations without invoking the native command", async () => {
    await expect(
      updateConversation({ id: "c1" } as never),
    ).rejects.toThrow("Invalid conversation data");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("payload carries only valid messages", async () => {
    const mixed = {
      ...conversation,
      messages: [
        ...conversation.messages,
        { id: "m3", role: "nope", content: "bad", timestamp: 300 },
      ],
    };

    await createConversation(mixed as never);

    const payload = invokeMock.mock.calls[0][1].conversation;
    expect(payload.messages.map((m: { id: string }) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });
});