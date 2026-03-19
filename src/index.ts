import { startServer, registerWebhook } from './gateway/server.js';
import { registerAdapter, sendToChannel, sendAgentMessage } from './gateway/router.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { createWhatsAppAdapter } from './channels/whatsapp.js';
import { startAllCronJobs } from './cron/scheduler.js';
import { config } from './utils/config.js';
import { setupGitAuth } from './utils/git-auth.js';
import { embedUnembeddedMemories, runMemoryMaintenance } from './agent/memory.js';
import { executeWorkflowActions } from './agent/tools.js';
import { loadTools } from './tools/registry.js';
import { db } from './utils/db.js';
import { runMigrations } from './utils/migrate.js';
import cron from 'node-cron';
import { createLogger } from './utils/logger.js';

const log = createLogger('main');

// Setup git authentication via GIT_ASKPASS (before any tool execution)
setupGitAuth();

// Run database migrations (before anything uses DB)
await runMigrations(db);

// Load all tool handlers from registry (must happen before server starts)
await loadTools();

// DND check — skip proactive messages during quiet hours (23:00-07:00 Israel)
function isDND(): boolean {
  const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }));
  return hour >= 23 || hour < 7;
}

log.info({ mode: config.mode, startedAt: new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) }, 'AlonBot starting');

let telegram: ReturnType<typeof createTelegramAdapter> | null = null;

// --- Telegram ---
if (config.telegramBotToken) {
  telegram = createTelegramAdapter();
  registerAdapter(telegram);

  if (config.mode === 'cloud') {
    // Cloud mode: webhook (avoids 409 conflicts during deploys)
    registerWebhook('/telegram-webhook', telegram.getWebhookHandler!());
    await telegram.start();
  } else {
    // Local mode: send-only (no polling — avoids token conflict with cloud)
    log.info('local mode — Telegram send-only');
  }
} else {
  log.warn('TELEGRAM_BOT_TOKEN not set — Telegram disabled');
}

// Start server AFTER webhook is registered
startServer();

// --- WhatsApp (optional, local mode only) ---
if (config.mode === 'local' && config.allowedWhatsApp.length > 0) {
  try {
    const whatsapp = createWhatsAppAdapter();
    registerAdapter(whatsapp);
    await whatsapp.start();
    log.info('WhatsApp adapter started');
  } catch (err: any) {
    log.warn({ err: err.message }, 'WhatsApp failed to start');
  }
}

// Start cron jobs from DB
startAllCronJobs(sendToChannel);

// Smart daily brief — 08:00 Israel time (cloud only to prevent duplicates)
// Only reports things that actually changed, not static questions
cron.schedule('0 8 * * *', async () => {
  if (config.mode !== 'cloud') return;
  const targetId = config.allowedTelegram[0];
  if (!targetId) return;
  log.info('smart daily brief firing');
  const briefMsg = `סיכום בוקר חכם — בדוק מה באמת השתנה ודווח רק על הרלוונטי:

1. תאריך היום (עברי + לועזי) + יום בשבוע.
2. בדוק ב-Monday.com (monday_api) אם יש לידים חדשים מאתמול בדקל לפרישה (board 1443236269, group new_group28956). אם יש — תפרט שם + מקור. אם אין — תגיד "אין לידים חדשים".
3. בדוק אם יש פגישות היום ביומן (calendar_list, days=1).
4. בדוק תזכורות פעילות (list_reminders).
5. בדוק משימות שעבר הזמן שלהן (list_tasks).
6. בדוק סטטוס קמפיינים בפייסבוק (fb_ads: account_overview לdekel ולalon.dev) — תדווח הוצאה ולידים מ-7 ימים אחרונים.
7. ציטוט השראה קצר.

**חוקים**: אם אין שינוי בקטגוריה — תדלג עליה. תן סיכום קצר ותכליתי, לא רשימות ארוכות.`;
  await sendAgentMessage('telegram', targetId, briefMsg);
}, { timezone: 'Asia/Jerusalem' });

// Embed any memories that don't have vectors yet (background)
embedUnembeddedMemories().catch(err =>
  log.error({ err: err.message }, 'startup embed failed')
);

// Proactive: overdue tasks check — 18:00 daily (cloud only)
cron.schedule('0 18 * * *', async () => {
  if (config.mode !== 'cloud') return;
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
    log.error({ err: e.message }, 'overdue tasks check failed');
  }
}, { timezone: 'Asia/Jerusalem' });

