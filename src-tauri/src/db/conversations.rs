use serde::Deserialize;
use sqlx::{Pool, Sqlite};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

const DB_URL: &str = "sqlite:assistant.db";

#[derive(Debug)]
pub(crate) enum ConversationError {
    Invalid(String),
    AlreadyExists(String),
    NotFound(String),
    Database(sqlx::Error),
}

impl std::fmt::Display for ConversationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(detail) => write!(f, "invalid conversation: {detail}"),
            Self::AlreadyExists(id) => write!(f, "conversation already exists: {id}"),
            Self::NotFound(id) => write!(f, "Conversation not found: {id}"),
            Self::Database(error) => write!(f, "conversation save failed: {error}"),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationInput {
    id: String,
    title: String,
    messages: Vec<MessageInput>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageInput {
    id: String,
    role: String,
    content: String,
    timestamp: i64,
    attached_files: Option<serde_json::Value>,
    #[serde(default)]
    speaker: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Operation {
    Create,
    Update,
    Upsert,
}

fn validate(conversation: &ConversationInput) -> Result<(), ConversationError> {
    if conversation.id.trim().is_empty() {
        return Err(ConversationError::Invalid("missing id".to_string()));
    }
    if conversation.title.trim().is_empty() {
        return Err(ConversationError::Invalid("missing title".to_string()));
    }
    for message in &conversation.messages {
        if message.id.trim().is_empty() {
            return Err(ConversationError::Invalid(
                "message missing id".to_string(),
            ));
        }
        if !matches!(
            message.role.as_str(),
            "user" | "assistant" | "system"
        ) {
            return Err(ConversationError::Invalid(format!(
                "invalid message role: {}",
                message.role
            )));
        }
        if message.timestamp < 0 {
            return Err(ConversationError::Invalid(format!(
                "invalid message timestamp: {}",
                message.timestamp
            )));
        }
    }
    Ok(())
}

pub(crate) async fn apply_conversation(
    pool: &Pool<Sqlite>,
    conversation: &ConversationInput,
    operation: Operation,
) -> Result<(), ConversationError> {
    validate(conversation)?;

    // IMMEDIATE takes the write lock up front. A deferred transaction reads
    // first and upgrades on the first write, and SQLite fails that upgrade
    // with SQLITE_BUSY (no busy_timeout wait) when another save got there
    // first, so overlapping saves were rejected instead of queued.
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(ConversationError::Database)?;

    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM conversations WHERE id = ?")
            .bind(&conversation.id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ConversationError::Database)?;

    match operation {
        Operation::Create if exists.is_some() => {
            return Err(ConversationError::AlreadyExists(
                conversation.id.clone(),
            ))
        }
        Operation::Update if exists.is_none() => {
            return Err(ConversationError::NotFound(conversation.id.clone()))
        }
        _ => {}
    }

    if exists.is_none() {
        sqlx::query(
            "INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(&conversation.id)
        .bind(&conversation.title)
        .bind(conversation.created_at)
        .bind(conversation.updated_at)
        .execute(&mut *tx)
        .await
        .map_err(ConversationError::Database)?;
    } else {
        let result =
            sqlx::query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
                .bind(&conversation.title)
                .bind(conversation.updated_at)
                .bind(&conversation.id)
                .execute(&mut *tx)
                .await
                .map_err(ConversationError::Database)?;
        if result.rows_affected() == 0 {
            return Err(ConversationError::NotFound(conversation.id.clone()));
        }
    }

    sqlx::query("DELETE FROM messages WHERE conversation_id = ?")
        .bind(&conversation.id)
        .execute(&mut *tx)
        .await
        .map_err(ConversationError::Database)?;

    for message in &conversation.messages {
        let attached_files = message
            .attached_files
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| {
                ConversationError::Invalid(format!("attached files: {error}"))
            })?;
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, attached_files, speaker) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&message.id)
        .bind(&conversation.id)
        .bind(&message.role)
        .bind(&message.content)
        .bind(message.timestamp)
        .bind(attached_files)
        .bind(message.speaker.as_deref().filter(|speaker| !speaker.is_empty()))
        .execute(&mut *tx)
        .await
        .map_err(ConversationError::Database)?;
    }

    tx.commit().await.map_err(ConversationError::Database)?;
    Ok(())
}

