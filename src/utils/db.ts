import Database, { type Database as DatabaseType } from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { mkdirSync } from 'fs';

const log = createLogger('db');

mkdirSync(config.dataDir, { recursive: true });

const db: DatabaseType = new Database(`${config.dataDir}/alonbot.db`);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Load sqlite-vec extension for vector search
sqliteVec.load(db);

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

  CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'cancelled')),
    priority INTEGER NOT NULL DEFAULT 5,
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT,
    message TEXT NOT NULL,
    send_at TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'telegram',
    target_id TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages(sent, send_at);

  CREATE TABLE IF NOT EXISTS tool_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 1,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tool_usage_date ON tool_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON tool_usage(tool_name);
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, sender_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type, category);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_summaries_channel ON conversation_summaries(channel, sender_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_api_usage_date ON api_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC);

  CREATE TABLE IF NOT EXISTS knowledge_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN ('url', 'pdf', 'text', 'file')),
    source_ref TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(doc_id, chunk_index);

  CREATE TABLE IF NOT EXISTS batch_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL UNIQUE,
    job_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
    result TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);

  CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    trigger_type TEXT NOT NULL CHECK(trigger_type IN ('keyword', 'cron', 'event')),
    trigger_value TEXT NOT NULL,
    actions TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    source TEXT NOT NULL DEFAULT 'voice_agent',
    monday_item_id TEXT,
    last_call_summary TEXT,
    last_call_sentiment TEXT,
    last_call_duration_sec INTEGER,
    was_booked INTEGER NOT NULL DEFAULT 0,
    call_mode TEXT,
    lead_status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
`);

// Vector table for semantic memory search (768-dim Gemini embedding)
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
    embedding float[768]
  );
`);

// Vector table for knowledge chunk search (768-dim Gemini embedding)
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vectors USING vec0(
    embedding float[768]
  );
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
      log.info({ count: oldFacts.length }, 'migrated facts to memories');
    }
    db.exec('DROP TABLE facts');
    log.info('dropped old facts table');
  }
} catch {
  // facts table doesn't exist or already migrated — ok
}

export { db };
