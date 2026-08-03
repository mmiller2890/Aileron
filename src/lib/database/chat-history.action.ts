import { getDatabase } from "./config";
import { ChatConversation } from "@/types";
import { safeLocalStorage } from "@/lib";
import {
  DbConversation,
  DbMessage,
  rowsToConversations,
  safeJsonParse,
} from "./chat-history.map";

// Legacy localStorage key for migration purposes
const LEGACY_CHAT_HISTORY_KEY = "chat_history";

/**
 * Validate conversation data
 */
function validateConversation(conversation: ChatConversation): boolean {
  if (!conversation.id || typeof conversation.id !== "string") {
    console.error("Invalid conversation: missing or invalid id");
    return false;
  }
  if (!conversation.title || typeof conversation.title !== "string") {
    console.error("Invalid conversation: missing or invalid title");
    return false;
  }
  if (!Array.isArray(conversation.messages)) {
    console.error("Invalid conversation: messages is not an array");
    return false;
  }
  return true;
}

/**
 * Validate message data
 */
function validateMessage(message: any): boolean {
  if (!message.id || typeof message.id !== "string") {
    console.error("Invalid message: missing or invalid id");
    return false;
  }
  if (
    !message.role ||
    !["user", "assistant", "system"].includes(message.role)
  ) {
    console.error("Invalid message: missing or invalid role");
    return false;
  }
  if (typeof message.content !== "string") {
    console.error("Invalid message: content must be a string");
    return false;
  }
  if (typeof message.timestamp !== "number" || message.timestamp < 0) {
    console.error("Invalid message: invalid timestamp");
    return false;
  }
  return true;
}

/**
 * Create a new conversation with transaction safety
 */
export async function createConversation(
  conversation: ChatConversation
): Promise<ChatConversation> {
  if (!validateConversation(conversation)) {
    throw new Error("Invalid conversation data");
  }

  const db = await getDatabase();

  try {
    // Insert conversation
    await db.execute(
      "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [
        conversation.id,
        conversation.title,
        conversation.createdAt || Date.now(),
        conversation.updatedAt || Date.now(),
      ]
    );

    // Insert all messages
    for (const message of conversation.messages) {
      if (!validateMessage(message)) {
        console.warn("Skipping invalid message in conversation creation");
        continue;
      }

      const attachedFilesJson = message.attachedFiles
        ? JSON.stringify(message.attachedFiles)
        : null;

      await db.execute(
        "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files) VALUES (?, ?, ?, ?, ?, ?)",
        [
          message.id,
          conversation.id,
          message.role,
          message.content,
          message.timestamp,
          attachedFilesJson,
        ]
      );
    }

    return conversation;
  } catch (error) {
    console.error("Failed to create conversation:", error);
    // Rollback: delete conversation if message insertion failed
    await db
      .execute("DELETE FROM conversations WHERE id = ?", [conversation.id])
      .catch(() => {});
    throw error;
  }
}

/**
 * Default number of recent conversations the dashboard loads on focus. Covers
 * RecentSessions' 6-item list plus the fallback displayed session, with buffer,
 * without scanning the full history on every window focus.
 */
export const DEFAULT_RECENT_CONVERSATIONS_LIMIT = 15;

type Db = Awaited<ReturnType<typeof getDatabase>>;

/**
 * Fetch the messages for a set of conversation rows (one query) and assemble
 * them into `ChatConversation`s. Bounded by whatever conversation set is passed.
 */
async function assembleConversations(
  db: Db,
  conversations: DbConversation[]
): Promise<ChatConversation[]> {
  if (conversations.length === 0) {
    return [];
  }
  const conversationIds = conversations.map((c) => c.id);
  const placeholders = conversationIds.map(() => "?").join(",");
  const allMessages = await db.select<DbMessage[]>(
    `SELECT * FROM messages WHERE conversation_id IN (${placeholders}) ORDER BY conversation_id, timestamp ASC`,
    conversationIds
  );
  return rowsToConversations(conversations, allMessages);
}

/**
 * Get all conversations with messages. Scans the entire history — use only
 * where that is intended (e.g. the full Chats page). For the dashboard, prefer
 * `getRecentConversations`.
 */
export async function getAllConversations(): Promise<ChatConversation[]> {
  const db = await getDatabase();

  try {
    const conversations = await db.select<DbConversation[]>(
      "SELECT * FROM conversations ORDER BY updated_at DESC"
    );
    return await assembleConversations(db, conversations);
  } catch (error) {
    console.error("Failed to get all conversations:", error);
    throw error;
  }
}

