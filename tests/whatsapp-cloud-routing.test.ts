import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseWebhookPayload, sendCloudMessage, createCloudAdapter } from '../src/whatsapp/cloud-api.js';
import express from 'express';
import request from 'supertest';

// Module-level mocks (hoisted by Vitest)
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockAddMessageToBatch = vi.fn();
const mockHandleConversation = vi.fn().mockResolvedValue(undefined);
const mockCancelFollowUps = vi.fn().mockReturnValue(0);
const mockIsAdminPhone = vi.fn().mockReturnValue(false);

vi.mock('../src/whatsapp/connection.js', () => ({
  getAdapter: () => ({ sendMessage: mockSendMessage }),
}));
vi.mock('../src/db/index.js', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => undefined, run: () => undefined }),
  }),
}));
vi.mock('../src/whatsapp/message-batcher.js', () => ({
  addMessageToBatch: (...args: unknown[]) => mockAddMessageToBatch(...args),
}));
vi.mock('../src/ai/conversation.js', () => ({
  handleConversation: (...args: unknown[]) => mockHandleConversation(...args),
}));
vi.mock('../src/follow-up/follow-up-db.js', () => ({
  cancelFollowUps: (...args: unknown[]) => mockCancelFollowUps(...args),
  scheduleFollowUp: vi.fn(),
}));
vi.mock('../src/db/tenant-config.js', () => ({
  isAdminPhone: (...args: unknown[]) => mockIsAdminPhone(...args),
  getConfig: vi.fn().mockReturnValue(''),
}));

import { sendWhatsappRouter } from '../src/http/routes/send-whatsapp.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REALISTIC_WEBHOOK = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1289908013100682',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '055-9566148',
              phone_number_id: '1080047101853955',
            },
            contacts: [
              {
                profile: { name: 'David Cohen' },
                wa_id: '972541234567',
              },
            ],
            messages: [
              {
                from: '972541234567',
                id: 'wamid.ABC123',
                timestamp: '1711896000',
                text: { body: 'Hello, I want to book a meeting' },
                type: 'text',
              },
            ],
          },
          field: 'messages',
        },
      ],
    },
  ],
};

const STATUS_ONLY_WEBHOOK = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1289908013100682',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '055-9566148',
              phone_number_id: '1080047101853955',
            },
            statuses: [
              {
                id: 'wamid.STATUS1',
                status: 'delivered',
                timestamp: '1711896001',
                recipient_id: '972541234567',
              },
            ],
          },
          field: 'messages',
        },
      ],
    },
  ],
};

