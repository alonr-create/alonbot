import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      source TEXT DEFAULT 'whatsapp',
      status TEXT NOT NULL DEFAULT 'new'
        CHECK(status IN ('new', 'contacted', 'in-conversation', 'quote-sent',
                          'meeting-scheduled', 'escalated', 'closed-won', 'closed-lost')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      phone TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, created_at);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
  `);

  // Idempotent migration: add Monday.com columns to leads
  const migrations = [
    'ALTER TABLE leads ADD COLUMN monday_item_id INTEGER',
    'ALTER TABLE leads ADD COLUMN monday_board_id INTEGER',
    'ALTER TABLE leads ADD COLUMN interest TEXT',
    'ALTER TABLE leads ADD COLUMN escalation_count INTEGER DEFAULT 0',
    "ALTER TABLE leads ADD COLUMN notes TEXT DEFAULT ''",
  ];

  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists — expected on subsequent runs
    }
  }

  // Follow-ups table for automated re-engagement
  db.exec(`
    CREATE TABLE IF NOT EXISTS follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message_number INTEGER NOT NULL CHECK(message_number IN (1, 2, 3)),
      scheduled_at TEXT NOT NULL,
      sent_at TEXT,
      cancelled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_follow_ups_due
      ON follow_ups(scheduled_at) WHERE sent_at IS NULL AND cancelled = 0;
    CREATE INDEX IF NOT EXISTS idx_follow_ups_phone
      ON follow_ups(phone) WHERE sent_at IS NULL AND cancelled = 0;
  `);
}
