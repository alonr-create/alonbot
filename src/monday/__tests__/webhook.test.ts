import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import Database from 'better-sqlite3';
import { initSchema } from '../../db/schema.js';

// We need a real in-memory DB for webhook handler tests
function setupTestDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

// Helper to make HTTP requests to the test server
async function request(
  server: http.Server,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('No server address');

  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return { status: res.status, body: data };
}

describe('Monday.com webhook handler', () => {
  let server: http.Server;
  let db: Database.Database;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    db = setupTestDb();

    // Mock getDb to return our test DB
    vi.doMock('../../db/index.js', () => ({
      getDb: () => db,
      initDb: () => db,
    }));

    // Mock fetchMondayItem
    vi.doMock('../api.js', () => ({
      fetchMondayItem: vi.fn().mockResolvedValue({
        name: 'Test Lead',
        phone: '054-630-0783',
        interest: 'Website Development',
      }),
    }));

    // Dynamic import after mocking
    const { mondayWebhookRouter } = await import('../webhook-handler.js');

    const app = express();
    app.use(express.json());
    app.use('/webhook', mondayWebhookRouter);

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    globalThis.fetch = originalFetch;
    delete process.env.MONDAY_WEBHOOK_SECRET;
    db?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('echoes challenge token back', async () => {
    process.env.MONDAY_WEBHOOK_SECRET = 'test-secret';
    const res = await request(server, '/webhook/monday', {
      challenge: 'test-token-123',
    }, { 'Authorization': 'test-secret' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: 'test-token-123' });
  });

  it('responds 200 to create_item event', async () => {
    process.env.MONDAY_WEBHOOK_SECRET = 'test-secret';
    const res = await request(server, '/webhook/monday', {
      event: {
        type: 'create_item',
        pulseId: 12345,
        boardId: 67890,
        pulseName: 'New Lead',
      },
    }, { 'Authorization': 'test-secret' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('creates lead in DB with monday fields', async () => {
    process.env.MONDAY_WEBHOOK_SECRET = 'test-secret';
    await request(server, '/webhook/monday', {
      event: {
        type: 'create_item',
        pulseId: 12345,
        boardId: 67890,
        pulseName: 'New Lead',
      },
    }, { 'Authorization': 'test-secret' });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 200));

    const lead = db
      .prepare('SELECT * FROM leads WHERE monday_item_id = ?')
      .get(12345) as Record<string, unknown> | undefined;

    expect(lead).toBeDefined();
    expect(lead!.monday_item_id).toBe(12345);
    expect(lead!.monday_board_id).toBe(67890);
    expect(lead!.interest).toBe('Website Development');
    expect(lead!.source).toBe('monday');
  });

  it('updates existing lead instead of duplicating', async () => {
    process.env.MONDAY_WEBHOOK_SECRET = 'test-secret';
    // Insert an existing lead with same phone
    db.prepare(
      "INSERT INTO leads (phone, name, source, status) VALUES ('972546300783', 'Old Name', 'whatsapp', 'new')",
    ).run();

    await request(server, '/webhook/monday', {
      event: {
        type: 'create_item',
        pulseId: 99999,
        boardId: 11111,
        pulseName: 'Updated Lead',
      },
    }, { 'Authorization': 'test-secret' });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 200));

    const leads = db.prepare('SELECT * FROM leads').all();
    expect(leads).toHaveLength(1);

    const lead = leads[0] as Record<string, unknown>;
    expect(lead.monday_item_id).toBe(99999);
    expect(lead.monday_board_id).toBe(11111);
  });
});
