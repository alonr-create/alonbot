import { startServer } from './gateway/server.js';
import { registerAdapter, sendToChannel, sendAgentMessage } from './gateway/router.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { createWhatsAppAdapter } from './channels/whatsapp.js';
import { startAllCronJobs } from './cron/scheduler.js';
import { config } from './utils/config.js';
import { embedUnembeddedMemories, runMemoryMaintenance } from './agent/memory.js';
import { executeWorkflowActions } from './agent/tools.js';
import { db } from './utils/db.js';
import cron from 'node-cron';

// DND check — skip proactive messages during quiet hours (23:00-07:00 Israel)
function isDND(): boolean {
  const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }));
  return hour >= 23 || hour < 7;
}

console.log('=== AlonBot ===');
console.log(`Mode: ${config.mode}`);
console.log(`Starting at ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}`);

// Start health check server (both modes)
startServer();

let telegram: ReturnType<typeof createTelegramAdapter> | null = null;

// --- Telegram ---
telegram = createTelegramAdapter();
registerAdapter(telegram);

if (config.mode === 'cloud') {
  // Cloud mode: full Telegram polling
  await telegram.start();
} else {
  // Local mode: send-only (no polling — avoids token conflict with cloud)
  console.log('[AlonBot] Local mode — Telegram send-only');
}

// --- WhatsApp (optional, local mode only) ---
if (config.mode === 'local' && config.allowedWhatsApp.length > 0) {
  try {
    const whatsapp = createWhatsAppAdapter();
    registerAdapter(whatsapp);
    await whatsapp.start();
    console.log('[AlonBot] WhatsApp adapter started');
  } catch (err: any) {
    console.warn('[AlonBot] WhatsApp failed to start:', err.message);
  }
}

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

// Embed any memories that don't have vectors yet (background)
embedUnembeddedMemories().catch(err =>
  console.error('[Embed] Startup embed failed:', err.message)
);

