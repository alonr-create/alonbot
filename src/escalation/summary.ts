import { generateResponse } from '../ai/claude-client.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('escalation-summary');

const SUMMARY_SYSTEM_PROMPT = `אתה עוזר שמסכם שיחות מכירה בעברית.
סכם את השיחה בדיוק 3 שורות:
1. מה הלקוח רוצה (שירות/מוצר)
2. אותות תקציב (סכומים שהוזכרו, רמת רצינות)
3. חששות או התנגדויות

תן סיכום תמציתי בלבד, בלי הקדמות.`;

/**
 * Generate a concise 3-line escalation summary from conversation history.
 * Uses Claude to distill the conversation into actionable info for Alon.
 */
export async function generateEscalationSummary(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  leadName: string,
): Promise<string> {
  try {
    const summaryMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      {
        role: 'user',
        content: `סכם את השיחה הבאה עם ${leadName}:\n\n${messages.map((m) => `${m.role === 'user' ? 'לקוח' : 'בוט'}: ${m.content}`).join('\n')}`,
      },
    ];

    const summary = await generateResponse(summaryMessages, SUMMARY_SYSTEM_PROMPT);
    log.info({ leadName }, 'escalation summary generated');
    return summary;
  } catch (err) {
    log.error({ err, leadName }, 'failed to generate escalation summary');
    return `1. לקוח: ${leadName}\n2. לא ניתן לסכם את השיחה\n3. נדרשת בדיקה ידנית`;
  }
}
