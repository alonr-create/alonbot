/**
 * Sales Manager AI — monitors bot conversations and alerts Alon about problems/opportunities.
 * Runs every 2 hours via cron. Separate Claude API call with a "manager" persona.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../utils/db.js';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('sales-manager');

interface ConversationSummary {
  phone: string;
  name: string;
  source: string;
  status: string;
  botPaused: boolean;
  messages: Array<{ role: string; content: string; time: string }>;
  unanswered: boolean;
}

function getRecentConversations(hours: number): ConversationSummary[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
    .toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace('T', ' ');

  // Get phones with recent activity (exclude Alon's own numbers)
  const allowedPhones = config.allowedWhatsApp;
  const phones = db.prepare(`
    SELECT DISTINCT sender_id FROM messages
    WHERE channel = 'whatsapp-inbound' AND created_at > ?
    ORDER BY MAX(created_at) OVER (PARTITION BY sender_id) DESC
    LIMIT 20
  `).all(cutoff) as { sender_id: string }[];

  const conversations: ConversationSummary[] = [];

  for (const { sender_id } of phones) {
    if (allowedPhones.includes(sender_id)) continue;

    const lead = db.prepare('SELECT name, lead_status, status, source, bot_paused FROM leads WHERE phone = ?').get(sender_id) as any;

    // Get last 20 messages for this conversation
    const msgs = db.prepare(`
      SELECT role, content, created_at FROM messages
      WHERE channel = 'whatsapp-inbound' AND sender_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).all(sender_id) as any[];

    if (msgs.length === 0) continue;

    const reversed = msgs.reverse();
    const lastUser = reversed.filter(m => m.role === 'user').pop();
    const lastBot = reversed.filter(m => m.role === 'assistant').pop();
    const unanswered = lastUser && (!lastBot || lastUser.created_at > lastBot.created_at);

    conversations.push({
      phone: sender_id,
      name: lead?.name || sender_id,
      source: lead?.source || 'unknown',
      status: lead?.lead_status || lead?.status || '',
      botPaused: lead?.bot_paused === 1,
      messages: reversed.map(m => ({
        role: m.role,
        content: (m.content || '').slice(0, 300),
        time: m.created_at?.split(' ')[1]?.slice(0, 5) || '',
      })),
      unanswered: !!unanswered,
    });
  }

  return conversations;
}

function buildManagerPrompt(conversations: ConversationSummary[]): string {
  let prompt = `אתה מנהל מכירות מנוסה. לפניך שיחות WhatsApp בין "יעל" (הבוטית/נציגת מכירות AI) לבין לידים.

## המשימה שלך
נתח כל שיחה ותן דוח קצר לאלון (הבעלים). אלון רוצה לדעת:
1. מה מצב כל שיחה — חם/קר/אבוד/נסגר
2. האם יעל ניהלה את השיחה טוב
3. אם יש בעיה שדורשת התערבות ידנית
4. מה ההמלצה — להשאיר ליעל / להתערב / לעזוב

## כללים
- היה קצר ותכליתי — 2-3 שורות לכל שיחה
- תן ציון 1-10 לכל שיחה
- סמן 🔥 לידים חמים, ⚠️ לבעיות, ✅ לשיחות תקינות, ❌ לאבודים
- אם אין מה לדווח — אמור "הכל תקין, אין התערבות נדרשת"
- בסוף תן סיכום כמותי: X שיחות, Y דורשות התערבות

## השיחות:\n\n`;

  for (const conv of conversations) {
    prompt += `### ${conv.name} (${conv.phone})\n`;
    prompt += `מקור: ${conv.source} | סטטוס: ${conv.status || 'לא ידוע'}`;
    if (conv.botPaused) prompt += ' | ⏸️ בוט מושהה';
    if (conv.unanswered) prompt += ' | ⏳ ממתין לתשובה';
    prompt += '\n\n';

    for (const msg of conv.messages) {
      const role = msg.role === 'user' ? `👤 ${conv.name}` : '🤖 יעל';
      prompt += `${msg.time} ${role}: ${msg.content}\n`;
    }
    prompt += '\n---\n\n';
  }

  return prompt;
}

export async function runSalesManagerCheck(): Promise<void> {
  if (!config.anthropicApiKey) {
    log.warn('no API key — skipping sales manager check');
    return;
  }

  const targetId = config.allowedTelegram[0];
  if (!targetId || !config.telegramBotToken) {
    log.warn('no Telegram config — skipping sales manager check');
    return;
  }

  try {
    const conversations = getRecentConversations(2);

    if (conversations.length === 0) {
      log.info('no recent conversations — skipping analysis');
      return;
    }

    log.info({ count: conversations.length }, 'analyzing conversations');

    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const managerPrompt = buildManagerPrompt(conversations);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: managerPrompt }],
    });

    const analysis = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as any).text)
      .join('\n');

    if (!analysis) {
      log.warn('empty analysis from Claude');
      return;
    }

    // Send to Telegram
    const { Bot } = await import('grammy');
    const bot = new Bot(config.telegramBotToken);

    const header = `📊 *דוח מנהל מכירות* — ${new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })}\n\n`;
    const footer = `\n\n_💡 להתערב: "תראה שיחה עם X" / "תשלח ל-X הודעה Y"_`;
    const fullMsg = header + analysis + footer;

    // Telegram max message length is 4096
    if (fullMsg.length > 4000) {
      await bot.api.sendMessage(Number(targetId), fullMsg.slice(0, 4000), { parse_mode: 'Markdown' }).catch(() =>
        bot.api.sendMessage(Number(targetId), fullMsg.slice(0, 4000))
      );
    } else {
      await bot.api.sendMessage(Number(targetId), fullMsg, { parse_mode: 'Markdown' }).catch(() =>
        bot.api.sendMessage(Number(targetId), fullMsg)
      );
    }

    // Track API cost
    try {
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cost = (inputTokens * 3 / 1_000_000) + (outputTokens * 15 / 1_000_000);
      db.prepare("INSERT INTO api_usage (model, input_tokens, output_tokens, cost_usd, purpose) VALUES (?, ?, ?, ?, 'sales-manager')")
        .run('claude-sonnet-4-20250514', inputTokens, outputTokens, cost);
    } catch { /* non-critical */ }

    log.info({ conversations: conversations.length, analysisLen: analysis.length }, 'sales manager report sent');
  } catch (e: any) {
    log.error({ err: e.message }, 'sales manager check failed');
  }
}