// Proactive: overdue tasks check — 18:00 daily
cron.schedule('0 18 * * *', async () => {
  const targetId = config.allowedTelegram[0];
  if (!targetId || isDND()) return;
  try {
    const overdue = db.prepare(
      "SELECT id, title, due_date FROM tasks WHERE status = 'pending' AND due_date IS NOT NULL AND due_date < date('now') ORDER BY due_date"
    ).all() as any[];
    if (overdue.length > 0) {
      const list = overdue.map(t => `- #${t.id} ${t.title} (${t.due_date})`).join('\n');
      await sendToChannel('telegram', targetId, `⚠️ יש לך ${overdue.length} משימות שעבר הזמן שלהן:\n${list}`);
    }
  } catch (e: any) {
    console.error('[Proactive] Overdue tasks check failed:', e.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Proactive: weekly summary — Sunday 09:00
cron.schedule('0 9 * * 0', async () => {
  const targetId = config.allowedTelegram[0];
  if (!targetId) return;
  await sendAgentMessage('telegram', targetId,
    `סיכום שבועי:\n1. כמה שילמתי על API השבוע?\n2. כמה משימות פתוחות?\n3. מה ההודעות האחרונות בדקל?\n4. מה התוכניות לשבוע הקרוב?`
  );
}, { timezone: 'Asia/Jerusalem' });

// Cost alert — check at 21:00 if daily spend exceeded $0.50
cron.schedule('0 21 * * *', async () => {
  const targetId = config.allowedTelegram[0];
  if (!targetId || isDND()) return;
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as calls FROM api_usage WHERE date(created_at) = date('now')"
    ).get() as any;
    if (row.cost > 0.50) {
      await sendToChannel('telegram', targetId,
        `💰 התראת עלויות: שילמת היום $${row.cost.toFixed(4)} על ${row.calls} קריאות API.\nתקציב יומי מומלץ: $0.50`
      );
    }
  } catch (e: any) {
    console.error('[Proactive] Cost alert failed:', e.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Scheduled messages check — every minute
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const pending = db.prepare(
      "SELECT * FROM scheduled_messages WHERE sent = 0 AND send_at <= ?"
    ).all(now) as any[];

    for (const msg of pending) {
      const prefix = msg.label ? `⏰ ${msg.label}:\n` : '⏰ תזכורת:\n';
      await sendToChannel(msg.channel, msg.target_id, prefix + msg.message);
      db.prepare('UPDATE scheduled_messages SET sent = 1 WHERE id = ?').run(msg.id);
      console.log(`[Cron] Scheduled message #${msg.id} sent`);
    }
  } catch (e: any) {
    console.error('[Cron] Scheduled messages check failed:', e.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Daily DB backup — 02:00 Israel time (send to Telegram as file)
cron.schedule('0 2 * * *', async () => {
  const targetId = config.allowedTelegram[0];
  if (!targetId || !config.telegramBotToken) return;
  try {
    const backupPath = `/tmp/alonbot-backup-auto-${Date.now()}.db`;
    db.exec(`VACUUM INTO '${backupPath}'`);
    const { readFileSync, unlinkSync } = await import('fs');
    const buf = readFileSync(backupPath);
    const { Bot, InputFile } = await import('grammy');
    const bot = new Bot(config.telegramBotToken);
    await bot.api.sendDocument(Number(targetId),
      new InputFile(buf, `alonbot-backup-${new Date().toISOString().slice(0, 10)}.db`),
      { caption: `גיבוי אוטומטי — ${(buf.length / 1024).toFixed(0)} KB` }
    );
    unlinkSync(backupPath);
    console.log('[Cron] DB backup sent to Telegram');
  } catch (e: any) {
    console.error('[Cron] DB backup failed:', e.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Workflow Engine — check cron-triggered workflows every minute
cron.schedule('* * * * *', async () => {
  try {
    const workflows = db.prepare(
      "SELECT * FROM workflows WHERE enabled = 1 AND trigger_type = 'cron'"
    ).all() as any[];
    const now = new Date();
    for (const wf of workflows) {
      if (cron.validate(wf.trigger_value) && matchesCronNow(wf.trigger_value, now)) {
        console.log(`[Workflow] Cron triggered: "${wf.name}"`);
        const actions = JSON.parse(wf.actions);
        const targetId = config.allowedTelegram[0] || '';
        const results = await executeWorkflowActions(actions, { channel: 'telegram', targetId });
        // Send workflow messages to user
        for (const r of results) {
          if (r.startsWith('Message: ')) {
            await sendToChannel('telegram', targetId, r.slice(9));
          }
        }
      }
    }
  } catch (e: any) {
    console.error('[Workflow] Cron check failed:', e.message);
  }
}, { timezone: 'Asia/Jerusalem' });

// Simple cron expression matcher for current minute
function matchesCronNow(expr: string, now: Date): boolean {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return false;
  const minute = now.getMinutes();
  const hour = now.getHours();
  const dayOfMonth = now.getDate();
  const month = now.getMonth() + 1;
  const dayOfWeek = now.getDay();
  const fields = [minute, hour, dayOfMonth, month, dayOfWeek];
  return parts.every((part, i) => {
    if (part === '*') return true;
    if (part.includes('/')) {
      const [, step] = part.split('/');
      return fields[i] % parseInt(step) === 0;
    }
    if (part.includes(',')) return part.split(',').map(Number).includes(fields[i]);
    if (part.includes('-')) {
      const [min, max] = part.split('-').map(Number);
      return fields[i] >= min && fields[i] <= max;
    }
    return parseInt(part) === fields[i];
  });
}

// Memory maintenance — daily at 03:00 (decay, consolidate, cleanup)
cron.schedule('0 3 * * *', () => {
  console.log('[Cron] Memory maintenance');
  const stats = runMemoryMaintenance();
  console.log(`[Memory] Maintenance done: ${stats.decayed} decayed, ${stats.consolidated} consolidated, ${stats.deleted} deleted`);
}, { timezone: 'Asia/Jerusalem' });

console.log('[AlonBot] Ready!');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[AlonBot] Shutting down...');
  if (telegram && config.mode === 'cloud') await telegram.stop();
  process.exit(0);
});
