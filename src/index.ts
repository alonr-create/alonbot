import { startServer } from './gateway/server.js';
import { registerAdapter, sendToChannel } from './gateway/router.js';
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

const whatsapp = createWhatsAppAdapter();
registerAdapter(whatsapp);
await whatsapp.start();

// Start cron jobs
startAllCronJobs(sendToChannel);

console.log('[AlonBot] Ready!');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[AlonBot] Shutting down...');
  await telegram.stop();
  await whatsapp.stop();
  process.exit(0);
});