const AUDIO_MESSAGE_WEBHOOK = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '1289908013100682',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '055-9566148',
              phone_number_id: '1080047101853955',
            },
            contacts: [
              {
                profile: { name: 'Sara Levy' },
                wa_id: '972509876543',
              },
            ],
            messages: [
              {
                from: '972509876543',
                id: 'wamid.AUDIO1',
                timestamp: '1711896100',
                audio: { id: 'audio_file_id', mime_type: 'audio/ogg; codecs=opus' },
                type: 'audio',
              },
            ],
          },
          field: 'messages',
        },
      ],
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// parseWebhookPayload tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWebhookPayload', () => {
  it('extracts phone_number_id from metadata', () => {
    const result = parseWebhookPayload(REALISTIC_WEBHOOK);
    expect(result).toHaveLength(1);
    expect(result[0].phoneNumberId).toBe('1080047101853955');
  });

  it('extracts sender phone from messages', () => {
    const result = parseWebhookPayload(REALISTIC_WEBHOOK);
    expect(result[0].senderPhone).toBe('972541234567');
  });

  it('extracts message text from text messages', () => {
    const result = parseWebhookPayload(REALISTIC_WEBHOOK);
    expect(result[0].text).toBe('Hello, I want to book a meeting');
  });

  it('extracts message id', () => {
    const result = parseWebhookPayload(REALISTIC_WEBHOOK);
    expect(result[0].messageId).toBe('wamid.ABC123');
  });

  it('extracts sender name from contacts', () => {
    const result = parseWebhookPayload(REALISTIC_WEBHOOK);
    expect(result[0].senderName).toBe('David Cohen');
  });

  it('extracts timestamp', () => {
    const result = parseWebhookPayload(REALISTIC_WEBHOOK);
    expect(result[0].timestamp).toBe(1711896000);
  });

  it('returns empty array for status-only webhooks (no messages)', () => {
    const result = parseWebhookPayload(STATUS_ONLY_WEBHOOK);
    expect(result).toEqual([]);
  });

  it('handles audio messages as [audio] placeholder text', () => {
    const result = parseWebhookPayload(AUDIO_MESSAGE_WEBHOOK);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('[audio]');
    expect(result[0].senderPhone).toBe('972509876543');
  });

  it('returns empty array for malformed/empty payload', () => {
    expect(parseWebhookPayload(null)).toEqual([]);
    expect(parseWebhookPayload(undefined)).toEqual([]);
    expect(parseWebhookPayload({})).toEqual([]);
    expect(parseWebhookPayload({ entry: [] })).toEqual([]);
    expect(parseWebhookPayload({ entry: [{ changes: [] }] })).toEqual([]);
  });

  it('handles missing metadata gracefully without crashing', () => {
    const noMeta = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: '972541234567', id: 'abc', timestamp: '123', type: 'text', text: { body: 'hi' } },
                ],
              },
            },
          ],
        },
      ],
    };
    // Should not throw — metadata.phone_number_id is undefined, still returns parsed messages
    expect(() => parseWebhookPayload(noMeta)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendCloudMessage tests
// ─────────────────────────────────────────────────────────────────────────────

describe('sendCloudMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // Set env vars for tests
    process.env.WA_CLOUD_TOKEN = 'test-token-abc123';
    process.env.WA_CLOUD_PHONE_ID = '1080047101853955';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WA_CLOUD_TOKEN;
    delete process.env.WA_CLOUD_PHONE_ID;
  });

  it('calls Graph API with correct phone_number_id in URL path', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.SENT1' }] }),
    });

    await sendCloudMessage({ to: '972541234567', message: 'Hello', phoneNumberId: 'PHONE_ID_X' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/PHONE_ID_X/messages');
  });

  it('normalizes phone: 05X to 972X', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.SENT2' }] }),
    });

    await sendCloudMessage({ to: '0541234567', message: 'Hi' });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.to).toBe('972541234567');
  });

  it('normalizes phone: strips leading +', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.SENT3' }] }),
    });

    await sendCloudMessage({ to: '+972541234567', message: 'Hi' });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.to).toBe('972541234567');
  });

  it('uses WA_CLOUD_TOKEN for authorization header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.SENT4' }] }),
    });

    await sendCloudMessage({ to: '972541234567', message: 'test' });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-token-abc123');
  });

  it('defaults to config.waCloudPhoneId when no phoneNumberId provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.SENT5' }] }),
    });

    await sendCloudMessage({ to: '972541234567', message: 'test' });

    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/1080047101853955/messages');
  });

  it('returns success with messageId on successful send', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.RETURNED' }] }),
    });

    const result = await sendCloudMessage({ to: '972541234567', message: 'test' });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('wamid.RETURNED');
  });

  it('returns failure with error on API error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid phone number' } }),
    });

    const result = await sendCloudMessage({ to: '972541234567', message: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns failure when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const result = await sendCloudMessage({ to: '972541234567', message: 'test' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook GET verification endpoint tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud Webhook GET verification', () => {
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    process.env.WA_CLOUD_VERIFY_TOKEN = 'alonbot-verify-2026';
    const { cloudWebhookRouter } = await import('../src/http/routes/whatsapp-cloud-webhook.js');
    app = express();
    app.use('/', cloudWebhookRouter);
  });

  afterEach(() => {
    delete process.env.WA_CLOUD_VERIFY_TOKEN;
    vi.resetModules();
  });

  it('returns 200 and challenge when verify token matches', async () => {
    const res = await request(app).get('/whatsapp-cloud-webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'alonbot-verify-2026',
      'hub.challenge': 'challenge_abc123',
    });

    expect(res.status).toBe(200);
    expect(res.text).toBe('challenge_abc123');
  });

  it('returns 403 when verify token does not match', async () => {
    const res = await request(app).get('/whatsapp-cloud-webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge_abc123',
    });

    expect(res.status).toBe(403);
  });

  it('returns 403 when hub.mode is not subscribe', async () => {
    const res = await request(app).get('/whatsapp-cloud-webhook').query({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'alonbot-verify-2026',
      'hub.challenge': 'challenge_abc123',
    });

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook POST incoming messages tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud Webhook POST incoming messages', () => {
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    const { cloudWebhookRouter } = await import('../src/http/routes/whatsapp-cloud-webhook.js');
    app = express();
    app.use(express.json());
    app.use('/', cloudWebhookRouter);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('always returns 200 OK for valid webhook (prevents Meta retry storms)', async () => {
    const res = await request(app)
      .post('/whatsapp-cloud-webhook')
      .send(REALISTIC_WEBHOOK);

    expect(res.status).toBe(200);
  });

  it('returns 200 OK even for status-only webhooks', async () => {
    const res = await request(app)
      .post('/whatsapp-cloud-webhook')
      .send(STATUS_ONLY_WEBHOOK);

    expect(res.status).toBe(200);
  });

  it('returns 200 OK for malformed payloads (does not crash)', async () => {
    const res = await request(app)
      .post('/whatsapp-cloud-webhook')
      .send({ garbage: true });

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/send-whatsapp phone_number_id routing tests (Task 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('/api/send-whatsapp phone_number_id routing', () => {
  let app: ReturnType<typeof express>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.API_SECRET = 'test-api-secret';
    process.env.WA_CLOUD_TOKEN = 'test-cloud-token';
    process.env.WA_CLOUD_PHONE_ID = '1080047101853955';

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.CLOUD1' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    mockSendMessage.mockClear();

    app = express();
    app.use(express.json());
    app.use('/', sendWhatsappRouter);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.API_SECRET;
    delete process.env.WA_CLOUD_TOKEN;
    delete process.env.WA_CLOUD_PHONE_ID;
  });

  it('calls sendCloudMessage (not adapter) when phone_number_id is provided', async () => {
    const res = await request(app)
      .post('/api/send-whatsapp')
      .set('x-api-secret', 'test-api-secret')
      .send({ phone: '972541234567', message: 'Hello via Cloud', phone_number_id: '1080047101853955' });

    expect(res.status).toBe(200);
    expect(res.body.via).toBe('cloud-api');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('uses whatsapp-web.js adapter when phone_number_id is NOT provided', async () => {
    const res = await request(app)
      .post('/api/send-whatsapp')
      .set('x-api-secret', 'test-api-secret')
      .send({ phone: '972541234567', message: 'Hello via WA' });

    expect(res.status).toBe(200);
    expect(res.body.via).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledOnce();
  });

  it('falls back to adapter when phone_number_id is provided but WA_CLOUD_TOKEN is empty', async () => {
    delete process.env.WA_CLOUD_TOKEN;

    const res = await request(app)
      .post('/api/send-whatsapp')
      .set('x-api-secret', 'test-api-secret')
      .send({ phone: '972541234567', message: 'Hello', phone_number_id: '1080047101853955' });

    // Should fall back to adapter since no cloud token
    expect(res.status).toBe(200);
    expect(res.body.via).toBeUndefined();
    expect(mockSendMessage).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createCloudAdapter tests (Task 1)
// ─────────────────────────────────────────────────────────────────────────────

describe('createCloudAdapter', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.ADAPTER1' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.WA_CLOUD_TOKEN = 'test-adapter-token';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WA_CLOUD_TOKEN;
  });

  it('sendMessage calls Graph API with the provided phoneNumberId in URL', async () => {
    const adapter = createCloudAdapter('PHONE_ID_ADAPTER');
    await adapter.sendMessage('972541234567', { text: 'Hello from adapter' });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('/PHONE_ID_ADAPTER/messages');
  });

  it('sendMessage strips @suffix from jid before sending', async () => {
    const adapter = createCloudAdapter('PHONE_ID_ADAPTER');
    await adapter.sendMessage('972541234567@s.whatsapp.net', { text: 'Hello' });

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.to).toBe('972541234567');
  });

  it('sendPresenceUpdate is a no-op (does not call fetch)', async () => {
    const adapter = createCloudAdapter('PHONE_ID_ADAPTER');
    await adapter.sendPresenceUpdate('composing', '972541234567');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendAudio is a no-op (does not call fetch)', async () => {
    const adapter = createCloudAdapter('PHONE_ID_ADAPTER');
    await adapter.sendAudio('972541234567', Buffer.from('audio'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloud webhook → conversation routing tests (Task 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('Cloud webhook → conversation routing', () => {
  let app: ReturnType<typeof express>;

  beforeEach(async () => {
    mockAddMessageToBatch.mockClear();
    mockCancelFollowUps.mockClear();
    mockIsAdminPhone.mockReturnValue(false);

    process.env.WA_CLOUD_VERIFY_TOKEN = 'alonbot-verify-2026';
    const { cloudWebhookRouter } = await import('../src/http/routes/whatsapp-cloud-webhook.js');
    app = express();
    app.use(express.json());
    app.use('/', cloudWebhookRouter);
  });

  afterEach(() => {
    delete process.env.WA_CLOUD_VERIFY_TOKEN;
    vi.resetModules();
  });

  it('routes incoming text message to addMessageToBatch', async () => {
    await request(app)
      .post('/whatsapp-cloud-webhook')
      .send(REALISTIC_WEBHOOK);

    expect(mockAddMessageToBatch).toHaveBeenCalledOnce();
    const [phone, text] = mockAddMessageToBatch.mock.calls[0] as [string, string, unknown];
    expect(phone).toBe('972541234567');
    expect(text).toBe('Hello, I want to book a meeting');
  });

  it('cancels follow-ups when message arrives', async () => {
    await request(app)
      .post('/whatsapp-cloud-webhook')
      .send(REALISTIC_WEBHOOK);

    expect(mockCancelFollowUps).toHaveBeenCalledWith('972541234567');
  });

  it('skips admin phone — does not route to addMessageToBatch', async () => {
    mockIsAdminPhone.mockReturnValue(true);

    await request(app)
      .post('/whatsapp-cloud-webhook')
      .send(REALISTIC_WEBHOOK);

    expect(mockAddMessageToBatch).not.toHaveBeenCalled();
  });

  it('still returns 200 even when isAdminPhone is true', async () => {
    mockIsAdminPhone.mockReturnValue(true);

    const res = await request(app)
      .post('/whatsapp-cloud-webhook')
      .send(REALISTIC_WEBHOOK);

    expect(res.status).toBe(200);
  });

  it('does not call addMessageToBatch for status-only webhooks', async () => {
    await request(app)
      .post('/whatsapp-cloud-webhook')
      .send(STATUS_ONLY_WEBHOOK);

    expect(mockAddMessageToBatch).not.toHaveBeenCalled();
  });
});
