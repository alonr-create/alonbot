import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../db/schema.js';

function setupTestDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

describe('conversation orchestrator', () => {
  let db: Database.Database;
  let mockSendWithTyping: ReturnType<typeof vi.fn>;
  let mockGenerateResponse: ReturnType<typeof vi.fn>;
  let mockUpdateMondayStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    db = setupTestDb();

    mockSendWithTyping = vi.fn().mockResolvedValue(undefined);
    mockGenerateResponse = vi.fn().mockResolvedValue('תשובה מהבוט');
    mockUpdateMondayStatus = vi.fn().mockResolvedValue(undefined);

    vi.doMock('../../db/index.js', () => ({
      getDb: () => db,
      initDb: () => db,
    }));

    vi.doMock('../../whatsapp/rate-limiter.js', () => ({
      sendWithTyping: mockSendWithTyping,
    }));

    vi.doMock('../claude-client.js', () => ({
      generateResponse: mockGenerateResponse,
    }));

    vi.doMock('../../monday/api.js', () => ({
      updateMondayStatus: mockUpdateMondayStatus,
    }));

    vi.doMock('../../calendar/business-hours.js', () => ({
      isBusinessHours: () => false,
      formatIsraelTime: () => 'יום ראשון 10:00',
    }));

    vi.doMock('../../calendar/api.js', () => ({
      getAvailableSlots: vi.fn().mockResolvedValue([]),
      bookMeeting: vi.fn().mockResolvedValue({ success: true, eventId: 'test-123' }),
    }));

    vi.doMock('../../escalation/handler.js', () => ({
      shouldEscalate: vi.fn().mockReturnValue({ escalate: false, reason: null }),
      triggerEscalation: vi.fn().mockResolvedValue(undefined),
      resetEscalationCount: vi.fn(),
      incrementEscalationCount: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    db?.close();
  });

  it('sends Claude response via sendWithTyping', async () => {
    db.prepare(
      "INSERT INTO leads (phone, name, interest, status) VALUES ('972501234567', 'Test', 'website', 'new')",
    ).run();

    const { handleConversation } = await import('../conversation.js');
    const mockSock = {} as any;

    await handleConversation('972501234567', ['שלום'], mockSock);

    expect(mockGenerateResponse).toHaveBeenCalledOnce();
    expect(mockSendWithTyping).toHaveBeenCalledWith(
      mockSock,
      '972501234567@s.whatsapp.net',
      'תשובה מהבוט',
    );
  });

  it('stores both incoming and outgoing messages in DB', async () => {
    db.prepare(
      "INSERT INTO leads (phone, name, interest, status) VALUES ('972501234567', 'Test', 'website', 'contacted')",
    ).run();

    const { handleConversation } = await import('../conversation.js');
    await handleConversation('972501234567', ['msg1', 'msg2'], {} as any);

    const messages = db
      .prepare("SELECT * FROM messages WHERE phone = '972501234567' ORDER BY id")
      .all() as Array<{ direction: string; content: string }>;

    // 2 incoming + 1 outgoing = 3
    expect(messages).toHaveLength(3);
    expect(messages[0].direction).toBe('in');
    expect(messages[0].content).toBe('msg1');
    expect(messages[1].direction).toBe('in');
    expect(messages[1].content).toBe('msg2');
    expect(messages[2].direction).toBe('out');
    expect(messages[2].content).toBe('תשובה מהבוט');
  });

  it('builds correct message history from DB', async () => {
    db.prepare(
      "INSERT INTO leads (phone, name, interest, status) VALUES ('972501234567', 'Test', 'website', 'contacted')",
    ).run();

    // Add existing messages
    db.prepare(
      "INSERT INTO messages (phone, direction, content) VALUES ('972501234567', 'in', 'previous question')",
    ).run();
    db.prepare(
      "INSERT INTO messages (phone, direction, content) VALUES ('972501234567', 'out', 'previous answer')",
    ).run();

    const { handleConversation } = await import('../conversation.js');
    await handleConversation('972501234567', ['new message'], {} as any);

    // Check the messages array passed to generateResponse
    const callArgs = mockGenerateResponse.mock.calls[0][0] as Array<{
      role: string;
      content: string;
    }>;
    expect(callArgs).toHaveLength(3); // 2 history + 1 new
    expect(callArgs[0]).toEqual({ role: 'user', content: 'previous question' });
    expect(callArgs[1]).toEqual({ role: 'assistant', content: 'previous answer' });
    expect(callArgs[2]).toEqual({ role: 'user', content: 'new message' });
  });

  it('progresses status from new to contacted', async () => {
    db.prepare(
      "INSERT INTO leads (phone, name, interest, status) VALUES ('972501234567', 'Test', 'website', 'new')",
    ).run();

    const { handleConversation } = await import('../conversation.js');
    await handleConversation('972501234567', ['hello'], {} as any);

    const lead = db
      .prepare("SELECT status FROM leads WHERE phone = '972501234567'")
      .get() as { status: string };
    expect(lead.status).toBe('contacted');
  });

  it('progresses status from contacted to in-conversation', async () => {
    db.prepare(
      "INSERT INTO leads (phone, name, interest, status) VALUES ('972501234567', 'Test', 'website', 'contacted')",
    ).run();

    const { handleConversation } = await import('../conversation.js');
    await handleConversation('972501234567', ['I want more info'], {} as any);

    const lead = db
      .prepare("SELECT status FROM leads WHERE phone = '972501234567'")
      .get() as { status: string };
    expect(lead.status).toBe('in-conversation');
  });

  it('detects quote-sent when response contains shekel sign', async () => {
    mockGenerateResponse.mockResolvedValueOnce('המחיר הוא ₪5,000 לאתר');

    db.prepare(
      "INSERT INTO leads (phone, name, interest, status) VALUES ('972501234567', 'Test', 'website', 'in-conversation')",
    ).run();

    const { handleConversation } = await import('../conversation.js');
    await handleConversation('972501234567', ['how much?'], {} as any);

    const lead = db
      .prepare("SELECT status FROM leads WHERE phone = '972501234567'")
      .get() as { status: string };
    expect(lead.status).toBe('quote-sent');
  });

  it('calls updateMondayStatus when monday_item_id exists', async () => {
    db.prepare(
      "INSERT INTO leads (phone, name, interest, status, monday_item_id, monday_board_id) VALUES ('972501234567', 'Test', 'website', 'new', 12345, 67890)",
    ).run();

    const { handleConversation } = await import('../conversation.js');
    await handleConversation('972501234567', ['hello'], {} as any);

    expect(mockUpdateMondayStatus).toHaveBeenCalledWith(12345, 67890, 'contacted');
  });

  it('sendFirstMessage sends personalized intro with interest', async () => {
    db.prepare(
      "INSERT INTO leads (phone, name, interest, status) VALUES ('972501234567', 'David', 'website', 'new')",
    ).run();

    const { sendFirstMessage } = await import('../conversation.js');
    const mockSock = {} as any;
    await sendFirstMessage('972501234567', 'David', 'website', mockSock);

    expect(mockGenerateResponse).toHaveBeenCalledOnce();
    expect(mockSendWithTyping).toHaveBeenCalledOnce();
  });

  it('respects last-20-message limit', async () => {
    db.prepare(
      "INSERT INTO leads (phone, name, interest, status) VALUES ('972501234567', 'Test', 'website', 'in-conversation')",
    ).run();

    // Insert 25 messages
    for (let i = 0; i < 25; i++) {
      db.prepare(
        "INSERT INTO messages (phone, direction, content) VALUES ('972501234567', ?, ?)",
      ).run(i % 2 === 0 ? 'in' : 'out', `message ${i}`);
    }

    const { handleConversation } = await import('../conversation.js');
    await handleConversation('972501234567', ['latest'], {} as any);

    // History should be 20 messages from DB + 1 new = 21
    const callArgs = mockGenerateResponse.mock.calls[0][0] as Array<unknown>;
    expect(callArgs).toHaveLength(21);
  });
});
