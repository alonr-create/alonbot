/**
 * Lead scoring system — calculates a 0-100 score based on engagement signals.
 * Used to prioritize hot leads in boss context and pipeline views.
 */
import { getDb } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('lead-scoring');

interface ScoringResult {
  score: number;
  factors: string[];
}

interface LeadRow {
  status: string;
  created_at: string;
}

interface MessageStats {
  total: number;
  inbound: number;
  avg_length: number;
}

interface LastInbound {
  created_at: string;
}

interface ResponsePair {
  in_time: string;
  out_time: string;
}

interface MessageContent {
  content: string;
}

const INTEREST_KEYWORDS = [
  'מחיר', 'כמה', 'עלות', 'תקציב', 'budget',
  'מתי', 'timeline', 'לו"ז', 'דחוף',
  'חוזה', 'הסכם', 'הצעת מחיר',
  'אתר', 'אפליקציה', 'מערכת', 'פרויקט',
  'מתחילים', 'נתחיל', 'בואו נתקדם', 'אני רוצה',
];

const STATUS_SCORES: Record<string, number> = {
  'new': 0,
  'contacted': 3,
  'in-conversation': 6,
  'quote-sent': 10,
  'meeting-scheduled': 10,
  'escalated': 5,
  'closed-won': 10,
  'closed-lost': 0,
};

/**
 * Calculate a lead score (0-100) for a given phone number.
 * Returns the score and an array of Hebrew factor descriptions.
 */
export function calculateLeadScore(phone: string): ScoringResult {
  const db = getDb();
  const factors: string[] = [];
  let score = 0;

  try {
    // ── 1. Message count (max +25) ──
    const msgStats = db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) as inbound,
                AVG(CASE WHEN direction = 'in' THEN LENGTH(content) ELSE NULL END) as avg_length
         FROM messages WHERE phone = ?`,
      )
      .get(phone) as MessageStats;

    const msgCount = msgStats.total || 0;
    const inboundCount = msgStats.inbound || 0;

    if (msgCount > 0) {
      // Scale: 1-3 msgs = 5, 4-8 = 10, 9-15 = 18, 16+ = 25
      const msgScore = Math.min(25, Math.round(Math.sqrt(inboundCount) * 8));
      score += msgScore;
      factors.push(`${inboundCount} הודעות נכנסות (+${msgScore})`);
    }

    // ── 2. Response speed (max +20) ──
    const responsePairs = db
      .prepare(
        `SELECT m_in.created_at as in_time, m_out.created_at as out_time
         FROM messages m_in
         JOIN messages m_out ON m_out.phone = m_in.phone
           AND m_out.direction = 'in'
           AND m_in.direction = 'out'
           AND m_out.created_at > m_in.created_at
           AND m_out.created_at <= datetime(m_in.created_at, '+24 hours')
         WHERE m_in.phone = ?
         ORDER BY m_in.created_at DESC
         LIMIT 10`,
      )
      .all(phone) as ResponsePair[];

    if (responsePairs.length > 0) {
      const avgMinutes =
        responsePairs.reduce((sum, p) => {
          const diff = new Date(p.out_time).getTime() - new Date(p.in_time).getTime();
          return sum + diff / 60000;
        }, 0) / responsePairs.length;

      // < 5 min = 20, < 30 min = 15, < 2h = 10, < 12h = 5
      let speedScore = 0;
      if (avgMinutes < 5) speedScore = 20;
      else if (avgMinutes < 30) speedScore = 15;
      else if (avgMinutes < 120) speedScore = 10;
      else if (avgMinutes < 720) speedScore = 5;

      if (speedScore > 0) {
        score += speedScore;
        const avgLabel = avgMinutes < 60
          ? `${Math.round(avgMinutes)} דקות`
          : `${(avgMinutes / 60).toFixed(1)} שעות`;
        factors.push(`זמן תגובה ממוצע ${avgLabel} (+${speedScore})`);
      }
    }

    // ── 3. Interest keywords (max +15) ──
    const recentMessages = db
      .prepare(
        `SELECT content FROM messages
         WHERE phone = ? AND direction = 'in'
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(phone) as MessageContent[];

    const allText = recentMessages.map((m) => m.content).join(' ').toLowerCase();
    const matchedKeywords = INTEREST_KEYWORDS.filter((kw) => allText.includes(kw));

    if (matchedKeywords.length > 0) {
      // 1 keyword = 5, 2 = 10, 3+ = 15
      const kwScore = Math.min(15, matchedKeywords.length * 5);
      score += kwScore;
      factors.push(`מילות עניין: ${matchedKeywords.slice(0, 3).join(', ')} (+${kwScore})`);
    }

    // ── 4. Conversation depth — message length (max +15) ──
    const avgLength = msgStats.avg_length || 0;

    if (avgLength > 0) {
      // < 20 chars = 0, 20-50 = 5, 50-100 = 10, 100+ = 15
      let depthScore = 0;
      if (avgLength >= 100) depthScore = 15;
      else if (avgLength >= 50) depthScore = 10;
      else if (avgLength >= 20) depthScore = 5;

      if (depthScore > 0) {
        score += depthScore;
        factors.push(`אורך הודעה ממוצע ${Math.round(avgLength)} תווים (+${depthScore})`);
      }
    }

    // ── 5. Recency (max +15) ──
    const lastInbound = db
      .prepare(
        `SELECT created_at FROM messages
         WHERE phone = ? AND direction = 'in'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(phone) as LastInbound | undefined;

    if (lastInbound) {
      const hoursAgo = (Date.now() - new Date(lastInbound.created_at).getTime()) / 3600000;

      let recencyScore = 0;
      if (hoursAgo <= 24) recencyScore = 15;
      else if (hoursAgo <= 48) recencyScore = 10;
      else if (hoursAgo <= 168) recencyScore = 5;

      if (recencyScore > 0) {
        score += recencyScore;
        const label = hoursAgo < 1
          ? 'פחות משעה'
          : hoursAgo < 24
            ? `${Math.round(hoursAgo)} שעות`
            : `${Math.round(hoursAgo / 24)} ימים`;
        factors.push(`הודעה אחרונה לפני ${label} (+${recencyScore})`);
      }
    }

    // ── 6. Status progression (max +10) ──
    const lead = db
      .prepare('SELECT status, created_at FROM leads WHERE phone = ?')
      .get(phone) as LeadRow | undefined;

    if (lead) {
      const statusScore = STATUS_SCORES[lead.status] ?? 0;
      if (statusScore > 0) {
        score += statusScore;
        factors.push(`סטטוס: ${lead.status} (+${statusScore})`);
      }
    }

    // Cap at 100
    score = Math.min(100, score);

    if (factors.length === 0) {
      factors.push('אין מספיק נתונים לניקוד');
    }
  } catch (err) {
    log.error({ err, phone }, 'Failed to calculate lead score');
    factors.push('שגיאה בחישוב ניקוד');
  }

  return { score, factors };
}
