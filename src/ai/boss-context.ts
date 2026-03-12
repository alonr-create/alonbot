/**
 * Gather live business context when Alon (the boss) messages the bot.
 * Provides pipeline stats, today's meetings, pending follow-ups,
 * and recent activity — all injected into the system prompt.
 */
import { getDb } from '../db/index.js';
import { getBoardStats, getAllBoardsStats, getAllBoardIds } from '../monday/api.js';
import { getAvailableSlots } from '../calendar/api.js';
import { formatIsraelTime } from '../calendar/business-hours.js';
import { calculateLeadScore } from './lead-scoring.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('boss-context');

interface LeadSummary {
  phone: string;
  name: string;
  status: string;
  interest: string;
  lastMessage: string;
  lastMessageTime: string;
  mondayItemId: number | null;
}

export async function buildBossContext(): Promise<string> {
  const sections: string[] = [];

  try {
    const db = getDb();

    // ── 1. Pipeline Overview (from local DB) ──
    const statusCounts = db
      .prepare(
        `SELECT status, COUNT(*) as count FROM leads
         GROUP BY status ORDER BY count DESC`,
      )
      .all() as Array<{ status: string; count: number }>;

    if (statusCounts.length > 0) {
      const total = statusCounts.reduce((sum, r) => sum + r.count, 0);
      const statusLines = statusCounts
        .map((r) => `  • ${translateStatus(r.status)}: ${r.count}`)
        .join('\n');
      sections.push(`📊 סיכום Pipeline (${total} לידים סה"כ):\n${statusLines}`);
    }

    // ── 2. Hot leads: in-conversation or quote-sent ──
    const hotLeads = db
      .prepare(
        `SELECT l.phone, l.name, l.status, l.interest, l.notes, l.monday_item_id,
                m.content as last_msg, m.created_at as last_msg_time
         FROM leads l
         LEFT JOIN (
           SELECT phone, content, created_at,
                  ROW_NUMBER() OVER (PARTITION BY phone ORDER BY created_at DESC) as rn
           FROM messages WHERE direction = 'in'
         ) m ON l.phone = m.phone AND m.rn = 1
         WHERE l.status IN ('in-conversation', 'quote-sent', 'contacted')
         ORDER BY l.updated_at DESC
         LIMIT 10`,
      )
      .all() as Array<{
      phone: string;
      name: string | null;
      status: string;
      interest: string | null;
      notes: string | null;
      monday_item_id: number | null;
      last_msg: string | null;
      last_msg_time: string | null;
    }>;

    if (hotLeads.length > 0) {
      const leadLines = hotLeads
        .map((l) => {
          const name = l.name || 'לא ידוע';
          const status = translateStatus(l.status);
          const interest = l.interest || '?';
          const lastMsg = l.last_msg ? `"${l.last_msg.slice(0, 40)}${l.last_msg.length > 40 ? '...' : ''}"` : '';
          const notes = l.notes ? ` 📝${l.notes.split('\n').pop()}` : '';
          const { score } = calculateLeadScore(l.phone);
          return `  • ${name} [${score}] — ${status} | ${interest} ${lastMsg}${notes}`;
        })
        .join('\n');
      sections.push(`🔥 לידים חמים:\n${leadLines}`);
    }

    // ── 3. Today's activity ──
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

    // ── 4. Pending follow-ups ──
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

    // ── 5. Upcoming meetings (from calendar) ──
    try {
      const slots = await getAvailableSlots(3);
      if (slots.length > 0) {
        // Show booked meetings by showing which slots are NOT available
        sections.push(`📅 זמנים פנויים קרובים: ${slots.length} slots ב-3 ימים הקרובים`);
      }
    } catch {
      // Calendar not configured or error
    }

    // ── 6. Leads needing attention ──
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
