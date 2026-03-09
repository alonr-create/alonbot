import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../db/schema.js';

// Mock dependencies
vi.mock('../../config.js', () => ({
  config: {
    alonPhone: '972546300783',
    nodeEnv: 'test',
  },
}));

vi.mock('../../db/index.js', () => {
  let mockDb: Database.Database;
  return {
    getDb: () => mockDb,
    _setMockDb: (db: Database.Database) => { mockDb = db; },
  };
});

vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../follow-up-ai.js', () => ({
  generateFollowUpMessage: vi.fn().mockResolvedValue('Follow-up test message'),
}));

vi.mock('../../whatsapp/rate-limiter.js', () => ({
  sendWithTyping: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../calendar/business-hours.js', () => ({
  isBusinessHours: vi.fn().mockReturnValue(true),
  getNextBusinessDay: vi.fn().mockReturnValue(new Date('2026-03-10T06:00:00Z')),
}));

// Import after mocks are set up
import { processFollowUps } from '../scheduler.js';
import { sendWithTyping } from '../../whatsapp/rate-limiter.js';
import { isBusinessHours, getNextBusinessDay } from '../../calendar/business-hours.js';
import { generateFollowUpMessage } from '../follow-up-ai.js';

describe('follow-up scheduler', () => {
  let db: Database.Database;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-09T10:00:00Z'));

    // Re-set mock return values (cleared between tests)
    vi.mocked(isBusinessHours).mockReturnValue(true);
    vi.mocked(getNextBusinessDay).mockReturnValue(new Date('2026-03-10T06:00:00Z'));
    vi.mocked(sendWithTyping).mockResolvedValue(undefined);
    vi.mocked(generateFollowUpMessage).mockResolvedValue('Follow-up test message');

    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    initSchema(db);

    const { _setMockDb } = await import('../../db/index.js') as any;
    _setMockDb(db);

    // Insert test lead
    db.prepare('INSERT INTO leads (phone, name, status, interest) VALUES (?, ?, ?, ?)').run(
      '972501234567', 'David Cohen', 'in-conversation', 'website',
    );
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sends due follow-up and marks as sent', async () => {
    // Schedule a follow-up in the past
    db.prepare('INSERT INTO follow_ups (phone, message_number, scheduled_at) VALUES (?, ?, ?)').run(
      '972501234567', 1, '2020-01-01T08:00:00.000Z',
    );

    const mockSock = {} as any;
    await processFollowUps(mockSock);

    expect(sendWithTyping).toHaveBeenCalledWith(
      mockSock,
      '972501234567@s.whatsapp.net',
      'Follow-up test message',
    );

    // Verify marked as sent
    const row = db.prepare('SELECT sent_at FROM follow_ups WHERE phone = ?').get('972501234567') as any;
    expect(row.sent_at).toBeTruthy();
  });

  it('defers follow-up to next business day when outside business hours', async () => {
    vi.mocked(isBusinessHours).mockReturnValue(false);

    db.prepare('INSERT INTO follow_ups (phone, message_number, scheduled_at) VALUES (?, ?, ?)').run(
      '972501234567', 1, '2020-01-01T08:00:00.000Z',
    );

    const mockSock = {} as any;
    await processFollowUps(mockSock);

    // Should NOT have sent
    expect(sendWithTyping).not.toHaveBeenCalled();

    // Should have deferred scheduled_at
    const row = db.prepare('SELECT scheduled_at FROM follow_ups WHERE phone = ?').get('972501234567') as any;
    expect(row.scheduled_at).not.toBe('2020-01-01T08:00:00.000Z');
  });

  it('schedules follow-up #2 after sending #1', async () => {
    db.prepare('INSERT INTO follow_ups (phone, message_number, scheduled_at) VALUES (?, ?, ?)').run(
      '972501234567', 1, '2020-01-01T08:00:00.000Z',
    );

    const mockSock = {} as any;
    await processFollowUps(mockSock);

    // Should have created a #2 follow-up
    const next = db.prepare(
      'SELECT message_number FROM follow_ups WHERE phone = ? AND sent_at IS NULL AND cancelled = 0',
    ).get('972501234567') as any;
    expect(next).toBeTruthy();
    expect(next.message_number).toBe(2);
  });

  it('schedules follow-up #3 after sending #2', async () => {
    db.prepare('INSERT INTO follow_ups (phone, message_number, scheduled_at) VALUES (?, ?, ?)').run(
      '972501234567', 2, '2020-01-01T08:00:00.000Z',
    );

    const mockSock = {} as any;
    await processFollowUps(mockSock);

    const next = db.prepare(
      'SELECT message_number FROM follow_ups WHERE phone = ? AND sent_at IS NULL AND cancelled = 0',
    ).get('972501234567') as any;
    expect(next).toBeTruthy();
    expect(next.message_number).toBe(3);
  });

  it('does NOT schedule further follow-ups after sending #3', async () => {
    db.prepare('INSERT INTO follow_ups (phone, message_number, scheduled_at) VALUES (?, ?, ?)').run(
      '972501234567', 3, '2020-01-01T08:00:00.000Z',
    );

    const mockSock = {} as any;
    await processFollowUps(mockSock);

    const next = db.prepare(
      'SELECT * FROM follow_ups WHERE phone = ? AND sent_at IS NULL AND cancelled = 0',
    ).all('972501234567');
    expect(next.length).toBe(0);
  });

  it('skips cancelled follow-up on re-check', async () => {
    db.prepare('INSERT INTO follow_ups (phone, message_number, scheduled_at, cancelled) VALUES (?, ?, ?, ?)').run(
      '972501234567', 1, '2020-01-01T08:00:00.000Z', 1,
    );

    const mockSock = {} as any;
    await processFollowUps(mockSock);

    expect(sendWithTyping).not.toHaveBeenCalled();
  });
});
