import { generateResponse } from '../ai/claude-client.js';
import { getDb } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('follow-up-ai');

const MAX_CONTEXT_MESSAGES = 8;

interface MessageRow {
  direction: 'in' | 'out';
  content: string;
  created_at: string;
}

interface LeadRow {
  name: string | null;
  interest: string | null;
  status: string;
}

const TONE_INSTRUCTIONS: Record<number, string> = {
  1: `זה פולואפ ראשון (תזכורת ידידותית).
הטון: חם, קליל, לא לוחץ. שאל אם הספיק/ה לחשוב על מה שדיברתם.
תן/י ערך קטן — טיפ, תובנה, או שאלה שמחברת חזרה לעניין.`,

  2: `זה פולואפ שני (הוספת ערך + דחיפות עדינה).
הטון: מקצועי וחם, עם תחושה קלה של דחיפות. הזכר שיש עומס ולקוחות נוספים מתעניינים.
תוסיף ערך — הסבר למה עכשיו זה הזמן הנכון לפעול, או ציין יתרון ספציפי שרלוונטי אליהם.`,

  3: `זה פולואפ שלישי ואחרון (דלת פתוחה).
הטון: מכבד, לא לוחץ, סוגר מעגל. תן להבין שזו ההודעה האחרונה שלך בנושא.
השאר את הדלת פתוחה — אמור שתמיד אפשר לחזור אליך כשירגישו מוכנים.`,
};

/**
 * Fetch the last N messages from a conversation for context.
 */
function getRecentMessages(phone: string): MessageRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT direction, content, created_at
    FROM messages
    WHERE phone = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(phone, MAX_CONTEXT_MESSAGES) as MessageRow[];
}

/**
 * Fetch lead info by phone.
 */
function getLeadInfo(phone: string): LeadRow | null {
  const db = getDb();
  return db.prepare(`
    SELECT name, interest, status
    FROM leads
    WHERE phone = ?
  `).get(phone) as LeadRow | null;
}

/**
 * Format conversation history for the Claude prompt.
 */
function formatConversationContext(messages: MessageRow[]): string {
  if (messages.length === 0) return 'אין הודעות קודמות.';

  // Reverse to chronological order (they come DESC from DB)
  const chronological = [...messages].reverse();

  return chronological
    .map((m) => {
      const sender = m.direction === 'in' ? 'לקוח' : 'אלון';
      return `${sender}: ${m.content}`;
    })
    .join('\n');
}

/**
 * Generate a personalized Hebrew follow-up message using Claude,
 * enriched with conversation history and lead details.
 */
export async function generateFollowUpMessage(
  messageNumber: 1 | 2 | 3,
  leadName: string,
  interest: string,
  phone?: string,
): Promise<string> {
  // Fetch conversation context and lead info if phone is available
  let conversationContext = '';
  let leadStatus = '';

  if (phone) {
    const messages = getRecentMessages(phone);
    conversationContext = formatConversationContext(messages);

    const leadInfo = getLeadInfo(phone);
    if (leadInfo) {
      // Use DB values as fallback if scheduler values are empty
      if (!leadName && leadInfo.name) leadName = leadInfo.name;
      if (!interest && leadInfo.interest) interest = leadInfo.interest;
      leadStatus = leadInfo.status;
    }

    log.info(
      { phone, messageNumber, contextMessages: messages.length },
      'fetched conversation context for follow-up',
    );
  }

  const displayName = leadName || 'הלקוח/ה';
  const displayInterest = interest || 'השירותים שלנו';
  const toneInstruction = TONE_INSTRUCTIONS[messageNumber];

  const systemPrompt = `אתה אלון, נציג מכירות של Alon.dev — שירותי טכנולוגיה ודיגיטל לעסקים (אתרים, אפליקציות, אוטומציה, CRM, שיווק).
כתוב הודעת וואטסאפ קצרה (2-3 משפטים, בלי כותרת ובלי פורמט מיוחד) בעברית.
אל תציין שזו הודעה אוטומטית. תכתוב כאילו אתה אדם אמיתי שממשיך שיחה טבעית.
אל תוסיף חתימה או שם בסוף ההודעה.
השתמש באימוג׳י אחד או שניים בטבעיות (לא יותר).

${toneInstruction}`;

  const userMessage = `כתוב הודעת פולואפ ל-${displayName} שהתעניין/ה ב: ${displayInterest}.
${leadStatus ? `סטטוס הליד: ${leadStatus}.` : ''}

הנה ההודעות האחרונות בשיחה:
${conversationContext}

כתוב את ההודעה בלבד, בלי הסברים.`;

  return generateResponse(
    [{ role: 'user', content: userMessage }],
    systemPrompt,
  );
}
