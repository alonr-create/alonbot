/**
 * Gather live business context when Alon (the boss) messages the bot.
 * Pipeline stats & hot leads come from Monday.com (source of truth).
 * Activity & follow-ups come from local SQLite (message history).
 */
import { getDb } from '../db/index.js';
import { getAllBoardsStats } from '../monday/api.js';
import { getAvailableSlots } from '../calendar/api.js';
import { calculateLeadScore } from './lead-scoring.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('boss-context');

/** Hot statuses — leads we want to highlight to the boss. */
const HOT_STATUSES = new Set([
  'בשיחה', 'נוצר קשר', 'הצעה נשלחה', 'נשלחה הצעה',
  'שיחה ראשונה', 'ליד חם', 'פגישה נקבעה',
]);

/** Closed / inactive statuses — not shown in pipeline count. */
const CLOSED_STATUSES = new Set([
  'סירוב', 'לא רלוונטי', 'נסגר', 'closed-won', 'closed-lost',
]);

export async function buildBossContext(): Promise<string> {
  const sections: string[] = [];

  try {
    const db = getDb();

    // ── 1. Pipeline Overview (from Monday.com — source of truth) ──
    const allStats = await getAllBoardsStats();
    for (const [boardName, stats] of Object.entries(allStats)) {
      if (stats.total === 0) continue;
      const activeCount = Object.entries(stats.byStatus)
        .filter(([status]) => !CLOSED_STATUSES.has(status))
        .reduce((sum, [, count]) => sum + count, 0);
      const statusLines = Object.entries(stats.byStatus)
        .sort(([, a], [, b]) => b - a)
        .map(([status, count]) => `  • ${status}: ${count}`)
        .join('\n');
      sections.push(`📊 Pipeline ${boardName} (${activeCount} פעילים מתוך ${stats.total}):\n${statusLines}`);
    }

    // ── 2. Hot leads from Monday.com ──
    const hotLeads: string[] = [];
    for (const [boardName, stats] of Object.entries(allStats)) {
      for (const item of stats.recentItems) {
        if (HOT_STATUSES.has(item.status)) {
          hotLeads.push(`  • ${item.name} — ${item.status} (${boardName})`);
        }
      }
    }
    if (hotLeads.length > 0) {
      sections.push(`🔥 לידים חמים:\n${hotLeads.join('\n')}`);
    }

    // ── 3. Today's activity (from local DB — message history) ──
    const todayMessages = db
      .prepare(
        `SELECT COUNT(*) as count FROM messages
         WHERE created_at >= date('now', 'start of day')`,
      )
      .get() as { count: number };

    const todayNewLeads = db
      .prepare(
        `SELECT COUNT(*) as count FROM leads
         WHERE created_at >= date('now', 'start of day')`,
      )
      .get() as { count: number };

    sections.push(
      `📈 פעילות היום:\n  • הודעות: ${todayMessages.count}\n  • לידים חדשים: ${todayNewLeads.count}`,
    );

    // ── 4. Pending follow-ups (from local DB) ──
    const pendingFollowUps = db
      .prepare(
        `SELECT f.phone, f.message_number, f.scheduled_at, l.name
         FROM follow_ups f
         LEFT JOIN leads l ON f.phone = l.phone
         WHERE f.sent_at IS NULL AND f.cancelled = 0
         ORDER BY f.scheduled_at ASC
         LIMIT 5`,
      )
      .all() as Array<{
      phone: string;
      message_number: number;
      scheduled_at: string;
      name: string | null;
    }>;

    if (pendingFollowUps.length > 0) {
      const fuLines = pendingFollowUps
        .map((f) => `  • ${f.name || f.phone} — פולואפ #${f.message_number} (${f.scheduled_at.slice(0, 16)})`)
        .join('\n');
      sections.push(`⏰ פולואפים ממתינים:\n${fuLines}`);
    }

    // ── 5. Calendar availability ──
    try {
      const slots = await getAvailableSlots(3);
      if (slots.length > 0) {
        sections.push(`📅 ${slots.length} זמנים פנויים ב-3 ימים הקרובים`);
      }
    } catch {
      // Calendar not configured or error
    }

    // ── 6. Escalated leads (from local DB — escalation is a bot action) ──
    const escalated = db
      .prepare(
        `SELECT l.name, l.phone, l.updated_at
         FROM leads l
         WHERE l.status = 'escalated'
         ORDER BY l.updated_at DESC
         LIMIT 5`,
      )
      .all() as Array<{ name: string | null; phone: string; updated_at: string }>;

    if (escalated.length > 0) {
      const escLines = escalated
        .map((l) => `  • ${l.name || l.phone} (${l.updated_at.slice(0, 16)})`)
        .join('\n');
      sections.push(`⚠️ לידים שהועברו לטיפולך:\n${escLines}`);
    }
  } catch (err) {
    log.error({ err }, 'Failed to build boss context');
    sections.push('(שגיאה בטעינת נתונים)');
  }

  return sections.join('\n\n');
}

