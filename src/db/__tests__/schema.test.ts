import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.js';
import { checkDbHealth } from '../index.js';

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
