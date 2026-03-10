/**
 * Daily morning summary — sends Alon a WhatsApp recap every morning at 09:00 Israel time.
 * Includes: pipeline overview, hot leads, pending follow-ups, yesterday's activity.
 */
import { getDb } from '../db/index.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import { getAdminPhone, getTimezone } from '../db/tenant-config.js';
import { createLogger } from '../utils/logger.js';
import type { BotAdapter } from '../whatsapp/connection.js';

const log = createLogger('daily-summary');

const DAILY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
let lastSentDate = '';

function getTz(): string {
  return getTimezone();
}

function getLocalDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: getTz() });
}

function getLocalHour(): number {
  return parseInt(
    new Date().toLocaleString('en-US', { timeZone: getTz(), hour: 'numeric', hour12: false }),
    10,
  );
}

function isWeekday(): boolean {
  const day = new Date().toLocaleDateString('en-US', { timeZone: getTz(), weekday: 'short' });
  return day !== 'Sat';
}

async function sendDailySummary(sock: BotAdapter): Promise<void> {
  const today = getLocalDate();
  if (lastSentDate === today) return;

  const hour = getLocalHour();
  if (hour !== 9) return; // Only send at 09:xx Israel time

  if (!isWeekday()) return; // Skip Shabbat

  lastSentDate = today;

  try {
    const db = getDb();
    const jid = getAdminPhone() + '@s.whatsapp.net';

    // Pipeline
    const statusCounts = db
      .prepare('SELECT status, COUNT(*) as count FROM leads GROUP BY status')
      .all() as Array<{ status: string; count: number }>;

    const total = statusCounts.reduce((sum, r) => sum + r.count, 0);
    const active = statusCounts
      .filter((r) => !['closed-won', 'closed-lost'].includes(r.status))
      .reduce((sum, r) => sum + r.count, 0);

    const statusMap: Record<string, string> = {
      new: 'חדש', contacted: 'נוצר קשר', 'in-conversation': 'בשיחה',
      'quote-sent': 'הצעה נשלחה', 'meeting-scheduled': 'פגישה נקבעה',
      escalated: 'מחכה לך', 'closed-won': 'נסגר ✅', 'closed-lost': 'נסגר ❌',
    };

    const statusLines = statusCounts
      .map((r) => `  ${statusMap[r.status] || r.status}: ${r.count}`)
      .join('\n');

    // Yesterday's activity
    const yesterday = db
      .prepare(
        `SELECT COUNT(*) as msgs FROM messages
         WHERE created_at >= date('now', '-1 day')`,
      )
      .get() as { msgs: number };

    const newLeadsYesterday = db
      .prepare(
        `SELECT COUNT(*) as count FROM leads
         WHERE created_at >= date('now', '-1 day')`,
      )
      .get() as { count: number };

    // Pending follow-ups today
    const pendingFU = db
      .prepare(
        `SELECT COUNT(*) as count FROM follow_ups
         WHERE sent_at IS NULL AND cancelled = 0
         AND scheduled_at <= datetime('now', '+12 hours')`,
      )
      .get() as { count: number };

    // Escalated leads waiting for Alon
    const escalated = db
      .prepare(
        `SELECT name, phone FROM leads WHERE status = 'escalated' ORDER BY updated_at DESC LIMIT 5`,
      )
      .all() as Array<{ name: string | null; phone: string }>;

    const escalatedLines = escalated.length > 0
      ? escalated.map((l) => `  ⚠️ ${l.name || l.phone}`).join('\n')
      : '  אין — הכל מטופל! 👏';

    // Hot leads
    const hot = db
      .prepare(
        `SELECT name, status, interest FROM leads
         WHERE status IN ('in-conversation', 'quote-sent')
         ORDER BY updated_at DESC LIMIT 5`,
      )
      .all() as Array<{ name: string | null; status: string; interest: string | null }>;

    const hotLines = hot.length > 0
      ? hot.map((l) => `  🔥 ${l.name || '?'} — ${statusMap[l.status] || l.status}${l.interest ? ` (${l.interest})` : ''}`).join('\n')
      : '  אין לידים חמים כרגע';

    const message = [
      `☀️ בוקר טוב בוס! הנה הסיכום שלך:`,
      '',
      `📊 Pipeline (${active} פעילים מתוך ${total}):`,
      statusLines,
      '',
      `📈 אתמול:`,
      `  ${yesterday.msgs} הודעות | ${newLeadsYesterday.count} לידים חדשים`,
      '',
      `🔥 לידים חמים:`,
      hotLines,
      '',
      `⚠️ מחכים לטיפולך:`,
      escalatedLines,
      '',
      `⏰ פולואפים היום: ${pendingFU.count}`,
      '',
      `יום מוצלח! 💪`,
    ].join('\n');

    await sendWithTyping(sock, jid, message);
    log.info('Daily summary sent to admin');
  } catch (err) {
    log.error({ err }, 'Failed to send daily summary');
  }
}

export function startDailySummaryScheduler(sock: BotAdapter): void {
  log.info('Daily summary scheduler started (hourly check)');

  // Check immediately on startup
  sendDailySummary(sock).catch((err) =>
    log.error({ err }, 'daily summary initial check error'),
  );

  // Then every hour
  setInterval(() => {
    sendDailySummary(sock).catch((err) =>
      log.error({ err }, 'daily summary check error'),
    );
  }, DAILY_CHECK_INTERVAL_MS);
}
