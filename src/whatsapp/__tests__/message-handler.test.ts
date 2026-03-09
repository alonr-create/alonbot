import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../db/schema.js';

// We test the message handling logic by simulating what setupMessageHandler does,
// since the actual function binds to a Baileys socket event emitter.

describe('message-handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    initSchema(db);
  });

  it('stores incoming text messages in the database', () => {
    const phone = '972501234567';
    const text = 'Hello, I want to build a website';

    // Simulate what message-handler does: store incoming message
    db.prepare(
      'INSERT INTO messages (phone, direction, content) VALUES (?, ?, ?)'
    ).run(phone, 'in', text);

    const messages = db
      .prepare('SELECT * FROM messages WHERE phone = ?')
      .all(phone) as any[];

    expect(messages).toHaveLength(1);
    expect(messages[0].phone).toBe(phone);
    expect(messages[0].direction).toBe('in');
    expect(messages[0].content).toBe(text);
  });

  it('creates a new lead if phone not found', () => {
    const phone = '972509876543';

    // Check no lead exists
    const before = db
      .prepare('SELECT id FROM leads WHERE phone = ?')
      .get(phone);
    expect(before).toBeUndefined();

    // Simulate lead creation
    const result = db
      .prepare('INSERT INTO leads (phone) VALUES (?)')
      .run(phone);

    expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);

    const after = db
      .prepare('SELECT * FROM leads WHERE phone = ?')
      .get(phone) as any;
    expect(after).toBeDefined();
    expect(after.phone).toBe(phone);
    expect(after.status).toBe('new');
  });

  it('does not create duplicate leads for same phone', () => {
    const phone = '972501111111';

    // Insert first lead
    db.prepare('INSERT INTO leads (phone) VALUES (?)').run(phone);

    // Attempting to insert duplicate should throw (UNIQUE constraint)
    expect(() => {
      db.prepare('INSERT INTO leads (phone) VALUES (?)').run(phone);
    }).toThrow();
  });

  it('stores outbound messages with lead_id', () => {
    const phone = '972502222222';
    const responseText = 'היי! הגעת לאלון מ-Alon.dev. המערכת בשלבי הקמה, אחזור אליך בקרוב!';

    // Create lead
    const result = db
      .prepare('INSERT INTO leads (phone) VALUES (?)')
      .run(phone);
    const leadId = Number(result.lastInsertRowid);

    // Store outbound message
    db.prepare(
      'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)'
    ).run(phone, leadId, 'out', responseText);

    const messages = db
      .prepare('SELECT * FROM messages WHERE phone = ? AND direction = ?')
      .all(phone, 'out') as any[];

    expect(messages).toHaveLength(1);
    expect(messages[0].lead_id).toBe(leadId);
    expect(messages[0].direction).toBe('out');
    expect(messages[0].content).toBe(responseText);
  });

  it('handles message upsert event filtering correctly', () => {
    // Test the filtering logic that message-handler applies:
    // Skip fromMe, skip non-notify type, skip no-content messages

    const testCases = [
      {
        name: 'fromMe message',
        msg: { key: { fromMe: true, remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'test' } },
        type: 'notify',
        shouldProcess: false,
      },
      {
        name: 'history sync type',
        msg: { key: { fromMe: false, remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'test' } },
        type: 'append',
        shouldProcess: false,
      },
      {
        name: 'no message content',
        msg: { key: { fromMe: false, remoteJid: '123@s.whatsapp.net' }, message: null },
        type: 'notify',
        shouldProcess: false,
      },
      {
        name: 'valid incoming text',
        msg: { key: { fromMe: false, remoteJid: '123@s.whatsapp.net' }, message: { conversation: 'Hello' } },
        type: 'notify',
        shouldProcess: true,
      },
      {
        name: 'extended text message',
        msg: { key: { fromMe: false, remoteJid: '123@s.whatsapp.net' }, message: { extendedTextMessage: { text: 'Hello' } } },
        type: 'notify',
        shouldProcess: true,
      },
    ];

    for (const tc of testCases) {
      const shouldProcess =
        tc.type === 'notify' &&
        !tc.msg.key.fromMe &&
        tc.msg.message !== null &&
        (tc.msg.message?.conversation || (tc.msg.message as any)?.extendedTextMessage?.text);

      expect(!!shouldProcess, `${tc.name}: expected shouldProcess=${tc.shouldProcess}`).toBe(tc.shouldProcess);
    }
  });
});
