import { ChatConversation } from "@/types";

/**
 * Pure row-mapping for chat history. Kept free of any Tauri/DB imports so it
 * can be unit-tested in the node environment and shared by every query that
 * reads conversations + messages (getAllConversations, getRecentConversations).
 */

/** Database conversation row (flattened for SQL). */
export interface DbConversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

/** Database message row (flattened for SQL). */
export interface DbMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  attached_files: string | null; // JSON string
  /** Absent on rows read before the speaker migration ran. */
  speaker?: string | null;
}

/** Safely parse a JSON column, returning `fallback` on null/invalid input. */
export function safeJsonParse<T>(jsonString: string | null, fallback: T): T {
  if (!jsonString) return fallback;
  try {
    return JSON.parse(jsonString) as T;
  } catch (error) {
    console.error("Failed to parse JSON:", error);
    return fallback;
  }
}

/**
 * Assemble conversation rows + their message rows into `ChatConversation`s.
 * Conversation order is preserved from the input; each conversation's messages
 * keep the order they arrive in (callers order by timestamp in SQL). A
 * conversation with no matching messages gets an empty array.
 */
export function rowsToConversations(
  conversations: DbConversation[],
  messages: DbMessage[]
): ChatConversation[] {
  const messagesByConversation = new Map<string, DbMessage[]>();
  for (const msg of messages) {
    if (!messagesByConversation.has(msg.conversation_id)) {
      messagesByConversation.set(msg.conversation_id, []);
    }
    messagesByConversation.get(msg.conversation_id)!.push(msg);
  }

  return conversations.map((conv) => ({
    id: conv.id,
    title: conv.title,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    messages:
      messagesByConversation.get(conv.id)?.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        attachedFiles: safeJsonParse(msg.attached_files, undefined),
        ...(msg.speaker ? { speaker: msg.speaker } : {}),
      })) || [],
  }));
}