// Proactive: weekly summary — Sunday 09:00 (cloud only)
cron.schedule('0 9 * * 0', async () => {
  if (config.mode !== 'cloud') return;
  const targetId = config.allowedTelegram[0];
  if (!targetId) return;
  await sendAgentMessage('telegram', targetId,
    `סיכום שבועי:\n1. כמה שילמתי על API השבוע?\n2. כמה משימות פתוחות?\n3. מה ההודעות האחרונות בדקל?\n4. מה התוכניות לשבוע הקרוב?`
  );
}, { timezone: 'Asia/Jerusalem' });

// Cost alert — check at 21:00 if daily spend exceeded $0.50 (cloud only)
cron.schedule('0 21 * * *', async () => {
  if (config.mode !== 'cloud') return;
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
    log.error({ err: e.message }, 'cost alert failed');
  }
}, { timezone: 'Asia/Jerusalem' });

// Scheduled messages check — every minute (cloud only)
cron.schedule('* * * * *', async () => {
  if (config.mode !== 'cloud') return;
  try {
    // Use Israel time (sv-SE locale gives YYYY-MM-DD HH:mm format)
    const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 16);
    const pending = db.prepare(
      "SELECT * FROM scheduled_messages WHERE sent = 0 AND send_at <= ?"
    ).all(now) as any[];

    for (const msg of pending) {
      const prefix = msg.label ? `⏰ ${msg.label}:\n` : '⏰ תזכורת:\n';
      await sendToChannel(msg.channel, msg.target_id, prefix + msg.message);
      db.prepare('UPDATE scheduled_messages SET sent = 1 WHERE id = ?').run(msg.id);
      log.info({ messageId: msg.id }, 'scheduled message sent');
    }
  } catch (e: any) {
    log.error({ err: e.message }, 'scheduled messages check failed');
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
    log.info('DB backup sent to Telegram');
  } catch (e: any) {
    log.error({ err: e.message }, 'DB backup failed');
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
        log.info({ name: wf.name }, 'workflow cron triggered');
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
    log.error({ err: e.message }, 'workflow cron check failed');
  }
}, { timezone: 'Asia/Jerusalem' });

// Simple cron expression matcher for current minute (Israel timezone)
function matchesCronNow(expr: string, now: Date): boolean {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) return false;
  // Use Israel timezone to avoid UTC mismatch on cloud
  const israelStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
  const israelDate = new Date(israelStr);
  const minute = israelDate.getMinutes();
  const hour = israelDate.getHours();
  const dayOfMonth = israelDate.getDate();
  const month = israelDate.getMonth() + 1;
  const dayOfWeek = israelDate.getDay();
  const fields = [minute, hour, dayOfMonth, month, dayOfWeek];
  return parts.every((part, i) => {
    if (part === '*') return true;
    if (part.includes('/')) {
      const [base, step] = part.split('/');
      const stepNum = parseInt(step);
      if (stepNum <= 0) return false;
      const start = base === '*' ? 0 : parseInt(base);
      return (fields[i] - start) % stepNum === 0 && fields[i] >= start;
    }
    if (part.includes(',')) return part.split(',').map(Number).includes(fields[i]);
    if (part.includes('-')) {
      const [min, max] = part.split('-').map(Number);
      return fields[i] >= min && fields[i] <= max;
    }
    return parseInt(part) === fields[i];
  });
}

// Batch API polling — check pending batches every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  try {
    const { pollBatches } = await import('./agent/batch.js');
    const processed = await pollBatches();
    if (processed > 0) {
      log.info({ processed }, 'processed completed batches');
    }
  } catch (e: any) {
    log.error({ err: e.message }, 'batch poll failed');
  }
}, { timezone: 'Asia/Jerusalem' });

// Memory maintenance — daily at 03:00 (decay, consolidate, cleanup)
cron.schedule('0 3 * * *', () => {
  log.info('memory maintenance starting');
  const stats = runMemoryMaintenance();
  log.info({ decayed: stats.decayed, consolidated: stats.consolidated, deleted: stats.deleted }, 'memory maintenance done');
}, { timezone: 'Asia/Jerusalem' });

log.info('ready');

// Handle uncaught errors gracefully (don't crash on transient issues)
process.on('uncaughtException', (err) => {
  log.error({ err: err.message }, 'uncaughtException');
  // Don't exit — let the bot recover
});
process.on('unhandledRejection', (err: any) => {
  log.error({ err: err?.message || String(err) }, 'unhandledRejection');
  // Don't exit — let the bot recover
});

// Graceful shutdown
process.on('SIGINT', async () => {
  log.info('shutting down');
  if (telegram && config.mode === 'cloud') await telegram.stop();
  try { db.close(); } catch { /* graceful shutdown */ }
  process.exit(0);
});
