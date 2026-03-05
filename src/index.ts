import { startServer } from './gateway/server.js';
import { registerAdapter, sendToChannel, sendAgentMessage } from './gateway/router.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { createWhatsAppAdapter } from './channels/whatsapp.js';
import { startAllCronJobs } from './cron/scheduler.js';
import { config } from './utils/config.js';

console.log('=== AlonBot ===');
console.log(`Starting at ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);

// Start health check server
startServer();

// Register and start channel adapters
const telegram = createTelegramAdapter();
registerAdapter(telegram);
await telegram.start();

// WhatsApp disabled temporarily — rate limited. Uncomment to enable:
// const whatsapp = createWhatsAppAdapter();
// registerAdapter(whatsapp);
// whatsapp.start().catch(err => console.warn('[WhatsApp] Failed to start:', err.message));

// Start cron jobs from DB
startAllCronJobs(sendToChannel);

// Built-in daily brief — 08:00 Israel time
import cron from 'node-cron';
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

console.log('[AlonBot] Ready!');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[AlonBot] Shutting down...');
  await telegram.stop();
  // await whatsapp.stop();
  process.exit(0);
});