/**
 * Get the most-recently-updated conversations (with messages), bounded by
 * `limit`. This is what the dashboard loads on focus so a large history doesn't
 * make every window focus reload the whole database.
 */
export async function getRecentConversations(
  limit = DEFAULT_RECENT_CONVERSATIONS_LIMIT
): Promise<ChatConversation[]> {
  const db = await getDatabase();

  try {
    const conversations = await db.select<DbConversation[]>(
      "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?",
      [limit]
    );
    return await assembleConversations(db, conversations);
  } catch (error) {
    console.error("Failed to get recent conversations:", error);
    throw error;
  }
}

/**
 * Get a single conversation by ID
 */
export async function getConversationById(
  id: string
): Promise<ChatConversation | null> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return null;
  }

  const db = await getDatabase();

  try {
    // Get conversation
    const conversations = await db.select<DbConversation[]>(
      "SELECT * FROM conversations WHERE id = ?",
      [id]
    );

    if (conversations.length === 0) {
      return null;
    }

    const conv = conversations[0];

    // Get messages
    const messages = await db.select<DbMessage[]>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
      [id]
    );

    return {
      id: conv.id,
      title: conv.title,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      messages: messages.map((msg) => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        attachedFiles: safeJsonParse(msg.attached_files, undefined),
      })),
    };
  } catch (error) {
    console.error(`Failed to get conversation ${id}:`, error);
    return null;
  }
}

/**
 * Update a conversation with transaction safety
 */
export async function updateConversation(
  conversation: ChatConversation
): Promise<ChatConversation> {
  if (!validateConversation(conversation)) {
    throw new Error("Invalid conversation data");
  }

  const db = await getDatabase();

  try {
    // Update conversation
    const updateResult = await db.execute(
      "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
      [conversation.title, conversation.updatedAt, conversation.id]
    );

    if (updateResult.rowsAffected === 0) {
      throw new Error("Conversation not found");
    }

    // Get existing messages for backup
    const existingMessages = await db.select<DbMessage[]>(
      "SELECT * FROM messages WHERE conversation_id = ?",
      [conversation.id]
    );

    // Delete existing messages
    await db.execute("DELETE FROM messages WHERE conversation_id = ?", [
      conversation.id,
    ]);

    // Insert updated messages
    try {
      for (const message of conversation.messages) {
        if (!validateMessage(message)) {
          console.warn("Skipping invalid message in conversation update");
          continue;
        }

        const attachedFilesJson = message.attachedFiles
          ? JSON.stringify(message.attachedFiles)
          : null;

        await db.execute(
          "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files) VALUES (?, ?, ?, ?, ?, ?)",
          [
            message.id,
            conversation.id,
            message.role,
            message.content,
            message.timestamp,
            attachedFilesJson,
          ]
        );
      }
    } catch (messageError) {
      // Rollback: restore original messages
      console.error(
        "Failed to insert new messages, restoring backup:",
        messageError
      );
      for (const msg of existingMessages) {
        await db
          .execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files) VALUES (?, ?, ?, ?, ?, ?)",
            [
              msg.id,
              msg.conversation_id,
              msg.role,
              msg.content,
              msg.timestamp,
              msg.attached_files,
            ]
          )
          .catch(() => {});
      }
      throw messageError;
    }

    return conversation;
  } catch (error) {
    console.error("Failed to update conversation:", error);
    throw error;
  }
}

/**
 * Save or update a conversation (upsert operation)
 */
export async function saveConversation(
  conversation: ChatConversation
): Promise<ChatConversation> {
  if (!validateConversation(conversation)) {
    throw new Error("Invalid conversation data");
  }

  try {
    const existing = await getConversationById(conversation.id);

    if (existing) {
      return await updateConversation(conversation);
    } else {
      return await createConversation(conversation);
    }
  } catch (error) {
    console.error("Failed to save conversation:", error);
    throw error;
  }
}

/**
 * Delete a conversation and all its messages
 */
export async function deleteConversation(id: string): Promise<boolean> {
  if (!id || typeof id !== "string") {
    console.error("Invalid conversation id");
    return false;
  }

  const db = await getDatabase();

  try {
    const result = await db.execute("DELETE FROM conversations WHERE id = ?", [
      id,
    ]);

    return result.rowsAffected > 0;
  } catch (error) {
    console.error(`Failed to delete conversation ${id}:`, error);
    throw error;
  }
}

/**
 * Delete all conversations and messages
 */
