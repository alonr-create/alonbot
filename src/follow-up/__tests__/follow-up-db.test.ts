import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../db/schema.js';

// Mock config to control alonPhone
vi.mock('../../config.js', () => ({
  config: {
    alonPhone: '972546300783',
  },
}));

// Mock getDb to return our in-memory DB
vi.mock('../../db/index.js', () => {
  let mockDb: Database.Database;
  return {
    getDb: () => mockDb,
    _setMockDb: (db: Database.Database) => { mockDb = db; },
  };
});

describe('follow-up DB operations', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    initSchema(db);

    const { _setMockDb } = await import('../../db/index.js') as any;
    _setMockDb(db);

    // Insert test leads
    db.prepare('INSERT INTO leads (phone, name, status, interest) VALUES (?, ?, ?, ?)').run(
      '972501234567', 'David Cohen', 'in-conversation', 'website',
    );
    db.prepare('INSERT INTO leads (phone, name, status, interest) VALUES (?, ?, ?, ?)').run(
      '972509876543', 'Sarah Levy', 'escalated', 'app',
    );
    db.prepare('INSERT INTO leads (phone, name, status, interest) VALUES (?, ?, ?, ?)').run(
      '972501111111', 'Moshe Green', 'new', 'automation',
    );
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe('scheduleFollowUp', () => {
    it('inserts a follow-up row into follow_ups table', async () => {
      const { scheduleFollowUp } = await import('../follow-up-db.js');
      const scheduledAt = new Date('2026-03-10T09:30:00Z');
      scheduleFollowUp('972501234567', 1, scheduledAt);

      const row = db.prepare('SELECT * FROM follow_ups WHERE phone = ?').get('972501234567') as any;
      expect(row).toBeTruthy();
      expect(row.phone).toBe('972501234567');
      expect(row.message_number).toBe(1);
      expect(row.sent_at).toBeNull();
      expect(row.cancelled).toBe(0);
    });

    it('skips scheduling for alonPhone', async () => {
      const { scheduleFollowUp } = await import('../follow-up-db.js');
      scheduleFollowUp('972546300783', 1, new Date('2026-03-10T09:30:00Z'));

      const row = db.prepare('SELECT * FROM follow_ups WHERE phone = ?').get('972546300783') as any;
      expect(row).toBeUndefined();
    });
  });

  describe('getDueFollowUps', () => {
    it('returns non-cancelled, non-sent follow-ups whose scheduled_at has passed', async () => {
      const { scheduleFollowUp, getDueFollowUps } = await import('../follow-up-db.js');
      // Schedule a follow-up in the past
      scheduleFollowUp('972501234567', 1, new Date('2020-01-01T09:00:00Z'));

      const due = getDueFollowUps();
      expect(due.length).toBe(1);
      expect(due[0].phone).toBe('972501234567');
      expect(due[0].message_number).toBe(1);
    });

    it('does NOT return follow-ups scheduled in the future', async () => {
      const { scheduleFollowUp, getDueFollowUps } = await import('../follow-up-db.js');
      scheduleFollowUp('972501234567', 1, new Date('2099-01-01T09:00:00Z'));

      const due = getDueFollowUps();
      expect(due.length).toBe(0);
    });

    it('does NOT return follow-ups for leads in terminal statuses', async () => {
      const { scheduleFollowUp, getDueFollowUps } = await import('../follow-up-db.js');
      // Sarah Levy is 'escalated' — terminal
      scheduleFollowUp('972509876543', 1, new Date('2020-01-01T09:00:00Z'));

      const due = getDueFollowUps();
      expect(due.length).toBe(0);
    });

    it('returns lead name and interest joined from leads table', async () => {
      const { scheduleFollowUp, getDueFollowUps } = await import('../follow-up-db.js');
      scheduleFollowUp('972501234567', 1, new Date('2020-01-01T09:00:00Z'));

      const due = getDueFollowUps();
      expect(due[0].name).toBe('David Cohen');
      expect(due[0].interest).toBe('website');
    });
  });

  describe('cancelFollowUps', () => {
    it('sets cancelled=1 for all pending follow-ups for a phone and returns count', async () => {
      const { scheduleFollowUp, cancelFollowUps } = await import('../follow-up-db.js');
      scheduleFollowUp('972501234567', 1, new Date('2026-03-10T09:00:00Z'));
      scheduleFollowUp('972501234567', 2, new Date('2026-03-12T09:00:00Z'));

      const count = cancelFollowUps('972501234567');
      expect(count).toBe(2);

      const rows = db.prepare('SELECT * FROM follow_ups WHERE phone = ? AND cancelled = 1').all('972501234567');
      expect(rows.length).toBe(2);
    });

    it('does not cancel already sent follow-ups', async () => {
      const { scheduleFollowUp, markFollowUpSent, cancelFollowUps } = await import('../follow-up-db.js');
      scheduleFollowUp('972501234567', 1, new Date('2020-01-01T09:00:00Z'));
      const row = db.prepare('SELECT id FROM follow_ups WHERE phone = ?').get('972501234567') as any;
      markFollowUpSent(row.id);

      scheduleFollowUp('972501234567', 2, new Date('2026-03-12T09:00:00Z'));
      const count = cancelFollowUps('972501234567');
      expect(count).toBe(1); // only the unsent one
    });
  });

  describe('markFollowUpSent', () => {
    it('sets sent_at to current time', async () => {
      const { scheduleFollowUp, markFollowUpSent } = await import('../follow-up-db.js');
      scheduleFollowUp('972501234567', 1, new Date('2020-01-01T09:00:00Z'));

      const row = db.prepare('SELECT id FROM follow_ups WHERE phone = ?').get('972501234567') as any;
      markFollowUpSent(row.id);

      const updated = db.prepare('SELECT sent_at FROM follow_ups WHERE id = ?').get(row.id) as any;
      expect(updated.sent_at).toBeTruthy();
    });
  });
});
