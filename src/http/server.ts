import express from 'express';
import http from 'http';
import { healthRouter } from './routes/health.js';
import { qrRouter } from './routes/qr.js';
import { mondayWebhookRouter } from '../monday/webhook-handler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http');

export function createServer(port: number): http.Server {
  const app = express();

  app.use(express.json());

  app.use('/', healthRouter);
  app.use('/', qrRouter);
  app.use('/webhook', mondayWebhookRouter);

  const server = app.listen(port, () => {
    log.info({ port }, 'HTTP server listening');
  });

  return server;
}
