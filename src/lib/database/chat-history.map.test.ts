import { describe, expect, test } from "vitest";
import {
  rowsToSummaries,
  rowsToConversations,
  DbConversation,
  DbMessage,
} from "./chat-history.map";

const conv = (over: Partial<DbConversation>): DbConversation => ({
  id: "c1",
  title: "Session",
  created_at: 100,
  updated_at: 200,
  ...over,
});

const msg = (over: Partial<DbMessage>): DbMessage => ({
  id: "m1",
  conversation_id: "c1",
  role: "user",
  content: "hi",
  timestamp: 150,
  attached_files: null,
  ...over,
});

describe("rowsToConversations", () => {
  test("groups messages under their conversation, preserving conversation order", () => {
    const result = rowsToConversations(
      [conv({ id: "c1" }), conv({ id: "c2" })],
      [
        msg({ id: "m1", conversation_id: "c1", content: "a" }),
        msg({ id: "m2", conversation_id: "c2", content: "b" }),
        msg({ id: "m3", conversation_id: "c1", content: "c" }),
      ]
    );

    expect(result.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(result[0].messages.map((m) => m.content)).toEqual(["a", "c"]);
    expect(result[1].messages.map((m) => m.content)).toEqual(["b"]);
  });

  test("a conversation with no messages gets an empty messages array", () => {
    const result = rowsToConversations([conv({ id: "c1" })], []);
    expect(result[0].messages).toEqual([]);
  });

  test("maps snake_case db fields to the camelCase conversation shape", () => {
    const result = rowsToConversations(
      [conv({ id: "c1", title: "T", created_at: 11, updated_at: 22 })],
      [msg({ id: "m1", role: "assistant", content: "yo", timestamp: 33 })]
    );

    expect(result[0]).toMatchObject({
      id: "c1",
      title: "T",
      createdAt: 11,
      updatedAt: 22,
    });
    expect(result[0].messages[0]).toMatchObject({
      id: "m1",
      role: "assistant",
      content: "yo",
      timestamp: 33,
    });
  });

  test("parses attached_files JSON into attachedFiles", () => {
    const result = rowsToConversations(
      [conv({ id: "c1" })],
      [msg({ id: "m1", attached_files: '[{"name":"a.png"}]' })]
    );
    expect(result[0].messages[0].attachedFiles).toEqual([{ name: "a.png" }]);
  });

  test("null attached_files becomes undefined", () => {
    const result = rowsToConversations(
      [conv({ id: "c1" })],
      [msg({ id: "m1", attached_files: null })]
    );
    expect(result[0].messages[0].attachedFiles).toBeUndefined();
  });
});

describe("rowsToSummaries", () => {
  test("lists a conversation with its count and no messages", () => {
    expect(
      rowsToSummaries([{ ...conv({ id: "a", title: "Call" }), message_count: 42 }]),
    ).toEqual([
      {
        id: "a",
        title: "Call",
        createdAt: 100,
        updatedAt: 200,
        messages: [],
        messageCount: 42,
      },
    ]);
  });

  test("counts a conversation with no messages, or an unreadable count, as zero", () => {
    const rows = rowsToSummaries([
      { ...conv({ id: "a" }), message_count: 0 },
      { ...conv({ id: "b" }), message_count: null as unknown as number },
    ]);
    expect(rows.map((row) => row.messageCount)).toEqual([0, 0]);
  });

  test("keeps the order it was given", () => {
    const rows = rowsToSummaries([
      { ...conv({ id: "new" }), message_count: 1 },
      { ...conv({ id: "old" }), message_count: 2 },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["new", "old"]);
  });
});
