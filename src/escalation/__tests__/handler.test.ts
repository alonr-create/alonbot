import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../db/schema.js';

// Mock dependencies before importing handler
vi.mock('../../notifications/telegram.js', () => ({
  notifyAlon: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../monday/api.js', () => ({
  updateMondayStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../escalation/summary.js', () => ({
  generateEscalationSummary: vi.fn().mockResolvedValue('1. Wants a website\n2. Budget ~5000 NIS\n3. Worried about timeline'),
}));

vi.mock('../../db/index.js', () => {
  let mockDb: Database.Database;
  return {
    getDb: () => mockDb,
    _setMockDb: (db: Database.Database) => { mockDb = db; },
  };
});

describe('escalation handler', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // Insert a test lead
    db.prepare('INSERT INTO leads (phone, name, status) VALUES (?, ?, ?)').run(
      '972501234567', 'Test Lead', 'in-conversation',
    );

    // Set the mock DB
    const { _setMockDb } = await import('../../db/index.js') as any;
    _setMockDb(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('incrementEscalationCount increments escalation_count by phone', async () => {
    const { incrementEscalationCount } = await import('../handler.js');
    const count1 = incrementEscalationCount('972501234567');
    expect(count1).toBe(1);
    const count2 = incrementEscalationCount('972501234567');
    expect(count2).toBe(2);
  });

  it('resetEscalationCount sets escalation_count to 0', async () => {
    const { incrementEscalationCount, resetEscalationCount } = await import('../handler.js');
    incrementEscalationCount('972501234567');
    incrementEscalationCount('972501234567');
    resetEscalationCount('972501234567');

    const lead = db.prepare('SELECT escalation_count FROM leads WHERE phone = ?').get('972501234567') as any;
    expect(lead.escalation_count).toBe(0);
  });

  it('shouldEscalate returns true when escalation_count >= 3', async () => {
    const { incrementEscalationCount, shouldEscalate } = await import('../handler.js');
    incrementEscalationCount('972501234567');
    incrementEscalationCount('972501234567');
    incrementEscalationCount('972501234567');

    const result = shouldEscalate('972501234567', 'hello');
    expect(result.escalate).toBe(true);
    expect(result.reason).toBe('count');
  });

  it('shouldEscalate returns true when message matches human-request patterns', async () => {
    const { shouldEscalate } = await import('../handler.js');

    const patterns = ['תן לי לדבר עם אדם', 'אני רוצה נציג', 'תעביר אותי לאלון', 'מישהו אמיתי', 'בן אדם'];
    for (const text of patterns) {
      const result = shouldEscalate('972501234567', text);
      expect(result.escalate, `expected escalate=true for "${text}"`).toBe(true);
      expect(result.reason).toBe('human-request');
    }
  });

  it('shouldEscalate returns false when count < 3 and no human request', async () => {
    const { shouldEscalate } = await import('../handler.js');
    const result = shouldEscalate('972501234567', 'כמה עולה אתר?');
    expect(result.escalate).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('triggerEscalation calls summary, notifyAlon, and updates statuses', async () => {
    const { triggerEscalation } = await import('../handler.js');
    const { notifyAlon } = await import('../../notifications/telegram.js');
    const { generateEscalationSummary } = await import('../summary.js');
    const { updateMondayStatus } = await import('../../monday/api.js');

    const mockSock = {
      sendMessage: vi.fn().mockResolvedValue({}),
      sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    };

    const messages = [
      { role: 'user' as const, content: 'I want a website' },
      { role: 'assistant' as const, content: 'Great! What kind?' },
    ];

    await triggerEscalation(
      '972501234567', 'Test Lead', messages, mockSock as any, 123, 456,
    );

    expect(generateEscalationSummary).toHaveBeenCalledWith(messages, 'Test Lead');
    expect(notifyAlon).toHaveBeenCalled();

    // Check DB status updated
    const lead = db.prepare('SELECT status FROM leads WHERE phone = ?').get('972501234567') as any;
    expect(lead.status).toBe('escalated');

    // Monday.com update called
    expect(updateMondayStatus).toHaveBeenCalledWith(123, 456, 'escalated');
  });

  it('triggerEscalation never throws on error', async () => {
    const { triggerEscalation } = await import('../handler.js');

    // Make everything fail
    const { notifyAlon } = await import('../../notifications/telegram.js');
    (notifyAlon as any).mockRejectedValue(new Error('telegram down'));

    const mockSock = {
      sendMessage: vi.fn().mockRejectedValue(new Error('whatsapp down')),
      sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      triggerEscalation('972501234567', 'Test Lead', [], mockSock as any),
    ).resolves.not.toThrow();
  });
});