#[tauri::command]
pub async fn db_save_conversation(
    db_instances: State<'_, DbInstances>,
    conversation: ConversationInput,
    operation: Operation,
) -> Result<(), String> {
    let pool = {
        let instances = db_instances.0.read().await;
        match instances.get(DB_URL) {
            Some(DbPool::Sqlite(pool)) => pool.clone(),
            _ => {
                return Err(format!(
                    "database not loaded or unsupported: {DB_URL}"
                ))
            }
        }
    };

    apply_conversation(&pool, &conversation, operation)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::path::PathBuf;
    use std::str::FromStr;

    async fn test_pool(max_connections: u32) -> (Pool<Sqlite>, PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "aileron-conversations-test-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::from_str(&format!(
            "sqlite:{}",
            path.display()
        ))
        .unwrap()
        .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(max_connections)
            .connect_lazy_with(options);
        sqlx::raw_sql(include_str!("migrations/chat-history.sql"))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("migrations/chat-history-speaker.sql"))
            .execute(&pool)
            .await
            .unwrap();
        (pool, path)
    }

    fn cleanup(path: &PathBuf) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }

    fn message(id: &str, content: &str, timestamp: i64) -> MessageInput {
        MessageInput {
            id: id.to_string(),
            role: "user".to_string(),
            content: content.to_string(),
            timestamp,
            attached_files: None,
            speaker: None,
        }
    }

    fn conversation(
        id: &str,
        title: &str,
        messages: Vec<MessageInput>,
    ) -> ConversationInput {
        ConversationInput {
            id: id.to_string(),
            title: title.to_string(),
            messages,
            created_at: 1,
            updated_at: 2,
        }
    }

    async fn fetch_conversation(
        pool: &Pool<Sqlite>,
        id: &str,
    ) -> (String, Vec<String>) {
        let (title,): (String,) =
            sqlx::query_as("SELECT title FROM conversations WHERE id = ?")
                .bind(id)
                .fetch_one(pool)
                .await
                .unwrap();
        let messages: Vec<(String,)> = sqlx::query_as(
            "SELECT id FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
        )
        .bind(id)
        .fetch_all(pool)
        .await
        .unwrap();
        (title, messages.into_iter().map(|m| m.0).collect())
    }

    async fn seed(pool: &Pool<Sqlite>, sql: &str) {
        sqlx::query(sql).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn failed_message_insert_rolls_back_and_keeps_old_history() {
        let (pool, path) = test_pool(1).await;

        seed(&pool, "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Old title', 1, 2)").await;
        seed(&pool, "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('m-old', 'c1', 'user', 'old', 100)").await;
        seed(&pool, "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c2', 'Other', 1, 2)").await;
        seed(&pool, "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('m-collide', 'c2', 'user', 'other', 100)").await;

        let update = conversation(
            "c1",
            "New title",
            vec![
                message("m-new", "new content", 200),
                message("m-collide", "duplicate id", 201),
            ],
        );

        let result = apply_conversation(&pool, &update, Operation::Upsert).await;
        assert!(result.is_err());

        let (title, messages) = fetch_conversation(&pool, "c1").await;
        assert_eq!(title, "Old title");
        assert_eq!(messages, vec!["m-old".to_string()]);

        cleanup(&path);
    }

    #[tokio::test]
    async fn concurrent_saves_cannot_interleave() {
        let (pool, path) = test_pool(5).await;

        seed(&pool, "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Old title', 1, 2)").await;
        seed(&pool, "INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('m-old', 'c1', 'user', 'old', 100)").await;

        let save_a = conversation(
            "c1",
            "Title A",
            vec![message("a1", "a", 1), message("a2", "a", 2)],
        );
        let save_b = conversation(
            "c1",
            "Title B",
            vec![message("b1", "b", 3), message("b2", "b", 4)],
        );

        let (result_a, result_b) = tokio::join!(
            apply_conversation(&pool, &save_a, Operation::Upsert),
            apply_conversation(&pool, &save_b, Operation::Upsert)
        );

        // Overlapping saves must be serialized, not rejected: a save that
        // loses the lock race is a dropped save for the user.
        assert!(result_a.is_ok(), "save A failed: {result_a:?}");
        assert!(result_b.is_ok(), "save B failed: {result_b:?}");

        let (title, messages) = fetch_conversation(&pool, "c1").await;
        let complete_a = title == "Title A"
            && messages == vec!["a1".to_string(), "a2".to_string()];
        let complete_b = title == "Title B"
            && messages == vec!["b1".to_string(), "b2".to_string()];
        assert!(
            complete_a || complete_b,
            "final content is a mixture: {title:?} {messages:?} (results: {result_a:?}, {result_b:?})"
        );

        cleanup(&path);
    }

    #[tokio::test]
    async fn create_update_upsert_round_trips() {
        let (pool, path) = test_pool(1).await;

        let attached = serde_json::json!([
            {
                "id": "f1",
                "name": "notes.txt",
                "type": "text/plain",
                "base64": "aGk=",
                "size": 2
            }
        ]);
        let created = ConversationInput {
            id: "c-new".to_string(),
            title: "Created".to_string(),
            messages: vec![MessageInput {
                id: "m1".to_string(),
                role: "user".to_string(),
                content: "hello".to_string(),
                timestamp: 5,
                attached_files: Some(attached.clone()),
                speaker: Some("Speaker 2".to_string()),
            }],
            created_at: 1,
            updated_at: 2,
        };

        apply_conversation(&pool, &created, Operation::Create)
            .await
            .unwrap();

        let (title, created_at, updated_at): (String, i64, i64) =
            sqlx::query_as(
                "SELECT title, created_at, updated_at FROM conversations WHERE id = ?",
            )
            .bind("c-new")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(title.as_str(), "Created");
        assert_eq!(created_at, 1);
        assert_eq!(updated_at, 5);

        let (attached_files, timestamp, speaker): (Option<String>, i64, Option<String>) =
            sqlx::query_as(
                "SELECT attached_files, timestamp, speaker FROM messages WHERE id = ?",
            )
            .bind("m1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(timestamp, 5);
        assert_eq!(speaker.as_deref(), Some("Speaker 2"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&attached_files.unwrap())
                .unwrap(),
            attached
        );

        assert!(matches!(
            apply_conversation(&pool, &created, Operation::Create).await,
            Err(ConversationError::AlreadyExists(_))
        ));

        assert!(matches!(
            apply_conversation(
                &pool,
                &conversation("c-missing", "Missing", vec![]),
                Operation::Update
            )
            .await,
            Err(ConversationError::NotFound(_))
        ));

        apply_conversation(
            &pool,
            &conversation("c-up", "Upserted", vec![message("um1", "x", 1)]),
            Operation::Upsert,
        )
        .await
        .unwrap();
        let (title, messages) = fetch_conversation(&pool, "c-up").await;
        assert_eq!(title, "Upserted");
        assert_eq!(messages, vec!["um1".to_string()]);

        apply_conversation(
            &pool,
            &conversation("c-new", "Updated", vec![message("m2", "again", 9)]),
            Operation::Update,
        )
        .await
        .unwrap();
        let (title, messages) = fetch_conversation(&pool, "c-new").await;
        assert_eq!(title, "Updated");
        assert_eq!(messages, vec!["m2".to_string()]);
        let (attached_files,): (Option<String>,) =
            sqlx::query_as("SELECT attached_files FROM messages WHERE id = ?")
                .bind("m2")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(attached_files.is_none());

        cleanup(&path);
    }

    #[tokio::test]
    async fn rejects_invalid_input_before_touching_the_database() {
        let (pool, path) = test_pool(1).await;

        let mut bad = conversation("c-bad", "Bad", vec![message("m1", "x", 1)]);
        bad.messages[0].role = "nope".to_string();
        assert!(matches!(
            apply_conversation(&pool, &bad, Operation::Create).await,
            Err(ConversationError::Invalid(_))
        ));

        assert!(matches!(
            apply_conversation(
                &pool,
                &conversation(" ", "Empty id", vec![]),
                Operation::Create
            )
            .await,
            Err(ConversationError::Invalid(_))
        ));

        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM conversations")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0);

        cleanup(&path);
    }
}