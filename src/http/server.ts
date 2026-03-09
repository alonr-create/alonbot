import express from 'express';
import http from 'http';
import { healthRouter } from './routes/health.js';
import { qrRouter } from './routes/qr.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http');

export function createServer(port: number): http.Server {
  const app = express();

  app.use('/', healthRouter);
  app.use('/', qrRouter);

  const server = app.listen(port, () => {
    log.info({ port }, 'HTTP server listening');
  });

  return server;
}
