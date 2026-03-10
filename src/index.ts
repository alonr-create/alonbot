import 'dotenv/config';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { initDb, getDb } from './db/index.js';
import { connectWhatsApp } from './whatsapp/connection.js';
import { createServer } from './http/server.js';
import { startFollowUpScheduler } from './follow-up/scheduler.js';

const log = createLogger('main');

async function main() {
  log.info(
    { version: '1.0.0', env: config.nodeEnv },
    'AlonDev WhatsApp Bot starting'
  );

  // 1. Initialize database
  const db = initDb();
  log.info('database initialized');

  // 2. Start HTTP server (health + QR endpoints)
  const server = createServer(config.port);
  log.info({ port: config.port }, 'HTTP server started');

  // 3. Connect to WhatsApp (triggers QR display)
  const sock = await connectWhatsApp();
  log.info('WhatsApp connection initiated');

  // 4. Start follow-up scheduler (checks every 15 minutes)
  startFollowUpScheduler(sock);
  log.info('follow-up scheduler started');

  log.info({ port: config.port }, 'Bot ready (with follow-up scheduler)');

  // Graceful shutdown
  const shutdown = () => {
    log.info('shutting down...');

    try {
      (sock as any)._wwebClient?.destroy();
    } catch {
      // client may already be closed
    }

    try {
      db.close();
    } catch {
      // db may already be closed
    }

    server.close(() => {
      log.info('HTTP server closed');
      process.exit(0);
    });

    // Force exit after 5 seconds if graceful close hangs
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error');
  process.exit(1);
});
