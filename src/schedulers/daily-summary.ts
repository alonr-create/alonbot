/**
 * Daily morning summary — sends Alon a WhatsApp recap every morning at 09:00 Israel time.
 * Pipeline data from Monday.com (source of truth). Activity from local SQLite.
 */
import { getDb } from '../db/index.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import { getAdminPhone, getTimezone } from '../db/tenant-config.js';
import { createLogger } from '../utils/logger.js';
import { getAccountInsights, getActiveCampaigns, getAllAdAccountIds } from '../facebook/api.js';
import { getAllBoardsStats } from '../monday/api.js';
import type { BotAdapter } from '../whatsapp/connection.js';

const log = createLogger('daily-summary');

const DAILY_CHECK_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
let lastSentDate = '';

/** Closed / inactive statuses — not counted as "active" pipeline. */
const CLOSED_STATUSES = new Set([
  'סירוב', 'לא רלוונטי', 'נסגר', 'closed-won', 'closed-lost',
]);

/** Hot statuses worth highlighting. */
const HOT_STATUSES = new Set([
  'בשיחה', 'נוצר קשר', 'הצעה נשלחה', 'נשלחה הצעה',
  'שיחה ראשונה', 'ליד חם', 'פגישה נקבעה',
]);

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

    // ── Pipeline from Monday.com (source of truth) ──
    const allStats = await getAllBoardsStats();
    const pipelineLines: string[] = [];
    for (const [boardName, stats] of Object.entries(allStats)) {
      if (stats.total === 0) continue;
      const activeCount = Object.entries(stats.byStatus)
        .filter(([status]) => !CLOSED_STATUSES.has(status))
        .reduce((sum, [, count]) => sum + count, 0);
      const statusLines = Object.entries(stats.byStatus)
        .sort(([, a], [, b]) => b - a)
        .map(([status, count]) => `  ${status}: ${count}`)
        .join('\n');
      pipelineLines.push(`📊 ${boardName} (${activeCount} פעילים מתוך ${stats.total}):`);
      pipelineLines.push(statusLines);
    }

    // ── Hot leads from Monday.com ──
    const hotLeads: string[] = [];
    for (const [boardName, stats] of Object.entries(allStats)) {
      for (const item of stats.recentItems) {
        if (HOT_STATUSES.has(item.status)) {
          hotLeads.push(`  🔥 ${item.name} — ${item.status}`);
        }
      }
    }
    const hotLines = hotLeads.length > 0
      ? hotLeads.join('\n')
      : '  אין לידים חמים כרגע';

    // ── Yesterday's activity (from local DB) ──
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

    const message = [
      `☀️ בוקר טוב בוס! הנה הסיכום שלך:`,
      '',
      ...pipelineLines,
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

    // Facebook Ads daily report (yesterday's data)
    try {
      const accounts = getAllAdAccountIds();
      const [allInsights, campaigns, ...perAccountInsights] = await Promise.all([
        getAccountInsights('yesterday'),
        getActiveCampaigns(),
        ...accounts.map((a) => getAccountInsights('yesterday', a.id)),
      ]);

      const fbLines: string[] = ['📊 דוח פרסום פייסבוק — אתמול:'];

      for (let i = 0; i < accounts.length; i++) {
        const acct = accounts[i];
        const ins = perAccountInsights[i];
        const acctCampaigns = campaigns.filter((c: any) => c.accountName === acct.name);
        fbLines.push(
          '',
          `━━━ ${acct.name} ━━━`,
          `💰 הוצאה: ₪${ins.spend.toLocaleString('he-IL', { minimumFractionDigits: 2 })}`,
          `👁️ ${ins.impressions.toLocaleString('he-IL')} חשיפות | 👆 ${ins.clicks} קליקים | 🎯 ${ins.leads} לידים`,
          `💵 CPC: ${ins.clicks > 0 ? '₪' + ins.cpc.toFixed(2) : '—'} | CPL: ${ins.leads > 0 ? '₪' + ins.cpl.toFixed(2) : '—'}`,
        );
        if (acctCampaigns.length > 0) {
          fbLines.push(`🎯 קמפיינים (${acctCampaigns.length}):`);
          for (const c of acctCampaigns) {
            const budget = c.daily_budget
              ? `₪${(parseInt(c.daily_budget, 10) / 100).toFixed(0)}/יום`
              : 'ללא תקציב';
            fbLines.push(`  • ${c.name} — ${budget}`);
          }
        }
      }

      fbLines.push(
        '',
        `━━━ סה״כ ━━━`,
        `💰 ₪${allInsights.spend.toLocaleString('he-IL', { minimumFractionDigits: 2 })} | 🎯 ${allInsights.leads} לידים | 👆 ${allInsights.clicks} קליקים`,
      );

      await sendWithTyping(sock, jid, fbLines.join('\n'));
      log.info('Daily Facebook report sent to admin');
    } catch (fbErr) {
      log.error({ err: fbErr }, 'Failed to send daily Facebook report');
    }
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
