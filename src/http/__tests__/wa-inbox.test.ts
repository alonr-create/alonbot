import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks — must be declared before importing the module under test
// ─────────────────────────────────────────────────────────────────────────────

// Mock sendCloudMessage
vi.mock('../../whatsapp/cloud-api.js', () => ({
  sendCloudMessage: vi.fn(),
}));

// Mock getDb — return a fresh in-memory DB per test suite (re-injected in beforeEach)
vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  }),
}));

import { sendCloudMessage } from '../../whatsapp/cloud-api.js';
import { getDb } from '../../db/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test DB helpers
// ─────────────────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      wa_phone_number_id TEXT NOT NULL UNIQUE,
      wa_number TEXT NOT NULL,
      monday_board_id INTEGER NOT NULL,
      business_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      admin_phone TEXT NOT NULL,
      personality TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
      payment_url TEXT NOT NULL DEFAULT '',
      service_catalog TEXT NOT NULL DEFAULT '[]',
      sales_faq TEXT NOT NULL DEFAULT '[]',
      sales_objections TEXT NOT NULL DEFAULT '[]',
      portfolio TEXT NOT NULL DEFAULT '[]',
      wa_cloud_token TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      interest TEXT,
      tenant_id INTEGER REFERENCES tenants(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL,
      tenant_id INTEGER REFERENCES tenants(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Seed tenants
  db.prepare(
    `INSERT INTO tenants (name, wa_phone_number_id, wa_number, monday_board_id, business_name, owner_name, admin_phone)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('דקל', '1080047101853955', '972559566148', 1443236269, 'דקל לפרישה', 'דקל', '972546300783');

  db.prepare(
    `INSERT INTO tenants (name, wa_phone_number_id, wa_number, monday_board_id, business_name, owner_name, admin_phone)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('alondev', '967467269793135', '972559173249', 5092777389, 'Alon.dev', 'אלון', '972546300783');

  // Seed leads
  db.prepare(`INSERT INTO leads (phone, name, status, interest, tenant_id) VALUES (?, ?, ?, ?, 1)`)
    .run('972501111111', 'יעל כהן', 'new', 'אתר עסקי');
  db.prepare(`INSERT INTO leads (phone, name, status, interest, tenant_id) VALUES (?, ?, ?, ?, 1)`)
    .run('972502222222', 'משה לוי', 'in-conversation', 'אפליקציה');
  db.prepare(`INSERT INTO leads (phone, name, status, interest, tenant_id) VALUES (?, ?, ?, ?, 2)`)
    .run('972503333333', 'רינה דוד', 'new', 'פרישה');

  // Seed messages
  db.prepare(`INSERT INTO messages (phone, direction, content, tenant_id) VALUES (?, ?, ?, 1)`)
    .run('972501111111', 'in', 'שלום, אשמח לפרטים על אתר עסקי');
  db.prepare(`INSERT INTO messages (phone, direction, content, tenant_id) VALUES (?, ?, ?, 1)`)
    .run('972501111111', 'out', 'ברוך הבא! בשמחה אתן לך פרטים');
  db.prepare(`INSERT INTO messages (phone, direction, content, tenant_id) VALUES (?, ?, ?, 1)`)
    .run('972501111111', 'in', 'כמה זה עולה?');

  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('wa-inbox API', () => {
  let testDb: Database.Database;
  let app: any;
  let server: any;
  let baseUrl: string;
  const SECRET = 'test-secret';

  beforeEach(async () => {
    process.env.API_SECRET = SECRET;
    testDb = createTestDb();
    vi.mocked(getDb).mockReturnValue(testDb);

    // Dynamically import to pick up fresh mocks
    const { default: express } = await import('express');
    const { waInboxRouter } = await import('../../http/routes/wa-inbox.js');
    const freshApp = express();
    freshApp.use(express.json());
    freshApp.use('/', waInboxRouter);
    server = freshApp.listen(0);
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://localhost:${port}`;
  });

  afterEach(() => {
    server.close();
    testDb.close();
    vi.clearAllMocks();
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it('Test 7: all endpoints return 401 without valid token', async () => {
    const endpoints = [
      { method: 'GET', path: '/wa-inbox/api/tenants' },
      { method: 'GET', path: '/wa-inbox/api/conversations?tenant_id=1' },
      { method: 'GET', path: '/wa-inbox/api/messages?phone=972501111111' },
    ];

    for (const { method, path } of endpoints) {
      const res = await fetch(`${baseUrl}${path}`, { method });
      expect(res.status, `${method} ${path} should be 401`).toBe(401);
    }

    // POST reply without token
    const res = await fetch(`${baseUrl}/wa-inbox/api/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '972501111111', message: 'שלום', tenant_id: 1 }),
    });
    expect(res.status).toBe(401);
  });

  // ── GET /wa-inbox/api/tenants ───────────────────────────────────────────────

  it('Test 1: GET /wa-inbox/api/tenants returns list of active tenants', async () => {
    const res = await fetch(`${baseUrl}/wa-inbox/api/tenants?token=${SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    // Each tenant should have id, name, business_name
    expect(body[0]).toHaveProperty('id');
    expect(body[0]).toHaveProperty('name');
    expect(body[0]).toHaveProperty('business_name');
    // Should not leak sensitive fields
    expect(body[0]).not.toHaveProperty('wa_cloud_token');
    // Check tenant names
    const names = body.map((t: any) => t.name);
    expect(names).toContain('דקל');
    expect(names).toContain('alondev');
  });

  // ── GET /wa-inbox/api/conversations ────────────────────────────────────────

  it('Test 2: GET /wa-inbox/api/conversations?tenant_id=1 returns only tenant 1 leads', async () => {
    const res = await fetch(`${baseUrl}/wa-inbox/api/conversations?tenant_id=1&token=${SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    const phones = body.map((l: any) => l.phone);
    expect(phones).toContain('972501111111');
    expect(phones).toContain('972502222222');
    expect(phones).not.toContain('972503333333');
  });

  it('Test 3: GET /wa-inbox/api/conversations without tenant_id returns 400', async () => {
    const res = await fetch(`${baseUrl}/wa-inbox/api/conversations?token=${SECRET}`);
    expect(res.status).toBe(400);
  });

  it('Test 8: GET /wa-inbox/api/conversations returns last_msg and last_msg_at for each lead', async () => {
    const res = await fetch(`${baseUrl}/wa-inbox/api/conversations?tenant_id=1&token=${SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    // Find the lead with messages
    const lead = body.find((l: any) => l.phone === '972501111111');
    expect(lead).toBeDefined();
    expect(lead).toHaveProperty('last_msg');
    expect(lead).toHaveProperty('last_msg_at');
    expect(lead.last_msg).toBe('כמה זה עולה?');
  });

  // ── GET /wa-inbox/api/messages ─────────────────────────────────────────────

  it('Test 4: GET /wa-inbox/api/messages?phone=X returns messages for that phone', async () => {
    const res = await fetch(`${baseUrl}/wa-inbox/api/messages?phone=972501111111&token=${SECRET}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(3);
    // Should be ordered by created_at ASC
    expect(body[0].direction).toBe('in');
    expect(body[0].content).toBe('שלום, אשמח לפרטים על אתר עסקי');
    // Each message should have direction, content, created_at
    expect(body[0]).toHaveProperty('direction');
    expect(body[0]).toHaveProperty('content');
    expect(body[0]).toHaveProperty('created_at');
  });

  // ── POST /wa-inbox/api/reply ───────────────────────────────────────────────

  it('Test 5: POST /wa-inbox/api/reply sends via sendCloudMessage with correct phoneNumberId', async () => {
    vi.mocked(sendCloudMessage).mockResolvedValue({ success: true, messageId: 'msg123' });

    const res = await fetch(`${baseUrl}/wa-inbox/api/reply?token=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '972501111111', message: 'הי, אני כאן לעזור!', tenant_id: 1 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);

    // Verify sendCloudMessage was called with the correct phoneNumberId from tenant 1
    expect(sendCloudMessage).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(sendCloudMessage).mock.calls[0][0];
    expect(callArgs.to).toBe('972501111111');
    expect(callArgs.message).toBe('הי, אני כאן לעזור!');
    expect(callArgs.phoneNumberId).toBe('1080047101853955'); // דקל tenant phone_number_id

    // Verify message was stored in DB
    const stored = testDb.prepare('SELECT * FROM messages WHERE phone = ? AND direction = ? ORDER BY id DESC LIMIT 1')
      .get('972501111111', 'out') as any;
    expect(stored).toBeDefined();
    expect(stored.content).toBe('הי, אני כאן לעזור!');
    expect(stored.tenant_id).toBe(1);
  });

  it('Test 6: POST /wa-inbox/api/reply with invalid tenant_id returns 400', async () => {
    const res = await fetch(`${baseUrl}/wa-inbox/api/reply?token=${SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '972501111111', message: 'שלום', tenant_id: 9999 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
  });
});
