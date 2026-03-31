import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.js';
import { checkDbHealth } from '../index.js';

// Helper: create an in-memory DB with schema initialized
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

describe('Database Schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    initSchema(db);
  });

  describe('leads table', () => {
    it('creates leads table with expected columns', () => {
      const columns = db.pragma('table_info(leads)') as Array<{ name: string; type: string; notnull: number }>;
      const colNames = columns.map((c) => c.name);

      expect(colNames).toContain('id');
      expect(colNames).toContain('phone');
      expect(colNames).toContain('name');
      expect(colNames).toContain('source');
      expect(colNames).toContain('status');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('updated_at');
    });

    it('phone column has UNIQUE constraint', () => {
      db.prepare("INSERT INTO leads (phone) VALUES ('123')").run();
      expect(() => db.prepare("INSERT INTO leads (phone) VALUES ('123')").run()).toThrow();
    });

    it('status CHECK constraint rejects invalid values', () => {
      expect(() =>
        db.prepare("INSERT INTO leads (phone, status) VALUES ('999', 'invalid-status')").run()
      ).toThrow();
    });

    it('status defaults to new', () => {
      db.prepare("INSERT INTO leads (phone) VALUES ('555')").run();
      const lead = db.prepare("SELECT status FROM leads WHERE phone = '555'").get() as { status: string };
      expect(lead.status).toBe('new');
    });

    it('source defaults to whatsapp', () => {
      db.prepare("INSERT INTO leads (phone) VALUES ('777')").run();
      const lead = db.prepare("SELECT source FROM leads WHERE phone = '777'").get() as { source: string };
      expect(lead.source).toBe('whatsapp');
    });
  });

  describe('messages table', () => {
    it('creates messages table with expected columns', () => {
      const columns = db.pragma('table_info(messages)') as Array<{ name: string }>;
      const colNames = columns.map((c) => c.name);

      expect(colNames).toContain('id');
      expect(colNames).toContain('lead_id');
      expect(colNames).toContain('phone');
      expect(colNames).toContain('direction');
      expect(colNames).toContain('content');
      expect(colNames).toContain('created_at');
    });

    it('direction CHECK constraint rejects invalid values', () => {
      expect(() =>
        db.prepare("INSERT INTO messages (phone, direction, content) VALUES ('123', 'invalid', 'test')").run()
      ).toThrow();
    });

    it('accepts valid direction values', () => {
      db.prepare("INSERT INTO messages (phone, direction, content) VALUES ('123', 'in', 'hello')").run();
      db.prepare("INSERT INTO messages (phone, direction, content) VALUES ('123', 'out', 'hi back')").run();
      const count = db.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });
  });

  describe('indexes', () => {
    it('creates expected indexes', () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);

      expect(names).toContain('idx_messages_phone');
      expect(names).toContain('idx_leads_status');
      expect(names).toContain('idx_leads_phone');
    });
  });

  describe('checkDbHealth', () => {
    it('returns true when DB is accessible', () => {
      expect(checkDbHealth(db)).toBe(true);
    });

    it('returns false when DB is closed', () => {
      db.close();
      expect(checkDbHealth(db)).toBe(false);
    });
  });
});

describe('Tenants table and migrations', () => {
  it('initSchema creates tenants table with required columns', () => {
    const db = makeDb();
    const columns = db.pragma('table_info(tenants)') as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('wa_phone_number_id');
    expect(colNames).toContain('wa_number');
    expect(colNames).toContain('monday_board_id');
    expect(colNames).toContain('admin_phone');
    expect(colNames).toContain('wa_cloud_token');
    expect(colNames).toContain('active');
  });

  it('leads table has tenant_id column after migration', () => {
    const db = makeDb();
    const columns = db.pragma('table_info(leads)') as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('tenant_id');
  });

  it('messages table has tenant_id column after migration', () => {
    const db = makeDb();
    const columns = db.pragma('table_info(messages)') as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('tenant_id');
  });

  it('follow_ups table has tenant_id column after migration', () => {
    const db = makeDb();
    const columns = db.pragma('table_info(follow_ups)') as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('tenant_id');
  });

  it('bot_rules table has tenant_id column after migration', () => {
    const db = makeDb();
    const columns = db.pragma('table_info(bot_rules)') as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('tenant_id');
  });

  it('existing leads are backfilled with דקל tenant_id', () => {
    // Insert a lead BEFORE initSchema so it has no tenant_id, then re-run
    // Actually in a fresh DB with initSchema run, inserts default tenant_id = null
    // The backfill should fill tenant_id for new leads with null
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    // First run: creates schema
    initSchema(db);
    // Insert a lead that could represent a pre-existing row (tenant_id should be set)
    db.prepare("INSERT INTO leads (phone, tenant_id) VALUES ('99999', NULL)").run();
    // Run initSchema again (idempotent) to trigger backfill
    initSchema(db);
    const lead = db.prepare("SELECT tenant_id FROM leads WHERE phone = '99999'").get() as { tenant_id: number | null };
    // After backfill, tenant_id should be the דקל tenant id
    expect(lead.tenant_id).not.toBeNull();
  });
});
