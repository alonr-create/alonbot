import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock whatsapp/qr module
vi.mock('../../whatsapp/qr.js', () => ({
  getConnectionStatus: vi.fn(() => 'connected'),
}));

// Mock db module
vi.mock('../../db/index.js', () => {
  const mockDb = {
    prepare: vi.fn(() => ({
      get: vi.fn(() => ({ count: 5 })),
    })),
  };
  return {
    getDb: vi.fn(() => mockDb),
    checkDbHealth: vi.fn(() => true),
  };
});

// Mock config
vi.mock('../../config.js', () => ({
  config: { nodeEnv: 'test' },
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

import { getConnectionStatus } from '../../whatsapp/qr.js';
import { checkDbHealth } from '../../db/index.js';

describe('GET /health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns JSON with all required fields', async () => {
    const { healthRouter } = await import('../../http/routes/health.js');

    // Create a minimal Express-like test
    const { default: express } = await import('express');
    const app = express();
    app.use('/', healthRouter);

    // Use node http to test
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://localhost:${port}/health`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('whatsapp');
      expect(body).toHaveProperty('database');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('memory');
      expect(body).toHaveProperty('activeLeads');
      expect(body).toHaveProperty('timestamp');

      expect(body.whatsapp).toHaveProperty('connected');
      expect(body.whatsapp).toHaveProperty('status');
      expect(body.database).toHaveProperty('healthy');
    } finally {
      server.close();
    }
  });

  it('returns status "ok" when whatsapp and db both healthy', async () => {
    vi.mocked(getConnectionStatus).mockReturnValue('connected');
    vi.mocked(checkDbHealth).mockReturnValue(true);

    const { healthRouter } = await import('../../http/routes/health.js');
    const { default: express } = await import('express');
    const app = express();
    app.use('/', healthRouter);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://localhost:${port}/health`);
      const body = await res.json();

      expect(body.status).toBe('ok');
      expect(body.whatsapp.connected).toBe(true);
      expect(body.database.healthy).toBe(true);
    } finally {
      server.close();
    }
  });

  it('returns status "degraded" when whatsapp disconnected', async () => {
    vi.mocked(getConnectionStatus).mockReturnValue('disconnected');
    vi.mocked(checkDbHealth).mockReturnValue(true);

    const { healthRouter } = await import('../../http/routes/health.js');
    const { default: express } = await import('express');
    const app = express();
    app.use('/', healthRouter);

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://localhost:${port}/health`);
      const body = await res.json();

      expect(body.status).toBe('degraded');
      expect(body.whatsapp.connected).toBe(false);
    } finally {
      server.close();
    }
  });
});
