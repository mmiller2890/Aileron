import Database from "@tauri-apps/plugin-sql";

/**
 * Database configuration
 */
export const DB_NAME = "sqlite:assistant.db";

let dbInstance: Database | null = null;
let dbLoadPromise: Promise<Database> | null = null;

/**
 * Get database instance
 */
export async function getDatabase(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  if (!dbLoadPromise) {
    dbLoadPromise = Database.load(DB_NAME).then(
      (db) => {
        dbInstance = db;
        return db;
      },
      (error) => {
        dbLoadPromise = null;
        throw new Error(
          `Failed to initialize database: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  }

  return dbLoadPromise;
}
