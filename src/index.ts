import 'dotenv/config';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { initDb, getDb } from './db/index.js';
import { connectWhatsApp } from './whatsapp/connection.js';
import { createServer } from './http/server.js';
import { startFollowUpScheduler } from './follow-up/scheduler.js';
import { startDailySummaryScheduler } from './schedulers/daily-summary.js';
import { startWeeklyReportScheduler } from './schedulers/weekly-report.js';
import { startReminderScheduler } from './schedulers/reminders.js';

const log = createLogger('main');

async function main() {
  log.info(
    { version: '1.0.0', env: config.nodeEnv },
    'AlonDev WhatsApp Bot starting'
  );

  // 1. Initialize database
  const db = initDb();
  log.info('database initialized');

  // 1b. Admin phone records kept in DB — needed for personal tab in 360Shmikley
  // Fix admin lead name (one-time: was created with tenant name instead of personal name)
  const adminPhone = process.env.ALON_PHONE || '972546300783';
  db.prepare(`UPDATE leads SET name = 'אלון רחמים' WHERE phone = ? AND (name IS NULL OR name = '' OR name = 'דקל')`).run(adminPhone);

  // 2. Start HTTP server (health + QR endpoints)
  const server = createServer(config.port);
  log.info({ port: config.port }, 'HTTP server started');

  // 3. Connect to WhatsApp
  // Skip whatsapp-web.js entirely when SKIP_WWEBJS=true (Render/Cloud API mode)
  // Chromium consumes too much RAM on 512MB instances and blocks the event loop
  let sock: Awaited<ReturnType<typeof connectWhatsApp>> | null = null;
  if (process.env.SKIP_WWEBJS === 'true') {
    log.info('whatsapp-web.js skipped (SKIP_WWEBJS=true) — Cloud API + CRM mode');
  } else {
    try {
      sock = await connectWhatsApp();
      log.info('WhatsApp connection initiated');
    } catch (err) {
      log.warn({ err }, 'whatsapp-web.js failed to connect — HTTP server continues');
    }
  }

  // 4. Start follow-up scheduler (checks every 15 minutes)
  if (sock) {
    startFollowUpScheduler(sock);
    log.info('follow-up scheduler started');

    // 5. Start daily summary scheduler (sends Alon a morning recap)
    startDailySummaryScheduler(sock);
    log.info('daily summary scheduler started');

    // 6. Start weekly report scheduler (sends Alon a Sunday recap)
    startWeeklyReportScheduler(sock);
    log.info('weekly report scheduler started');

    // 7. Start reminder scheduler (checks every minute for due reminders)
    startReminderScheduler(sock);
    log.info('reminder scheduler started');
  } else {
    log.warn('schedulers skipped — no whatsapp-web.js connection (Cloud API path unaffected)');
  }

  log.info({ port: config.port }, 'Bot ready (all schedulers active)');

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
