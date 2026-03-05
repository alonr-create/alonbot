import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { config } from './config.js';
import { mkdirSync } from 'fs';

mkdirSync(config.dataDir, { recursive: true });

const db: DatabaseType = new Database(`${config.dataDir}/alonbot.db`);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cron_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    channel TEXT NOT NULL,
    target_id TEXT NOT NULL,
    message TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'fact',
    category TEXT,
    content TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 5,
    source TEXT DEFAULT 'user_told',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed TEXT,
    access_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS conversation_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    topics TEXT,
    message_count INTEGER,
    from_date TEXT,
    to_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, sender_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type, category);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_summaries_channel ON conversation_summaries(channel, sender_id, created_at);
`);

// Migration: move old facts table data into memories if facts table exists
try {
  const factsExist = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='facts'"
  ).get();
  if (factsExist) {
    const oldFacts = db.prepare('SELECT key, value, updated_at FROM facts').all() as Array<{ key: string; value: string; updated_at: string }>;
    if (oldFacts.length > 0) {
      const insertMemory = db.prepare(
        `INSERT INTO memories (type, category, content, importance, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const migrate = db.transaction(() => {
        for (const fact of oldFacts) {
          insertMemory.run('fact', 'personal', `${fact.key}: ${fact.value}`, 5, 'migrated', fact.updated_at);
        }
      });
      migrate();
      console.log(`[DB] Migrated ${oldFacts.length} facts to memories table`);
    }
    db.exec('DROP TABLE facts');
    console.log('[DB] Dropped old facts table');
  }
} catch {
  // facts table doesn't exist or already migrated — ok
}

export { db };
