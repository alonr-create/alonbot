import { startServer, registerWebhook } from './gateway/server.js';
import { registerAdapter, sendToChannel, sendAgentMessage } from './gateway/router.js';
import { createTelegramAdapter } from './channels/telegram.js';
import { createWhatsAppAdapter } from './channels/whatsapp.js';
import { createWhatsAppCloudAdapter } from './channels/whatsapp-cloud.js';
import { startAllCronJobs } from './cron/scheduler.js';
import { runSalesManagerCheck } from './cron/sales-manager.js';
import { config } from './utils/config.js';
import { setupGitAuth } from './utils/git-auth.js';
import { embedUnembeddedMemories, runMemoryMaintenance } from './agent/memory.js';
import { executeWorkflowActions } from './agent/tools.js';
import { loadTools } from './tools/registry.js';
import { db, backupLeads } from './utils/db.js';
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

log.info({ mode: config.mode, startedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC' }, 'AlonBot starting');

let telegram: ReturnType<typeof createTelegramAdapter> | null = null;

// --- Telegram ---
if (config.telegramBotToken) {
  telegram = createTelegramAdapter();
  registerAdapter(telegram);

  if (config.mode === 'cloud') {
    // Cloud mode: webhook (avoids 409 conflicts during deploys)
    registerWebhook('/telegram-webhook', telegram.getWebhookHandler!());
  }
  // Both modes: start Telegram (cloud = webhook, local = polling)
  await telegram.start();
} else {
  log.warn('TELEGRAM_BOT_TOKEN not set — Telegram disabled');
}

// Start server AFTER webhook is registered
startServer();

// --- WhatsApp ---
if (config.whatsappMode === 'cloud' && config.waCloudToken) {
  // Cloud API mode — works in both local and cloud modes
  try {
    const whatsappCloud = createWhatsAppCloudAdapter();
    registerAdapter(whatsappCloud);
    registerWebhook('/whatsapp-cloud-webhook', whatsappCloud.getWebhookHandler!());
    await whatsappCloud.start();
    log.info('WhatsApp Cloud API adapter started');
  } catch (err: any) {
    log.warn({ err: err.message }, 'WhatsApp Cloud API failed to start');
  }
} else if (config.mode === 'local' && config.allowedWhatsApp.length > 0) {
  // Baileys mode — local only
  try {
    const whatsapp = createWhatsAppAdapter();
    registerAdapter(whatsapp);
    await whatsapp.start();
    log.info('WhatsApp Baileys adapter started');
  } catch (err: any) {
    log.warn({ err: err.message }, 'WhatsApp Baileys failed to start');
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

// Sales Manager AI — analyze bot conversations every 2 hours (cloud only, 08:00-22:00)
cron.schedule('7 8,10,12,14,16,18,20,22 * * *', async () => {
  if (config.mode !== 'cloud') return;
  runSalesManagerCheck().catch(e =>
    log.error({ err: e.message }, 'sales manager cron failed')
  );
}, { timezone: 'Asia/Jerusalem' });

// Scheduled messages check — every minute (cloud only)
cron.schedule('* * * * *', async () => {
  if (config.mode !== 'cloud') return;
  try {
    // Israel time for scheduled message comparison (YYYY-MM-DD HH:MM format)
    // We construct a Date in Israel timezone via en-US locale parse, then format as ISO-like string.
    const israelNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const now = israelNow.getFullYear()
      + '-' + String(israelNow.getMonth() + 1).padStart(2, '0')
      + '-' + String(israelNow.getDate()).padStart(2, '0')
      + ' ' + String(israelNow.getHours()).padStart(2, '0')
      + ':' + String(israelNow.getMinutes()).padStart(2, '0');
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

// Daily leads JSON backup (3am) — easy to recover individual records
cron.schedule('0 3 * * *', () => {
  backupLeads();
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

// Abandoned cart recovery — every 10 minutes, check for unpaid checkout visits older than 30 min
cron.schedule('*/10 * * * *', async () => {
  if (config.mode !== 'cloud') return;
  // Skip quiet hours (22:00-08:00 Israel time)
  const israelHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }));
  if (israelHour >= 22 || israelHour < 8) return;
  try {
    const unpaid = db.prepare(
      `SELECT * FROM checkout_visits WHERE paid = 0 AND reminded = 0 AND created_at <= datetime('now', '-30 minutes') LIMIT 10`
    ).all() as any[];

    for (const visit of unpaid) {
      const phone = visit.phone;
      const name = visit.name || '';
      const plan = visit.plan === 'premium' ? 'פרימיום' : 'בסיסי';
      try {
        const { getAdapter } = await import('./gateway/router.js');
        const wa = getAdapter('whatsapp');
        if (wa) {
          await wa.sendReply(
            { id: 'cart', channel: 'whatsapp' as const, senderId: phone, senderName: name, text: '', timestamp: Date.now(), raw: { from: `${phone}@s.whatsapp.net` } },
            { text: `היי${name ? ' ' + name : ''} 👋\n\nראיתי שהתחלת להזמין אתר (חבילת ${plan}) אבל לא סיימת — הכל בסדר?\n\n💡 אם נתקעת או יש שאלות — אני כאן!\nאם רוצה להמשיך: https://checkout.alondev.site/?plan=${visit.plan || 'basic'}${name ? '&name=' + encodeURIComponent(name) : ''}\n\n⏰ המבצע עדיין בתוקף, אבל לא לעוד הרבה זמן!` }
          );
          log.info({ phone, plan: visit.plan }, 'abandoned cart follow-up sent');
        }
      } catch (e: any) { log.warn({ err: e.message, phone }, 'abandoned cart WA send failed'); }
      db.prepare('UPDATE checkout_visits SET reminded = 1 WHERE id = ?').run(visit.id);
    }
  } catch (e: any) {
    log.error({ err: e.message }, 'abandoned cart cron failed');
  }
}, { timezone: 'Asia/Jerusalem' });

// Google Review request — daily at 11:00, check for orders delivered 48h ago
cron.schedule('0 11 * * *', async () => {
  if (config.mode !== 'cloud') return;
  try {
    const delivered = db.prepare(
      `SELECT * FROM orders WHERE status = 'delivered' AND review_requested = 0 AND updated_at <= datetime('now', '-48 hours') LIMIT 20`
    ).all() as any[];

    for (const order of delivered) {
      const phone = order.phone;
      const name = order.name || '';
      try {
        const { getAdapter } = await import('./gateway/router.js');
        const wa = getAdapter('whatsapp');
        if (wa) {
          await wa.sendReply(
            { id: 'review', channel: 'whatsapp' as const, senderId: phone, senderName: name, text: '', timestamp: Date.now(), raw: { from: `${phone}@s.whatsapp.net` } },
            { text: `היי${name ? ' ' + name : ''} 😊\n\nמקווה שאת/ה מרוצה מהאתר החדש! 🎉\n\nיש לנו בקשה קטנה — ביקורת בגוגל עוזרת לנו מאוד להגיע ליותר עסקים כמוך:\n⭐ https://g.page/r/alon-dev/review\n\nתודה רבה! 🙏` }
          );
          log.info({ phone, name }, 'Google review request sent');
        }
      } catch (e: any) { log.warn({ err: e.message, phone }, 'review request WA send failed'); }
      db.prepare(`UPDATE orders SET review_requested = 1 WHERE id = ?`).run(order.id);
    }
  } catch (e: any) {
    log.error({ err: e.message }, 'review request cron failed');
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

// Alon.dev leads outreach — check Monday board every 5 minutes for new leads, send WhatsApp
cron.schedule('*/5 * * * *', async () => {
  try {
    const mondayKey = config.mondayApiKey;
    if (!mondayKey) return;

    // Query "לידים אלון" board for leads with default status (Working on it = 0)
    const query = `{ boards(ids: 5092777389) { items_page(limit: 20, query_params: { rules: [{ column_id: "status", compare_value: [0], operator: any_of }] }) { items { id name column_values(ids: ["phone_mm16hqz2", "text_mm16pfzp", "long_text_mm16k6vr"]) { id text value } } } } }`;

    const resp = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': mondayKey },
      body: JSON.stringify({ query }),
    });
    const data = await resp.json() as any;
    const items = data?.data?.boards?.[0]?.items_page?.items || [];

    for (const item of items) {
      const phoneCol = item.column_values?.find((c: any) => c.id === 'phone_mm16hqz2');
      const sourceCol = item.column_values?.find((c: any) => c.id === 'text_mm16pfzp');
      // Parse phone from value JSON (Monday stores as {"phone":"xxx","countryShortName":"IL"})
      let phone = '';
      try {
        const phoneData = JSON.parse(phoneCol?.value || '{}');
        phone = phoneData.phone || phoneCol?.text || '';
      } catch (e) { log.debug({ err: (e as Error).message }, 'phone JSON parse failed'); phone = phoneCol?.text || ''; }

      if (!phone) continue;
      // Normalize phone
      phone = phone.replace(/[-\s()]/g, '');
      if (phone.startsWith('0')) phone = '972' + phone.slice(1);
      if (phone.startsWith('+')) phone = phone.slice(1);

      // Check if we already contacted this lead (in local DB)
      const existing = db.prepare('SELECT id FROM leads WHERE phone = ? AND source = ?').get(phone, 'alon_dev') as any;
      if (existing) continue;

      // Register in local DB
      db.prepare('INSERT OR IGNORE INTO leads (phone, name, source, monday_item_id) VALUES (?, ?, ?, ?)').run(phone, item.name, 'alon_dev', item.id);

      // Send WhatsApp message
      const msg = `היי ${item.name || ''}! 👋 אני מצוות Alon.dev. ראיתי שהתעניינת בשירותים שלנו — אשמח לעזור! מה העסק שלך ואיך אפשר לסייע?`;
      try {
        await fetch(`http://localhost:${config.port}/api/send-whatsapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-secret': config.localApiSecret },
          body: JSON.stringify({ phone, message: msg }),
        });
        log.info({ phone, name: item.name, mondayId: item.id }, 'alon.dev lead outreach sent');
      } catch (e: any) {
        log.error({ err: e.message, phone }, 'alon.dev lead outreach failed');
      }

      // Update Monday status to "Done" (1) to avoid resending
      const updateQuery = `mutation { change_simple_column_value(board_id: 5092777389, item_id: ${item.id}, column_id: "status", value: "1") { id } }`;
      await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': mondayKey },
        body: JSON.stringify({ query: updateQuery }),
      }).catch((e: any) => { log.warn({ err: e.message, itemId: item.id }, 'Monday status update failed'); });
    }
  } catch (e: any) {
    log.error({ err: e.message }, 'alon.dev leads check failed');
  }
}, { timezone: 'Asia/Jerusalem' });

// Lead follow-up — delegated to followup-engine (template-based, no SYSTEM leaks)
// The followup-engine.ts cron handles this automatically via setupFollowupCron()
// Removed: old sendAgentMessage approach leaked [SYSTEM:...] prompts to customers

// Memory maintenance — daily at 03:00 (decay, consolidate, cleanup)
cron.schedule('0 3 * * *', async () => {
  log.info('memory maintenance starting');
  const stats = await runMemoryMaintenance();
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
  try { db.close(); } catch (e) { log.warn({ err: (e as Error).message }, 'DB close on shutdown failed'); }
  process.exit(0);
});