/**
 * Search for a specific lead by name or phone — returns formatted context.
 */
export function searchLeadContext(query: string): string {
  const db = getDb();

  const leads = db
    .prepare(
      `SELECT l.*,
              (SELECT COUNT(*) FROM messages WHERE phone = l.phone) as msg_count,
              (SELECT content FROM messages WHERE phone = l.phone ORDER BY created_at DESC LIMIT 1) as last_message,
              (SELECT created_at FROM messages WHERE phone = l.phone ORDER BY created_at DESC LIMIT 1) as last_message_time
       FROM leads l
       WHERE l.name LIKE ? OR l.phone LIKE ?
       LIMIT 5`,
    )
    .all(`%${query}%`, `%${query}%`) as Array<{
    phone: string;
    name: string | null;
    status: string;
    interest: string | null;
    notes: string | null;
    source: string;
    created_at: string;
    updated_at: string;
    monday_item_id: number | null;
    escalation_count: number;
    msg_count: number;
    last_message: string | null;
    last_message_time: string | null;
  }>;

  if (leads.length === 0) return `לא מצאתי ליד עם "${query}"`;

  return leads
    .map((l) => {
      const { score, factors } = calculateLeadScore(l.phone);
      const lines = [
        `👤 ${l.name || 'ללא שם'} (${l.phone})`,
        `   ניקוד: ${score}/100 — ${factors.join(', ')}`,
        `   סטטוס: ${translateStatus(l.status)}`,
        l.interest ? `   עניין: ${l.interest}` : '',
        l.notes ? `   📝 הערות: ${l.notes}` : '',
        `   מקור: ${l.source}`,
        `   הודעות: ${l.msg_count}`,
        l.last_message
          ? `   הודעה אחרונה: "${l.last_message.slice(0, 50)}${l.last_message.length > 50 ? '...' : ''}" (${l.last_message_time?.slice(0, 16)})`
          : '',
        l.monday_item_id ? `   Monday.com ID: ${l.monday_item_id}` : '',
        `   נוצר: ${l.created_at.slice(0, 16)} | עודכן: ${l.updated_at.slice(0, 16)}`,
      ]
        .filter(Boolean)
        .join('\n');
      return lines;
    })
    .join('\n\n');
}

/**
 * Get conversation history for a specific lead — for meeting prep.
 */
export function getLeadConversation(phone: string, limit = 30): string {
  const db = getDb();

  const lead = db
    .prepare('SELECT name, interest, status FROM leads WHERE phone = ?')
    .get(phone) as { name: string | null; interest: string | null; status: string } | undefined;

  if (!lead) return `לא מצאתי ליד עם הטלפון ${phone}`;

  const messages = db
    .prepare(
      'SELECT direction, content, created_at FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(phone, limit) as Array<{ direction: string; content: string; created_at: string }>;

  messages.reverse();

  const header = `📋 שיחה עם ${lead.name || phone} (${translateStatus(lead.status)})${lead.interest ? ` | עניין: ${lead.interest}` : ''}`;
  const msgLines = messages
    .map((m) => `[${m.created_at.slice(11, 16)}] ${m.direction === 'in' ? '👤' : '🤖'} ${m.content.slice(0, 100)}`)
    .join('\n');

  return `${header}\n${msgLines}`;
}

function translateStatus(status: string): string {
  const map: Record<string, string> = {
    new: 'חדש',
    contacted: 'נוצר קשר',
    'in-conversation': 'בשיחה',
    'quote-sent': 'נשלחה הצעה',
    'meeting-scheduled': 'נקבעה פגישה',
    escalated: 'הועבר לטיפול',
    'closed-won': 'נסגר בהצלחה',
    'closed-lost': 'נסגר ללא עסקה',
  };
  return map[status] || status;
}
