import 'dotenv/config';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { initDb, getDb } from './db/index.js';
import { connectWhatsApp } from './whatsapp/connection.js';
import { createServer } from './http/server.js';

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

  log.info({ port: config.port }, 'Bot ready');

  // Graceful shutdown
  const shutdown = () => {
    log.info('shutting down...');

    try {
      sock.end(undefined);
    } catch {
      // socket may already be closed
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