export async function deleteAllConversations(): Promise<void> {
  const db = await getDatabase();

  try {
    // Delete in correct order (messages first due to foreign key)
    await db.execute("DELETE FROM messages");
    await db.execute("DELETE FROM conversations");
  } catch (error) {
    console.error("Failed to delete all conversations:", error);
    throw error;
  }
}

/**
 * Return the user message as the conversation title
 */
export function generateConversationTitle(userMessage: string): string {
  return userMessage.trim();
}

/**
 * Migrate chat history from localStorage to SQLite
 * This function safely moves all existing localStorage chat history to the database
 */
export async function migrateLocalStorageToSQLite(): Promise<{
  success: boolean;
  migratedCount: number;
  error?: string;
}> {
  const migrationKey = "chat_history_migrated_to_sqlite";

  try {
    // Check if migration has already been done
    if (safeLocalStorage.getItem(migrationKey) === "true") {
      return { success: true, migratedCount: 0 };
    }

    // Get existing localStorage data
    const existingData = safeLocalStorage.getItem(LEGACY_CHAT_HISTORY_KEY);
    if (!existingData) {
      // No data to migrate
      safeLocalStorage.setItem(migrationKey, "true");
      return { success: true, migratedCount: 0 };
    }

    // Parse localStorage conversations
    let conversations: ChatConversation[] = [];
    try {
      const parsed = JSON.parse(existingData);
      conversations = Array.isArray(parsed) ? parsed : [];
    } catch (parseError) {
      console.error("Failed to parse localStorage chat history:", parseError);
      // Mark as migrated anyway to prevent repeated failures
      safeLocalStorage.setItem(migrationKey, "true");
      return {
        success: false,
        migratedCount: 0,
        error: "Failed to parse localStorage data",
      };
    }

    if (conversations.length === 0) {
      // No valid data to migrate
      safeLocalStorage.setItem(migrationKey, "true");
      return { success: true, migratedCount: 0 };
    }

    // Get database instance
    const db = await getDatabase();

    // Migrate each conversation
    let migratedCount = 0;
    let errorCount = 0;

    for (const conversation of conversations) {
      try {
        // Validate conversation data
        if (!conversation?.id || !conversation?.title) {
          console.warn("Skipping invalid conversation:", conversation);
          errorCount++;
          continue;
        }

        // Check if conversation already exists in database
        const existing = await getConversationById(conversation.id);
        if (existing) {
          continue;
        }

        // Insert conversation
        await db.execute(
          "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
          [
            conversation.id,
            conversation.title,
            conversation.createdAt || Date.now(),
            conversation.updatedAt || Date.now(),
          ]
        );

        // Insert messages
        if (
          Array.isArray(conversation.messages) &&
          conversation.messages.length > 0
        ) {
          for (const message of conversation.messages) {
            // Validate message
            if (
              !message?.id ||
              !message?.role ||
              typeof message?.content !== "string"
            ) {
              console.warn(
                `Skipping invalid message in conversation ${conversation.id}:`,
                message
              );
              continue;
            }

            const attachedFilesJson = message.attachedFiles
              ? JSON.stringify(message.attachedFiles)
              : null;

            await db.execute(
              "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files) VALUES (?, ?, ?, ?, ?, ?)",
              [
                message.id,
                conversation.id,
                message.role,
                message.content,
                message.timestamp || Date.now(),
                attachedFilesJson,
              ]
            );
          }
        }

        migratedCount++;
      } catch (convError) {
        console.error(
          `Failed to migrate conversation ${conversation?.id}:`,
          convError
        );
        errorCount++;
        // Clean up partially migrated conversation
        await db
          .execute("DELETE FROM conversations WHERE id = ?", [conversation?.id])
          .catch(() => {});
      }
    }

    // Only declare the migration complete when every conversation landed: a
    // partial failure must keep the legacy data and the marker unset so a
    // later launch can retry the failed conversations.
    if (errorCount === 0) {
      safeLocalStorage.setItem(migrationKey, "true");
      safeLocalStorage.removeItem(LEGACY_CHAT_HISTORY_KEY);
    }

    return {
      success: errorCount === 0,
      migratedCount,
      error:
        errorCount > 0
          ? `${errorCount} conversations failed to migrate`
          : undefined,
    };
  } catch (error) {
    console.error("Migration failed:", error);
    // Mark as attempted to prevent infinite retry loops
    safeLocalStorage.setItem(migrationKey, "true");
    return {
      success: false,
      migratedCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
