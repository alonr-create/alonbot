import { startServer } from './gateway/server.js';
import { registerAdapter, sendToChannel, sendAgentMessage } from './gateway/router.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { startAllCronJobs } from './cron/scheduler.js';
import { config } from './utils/config.js';
import cron from 'node-cron';

console.log('=== AlonBot ===');
console.log(`Mode: ${config.mode}`);
console.log(`Starting at ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);

// Start health check server (both modes)
startServer();

let telegram: ReturnType<typeof createTelegramAdapter> | null = null;

if (config.mode === 'cloud') {
  // --- CLOUD MODE: Telegram bot + cron (no local tools) ---
  telegram = createTelegramAdapter();
  registerAdapter(telegram);
  await telegram.start();

  // Start cron jobs from DB
  startAllCronJobs(sendToChannel);

  // Daily brief — 08:00 Israel time
  cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Daily brief firing');
    const briefMsg = `סיכום בוקר יומי:
1. מה התאריך היום (עברי ולועזי)?
2. מה מזג האוויר בתל אביב?
3. יש לידים חדשים בדקל לפרישה?
4. מה התזכורות הפעילות שלי?
5. תן ציטוט השראה קצר.`;
    await sendAgentMessage('telegram', config.allowedTelegram[0] || '', briefMsg);
  }, { timezone: 'Asia/Jerusalem' });

} else {
  // --- LOCAL MODE: cron only, no Telegram bot (avoids token conflict) ---
  // Register Telegram adapter for sending only (cron messages), but don't start polling
  telegram = createTelegramAdapter();
  registerAdapter(telegram);
  // Note: we don't call telegram.start() — no polling, just send-only via bot.api

  // Start cron jobs
  startAllCronJobs(sendToChannel);

  // Daily brief
  cron.schedule('0 8 * * *', async () => {
    console.log('[Cron] Daily brief firing');
    const briefMsg = `סיכום בוקר יומי:
1. מה התאריך היום (עברי ולועזי)?
2. מה מזג האוויר בתל אביב?
3. יש לידים חדשים בדקל לפרישה?
4. מה התזכורות הפעילות שלי?
5. תן ציטוט השראה קצר.`;
    await sendAgentMessage('telegram', config.allowedTelegram[0] || '', briefMsg);
  }, { timezone: 'Asia/Jerusalem' });

  console.log('[AlonBot] Local mode — cron jobs only (Telegram bot runs in cloud)');
}

console.log('[AlonBot] Ready!');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[AlonBot] Shutting down...');
  if (telegram && config.mode === 'cloud') await telegram.stop();
  process.exit(0);
});
