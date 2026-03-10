/**
 * Weekly report — sends Alon a WhatsApp summary every Sunday at 09:30 Israel time.
 * Includes: total leads, new leads this week, meetings booked, closed deals,
 * top leads by score, conversion rate, comparison to last week.
 */
import { getDb } from '../db/index.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import { getAdminPhone, getTimezone } from '../db/tenant-config.js';
import { createLogger } from '../utils/logger.js';
import type { BotAdapter } from '../whatsapp/connection.js';

const log = createLogger('weekly-report');

const WEEKLY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
let lastSentWeek = '';

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

function getLocalDayOfWeek(): string {
  return new Date().toLocaleDateString('en-US', { timeZone: getTz(), weekday: 'short' });
}

/** Get ISO week identifier (YYYY-Www) for dedup */
function getWeekId(): string {
  const now = new Date();
  const d = new Date(now.toLocaleString('en-US', { timeZone: getTz() }));
  const dayNum = d.getDay(); // 0=Sun
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  const diff = d.getTime() - startOfYear.getTime();
  const weekNum = Math.ceil((diff / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

async function sendWeeklyReport(sock: BotAdapter): Promise<void> {
  const weekId = getWeekId();
  if (lastSentWeek === weekId) return;

  const day = getLocalDayOfWeek();
  if (day !== 'Sun') return; // Only on Sunday

  const hour = getLocalHour();
  if (hour !== 9) return; // Only at 09:xx (covers 09:30 within the hourly check)

  lastSentWeek = weekId;

  try {
    const db = getDb();
    const jid = getAdminPhone() + '@s.whatsapp.net';

    // ── This week stats (last 7 days) ──
    const newLeadsThisWeek = db
      .prepare(
        `SELECT COUNT(*) as count FROM leads
         WHERE created_at >= date('now', '-7 days')`,
      )
      .get() as { count: number };

    const totalLeads = db
      .prepare('SELECT COUNT(*) as count FROM leads')
      .get() as { count: number };

    const meetingsThisWeek = db
      .prepare(
        `SELECT COUNT(*) as count FROM leads
         WHERE status = 'meeting-scheduled'
         AND updated_at >= date('now', '-7 days')`,
      )
      .get() as { count: number };

    const closedWonThisWeek = db
      .prepare(
        `SELECT COUNT(*) as count FROM leads
         WHERE status = 'closed-won'
         AND updated_at >= date('now', '-7 days')`,
      )
      .get() as { count: number };

    const closedLostThisWeek = db
      .prepare(
        `SELECT COUNT(*) as count FROM leads
         WHERE status = 'closed-lost'
         AND updated_at >= date('now', '-7 days')`,
      )
      .get() as { count: number };

    const messagesThisWeek = db
      .prepare(
        `SELECT COUNT(*) as count FROM messages
         WHERE created_at >= date('now', '-7 days')`,
      )
      .get() as { count: number };

    // ── Last week stats (7-14 days ago) for comparison ──
    const newLeadsLastWeek = db
      .prepare(
        `SELECT COUNT(*) as count FROM leads
         WHERE created_at >= date('now', '-14 days')
         AND created_at < date('now', '-7 days')`,
      )
      .get() as { count: number };

    const closedWonLastWeek = db
      .prepare(
        `SELECT COUNT(*) as count FROM leads
         WHERE status = 'closed-won'
         AND updated_at >= date('now', '-14 days')
         AND updated_at < date('now', '-7 days')`,
      )
      .get() as { count: number };

    const messagesLastWeek = db
      .prepare(
        `SELECT COUNT(*) as count FROM messages
         WHERE created_at >= date('now', '-14 days')
         AND created_at < date('now', '-7 days')`,
      )
      .get() as { count: number };

    // ── Top leads (most recently active, in-conversation or quote-sent) ──
    const topLeads = db
      .prepare(
        `SELECT name, phone, status, interest FROM leads
         WHERE status IN ('in-conversation', 'quote-sent', 'meeting-scheduled')
         ORDER BY updated_at DESC LIMIT 5`,
      )
      .all() as Array<{ name: string | null; phone: string; status: string; interest: string | null }>;

    const statusMap: Record<string, string> = {
      new: 'חדש', contacted: 'נוצר קשר', 'in-conversation': 'בשיחה',
      'quote-sent': 'הצעה נשלחה', 'meeting-scheduled': 'פגישה נקבעה',
      escalated: 'מחכה לך', 'closed-won': 'נסגר ✅', 'closed-lost': 'נסגר ❌',
    };

    const topLeadLines = topLeads.length > 0
      ? topLeads.map((l) => `  🎯 ${l.name || l.phone} — ${statusMap[l.status] || l.status}${l.interest ? ` (${l.interest})` : ''}`).join('\n')
      : '  אין לידים חמים השבוע';

    // ── Conversion rate ──
    const totalClosed = closedWonThisWeek.count + closedLostThisWeek.count;
    const conversionRate = totalClosed > 0
      ? Math.round((closedWonThisWeek.count / totalClosed) * 100)
      : 0;

    // ── Comparison arrows ──
    const leadsArrow = newLeadsThisWeek.count > newLeadsLastWeek.count ? '📈' :
      newLeadsThisWeek.count < newLeadsLastWeek.count ? '📉' : '➡️';
    const dealsArrow = closedWonThisWeek.count > closedWonLastWeek.count ? '📈' :
      closedWonThisWeek.count < closedWonLastWeek.count ? '📉' : '➡️';
    const msgsArrow = messagesThisWeek.count > messagesLastWeek.count ? '📈' :
      messagesThisWeek.count < messagesLastWeek.count ? '📉' : '➡️';

    const message = [
      `📊 דוח שבועי — ${getLocalDate()}`,
      '',
      `🏢 סה"כ לידים במערכת: ${totalLeads.count}`,
      '',
      `📋 השבוע:`,
      `  ${leadsArrow} לידים חדשים: ${newLeadsThisWeek.count} (שבוע שעבר: ${newLeadsLastWeek.count})`,
      `  📅 פגישות נקבעו: ${meetingsThisWeek.count}`,
      `  ${dealsArrow} עסקאות נסגרו: ${closedWonThisWeek.count} ✅ | ${closedLostThisWeek.count} ❌`,
      `  ${msgsArrow} הודעות: ${messagesThisWeek.count} (שבוע שעבר: ${messagesLastWeek.count})`,
      '',
      `📊 אחוז המרה: ${conversionRate}%${totalClosed === 0 ? ' (אין סגירות השבוע)' : ` (${closedWonThisWeek.count}/${totalClosed})`}`,
      '',
      `🎯 לידים מובילים:`,
      topLeadLines,
      '',
      `שבוע מוצלח בוס! 💪🚀`,
    ].join('\n');

    await sendWithTyping(sock, jid, message);
    log.info('Weekly report sent to admin');
  } catch (err) {
    log.error({ err }, 'Failed to send weekly report');
  }
}

export function startWeeklyReportScheduler(sock: BotAdapter): void {
  log.info('Weekly report scheduler started (hourly check)');

  // Check immediately on startup
  sendWeeklyReport(sock).catch((err) =>
    log.error({ err }, 'weekly report initial check error'),
  );

  // Then every hour
  setInterval(() => {
    sendWeeklyReport(sock).catch((err) =>
      log.error({ err }, 'weekly report check error'),
    );
  }, WEEKLY_CHECK_INTERVAL_MS);
}
