import express from 'express';
import http from 'http';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { healthRouter } from './routes/health.js';
import { qrRouter } from './routes/qr.js';
import { chatRouter } from './routes/chat.js';
import { mondayWebhookRouter } from '../monday/webhook-handler.js';
import { sendWhatsappRouter } from './routes/send-whatsapp.js';
import { cloudWebhookRouter } from './routes/whatsapp-cloud-webhook.js';
import { waManagerRouter } from './routes/wa-manager.js';
import { waInboxRouter } from './routes/wa-inbox.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http');

// Resolve public/ dir — works in both dev (src/http/) and prod Docker (dist/http/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const devPublic = join(__dirname, '../public');
const prodPublic = join(__dirname, '../../src/public');
const publicDir = existsSync(devPublic) ? devPublic : prodPublic;

// Allowed origins for website chat
const CHAT_ORIGINS = [
  'https://alon-dev.vercel.app',
  'https://www.alon.dev',
  'https://alon.dev',
  'http://localhost:5173',
];

export function createServer(port: number): http.Server {
  const app = express();

  app.use(express.static(publicDir));

  app.use(express.json({
    limit: '1mb',
    verify: (req: any, _res, buf) => {
      // Capture raw body for HMAC signature verification (Meta webhook)
      req._rawBody = buf;
    },
  }));

  // CORS for /api/chat
  app.use('/api/chat', (req, res, next) => {
    const origin = req.headers.origin || '';
    if (CHAT_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/', healthRouter);
  app.use('/', qrRouter);
  app.use('/', chatRouter);
  app.use('/', sendWhatsappRouter);
  app.use('/', cloudWebhookRouter);
  app.use('/', waManagerRouter);
  app.use('/', waInboxRouter);
  app.use('/webhook', mondayWebhookRouter);

  const server = app.listen(port, () => {
    log.info({ port }, 'HTTP server listening');
  });

  return server;
}
