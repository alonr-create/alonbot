import type { ToolHandler } from '../types.js';
import { db } from '../../utils/db.js';
import { config } from '../../utils/config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('lead-conversations');

/**
 * Lead conversation management tools for Alon.
 * Allows pulling up conversations, analyzing them, and sending manual messages.
 */

const viewConversation: ToolHandler = {
  name: 'view_lead_conversation',
  definition: {
    name: 'view_lead_conversation',
    description: 'View recent WhatsApp conversation with a lead. Use when Alon says "תראה שיחה עם X" or "מה השיחה עם X". Search by name or phone.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Lead name or phone number to search for' },
        limit: { type: 'number', description: 'Number of recent messages (default 30)' },
      },
      required: ['query'],
    },
  },
  async execute(input: any) {
    const { query, limit = 30 } = input;

    // Find the lead — search by phone or name
    let phone: string | null = null;
    let leadInfo: any = null;

    // Try direct phone match
    const cleanPhone = query.replace(/[^0-9+]/g, '');
    if (cleanPhone.length >= 9) {
      // Try with and without country code
      const variants = [cleanPhone, `972${cleanPhone.replace(/^0/, '')}`, `+972${cleanPhone.replace(/^0/, '')}`];
      for (const v of variants) {
        leadInfo = db.prepare('SELECT * FROM leads WHERE phone = ? OR phone LIKE ?').get(v, `%${v.slice(-9)}`);
        if (leadInfo) { phone = leadInfo.phone; break; }
      }
    }

    // Try name search
    if (!phone) {
      leadInfo = db.prepare('SELECT * FROM leads WHERE name LIKE ? ORDER BY updated_at DESC LIMIT 1').get(`%${query}%`);
      if (leadInfo) phone = leadInfo.phone;
    }

    if (!phone) {
      // Try message content search
      const msgMatch = db.prepare("SELECT DISTINCT sender_id FROM messages WHERE channel = 'whatsapp-inbound' AND (sender_name LIKE ? OR content LIKE ?) ORDER BY created_at DESC LIMIT 1").get(`%${query}%`, `%${query}%`) as any;
      if (msgMatch) {
        phone = msgMatch.sender_id;
        leadInfo = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
      }
    }

    if (!phone) {
      return `לא מצאתי ליד עם "${query}". נסה שם מלא או מספר טלפון.`;
    }

    // Get conversation messages
    const messages = db.prepare(
      `SELECT role, content, created_at, sender_name FROM messages
       WHERE channel = 'whatsapp-inbound' AND sender_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(phone, limit) as any[];

    if (messages.length === 0) {
      return `מצאתי את הליד ${leadInfo?.name || phone} אבל אין הודעות בהיסטוריה.`;
    }

    // Format conversation
    const reversed = messages.reverse();
    let result = `## שיחה עם ${leadInfo?.name || phone}\n`;
    result += `**טלפון**: ${phone}\n`;
    if (leadInfo) {
      result += `**סטטוס**: ${leadInfo.lead_status || leadInfo.status || 'לא ידוע'}\n`;
      result += `**מקור**: ${leadInfo.source || 'לא ידוע'}\n`;
      if (leadInfo.bot_paused) result += `**בוט**: מושהה ⏸️\n`;
    }
    result += `**הודעות**: ${messages.length}\n\n`;

    for (const msg of reversed) {
      const time = msg.created_at?.split(' ')[1]?.slice(0, 5) || '';
      const role = msg.role === 'user' ? `👤 ${leadInfo?.name || 'ליד'}` : '🤖 יעל';
      const content = msg.content?.slice(0, 500) || '(ריק)';
      result += `**${time} ${role}**: ${content}\n\n`;
    }

    // Add analysis
    const lastUserMsg = reversed.filter((m: any) => m.role === 'user').pop();
    const lastBotMsg = reversed.filter((m: any) => m.role === 'assistant').pop();
    const unanswered = lastUserMsg && (!lastBotMsg || new Date(lastUserMsg.created_at) > new Date(lastBotMsg.created_at));

    if (unanswered) {
      result += `\n⚠️ **הליד מחכה לתשובה!** ההודעה האחרונה שלו: "${lastUserMsg.content?.slice(0, 100)}"`;
    }

    return result;
  },
};

const sendLeadMessage: ToolHandler = {
  name: 'send_lead_message',
  definition: {
    name: 'send_lead_message',
    description: 'Send a manual WhatsApp message to a lead (as Alon, not the bot). Use when Alon says "תשלח לו/לה X". Pauses the bot for this lead automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        phone: { type: 'string', description: 'Lead phone number' },
        message: { type: 'string', description: 'Message to send' },
        pause_bot: { type: 'boolean', description: 'Pause bot auto-responses for this lead (default true)' },
      },
      required: ['phone', 'message'],
    },
  },
  async execute(input: any) {
    const { phone, message, pause_bot = true } = input;

    // Resolve phone
    let resolvedPhone = phone;
    if (!phone.match(/^\d{10,}/)) {
      const lead = db.prepare('SELECT phone FROM leads WHERE name LIKE ? ORDER BY updated_at DESC LIMIT 1').get(`%${phone}%`) as any;
      if (lead) resolvedPhone = lead.phone;
      else return `לא מצאתי ליד בשם "${phone}". תן מספר טלפון.`;
    }

    // Pause bot if requested
    if (pause_bot) {
      db.prepare('UPDATE leads SET bot_paused = 1 WHERE phone = ?').run(resolvedPhone);
    }

    // Send via WhatsApp Cloud API
    try {
      const phoneNumberId = process.env.WA_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
      const waToken = process.env.WA_TOKEN || process.env.WHATSAPP_TOKEN;
      if (!phoneNumberId || !waToken) {
        return 'חסרים הגדרות WhatsApp Cloud API (WA_PHONE_NUMBER_ID / WA_TOKEN)';
      }

      const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${waToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: resolvedPhone,
          type: 'text',
          text: { body: message },
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return `שליחה נכשלה: ${err.slice(0, 200)}`;
      }

      // Log the message
      const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace('T', ' ');
      db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-inbound', ?, 'assistant', ?, ?)").run(resolvedPhone, `[ידני] ${message}`, now);

      return `✅ הודעה נשלחה ל-${resolvedPhone}${pause_bot ? ' (בוט מושהה)' : ''}:\n"${message}"`;
    } catch (e: any) {
      return `שגיאה בשליחה: ${e.message}`;
    }
  },
};

const listActiveConversations: ToolHandler = {
  name: 'list_active_conversations',
  definition: {
    name: 'list_active_conversations',
    description: 'List recent active WhatsApp conversations with leads. Shows who messaged recently, unanswered messages, and hot leads. Use when Alon says "תראה שיחות פתוחות" or "מה מצב הלידים".',
    input_schema: {
      type: 'object' as const,
      properties: {
        hours: { type: 'number', description: 'Show conversations from last N hours (default 24)' },
        unanswered_only: { type: 'boolean', description: 'Show only unanswered conversations' },
      },
    },
  },
  async execute(input: any) {
    const { hours = 24, unanswered_only = false } = input;

    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000)
      .toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace('T', ' ');

    // Get recent conversations grouped by phone
    const conversations = db.prepare(`
      SELECT sender_id,
             MAX(CASE WHEN role = 'user' THEN created_at END) as last_user_msg,
             MAX(CASE WHEN role = 'assistant' THEN created_at END) as last_bot_msg,
             COUNT(CASE WHEN role = 'user' THEN 1 END) as user_msgs,
             MAX(CASE WHEN role = 'user' THEN content END) as last_user_content
      FROM messages
      WHERE channel = 'whatsapp-inbound' AND created_at > ?
      AND sender_id NOT IN (${config.allowedWhatsApp.map(() => '?').join(',')})
      GROUP BY sender_id
      ORDER BY MAX(created_at) DESC
      LIMIT 30
    `).all(cutoff, ...config.allowedWhatsApp) as any[];

    if (conversations.length === 0) {
      return `אין שיחות פעילות ב-${hours} שעות האחרונות.`;
    }

    let result = `## שיחות פעילות (${hours} שעות אחרונות)\n\n`;
    let unansweredCount = 0;

    for (const conv of conversations) {
      const lead = db.prepare('SELECT name, lead_status, status, bot_paused, source FROM leads WHERE phone = ?').get(conv.sender_id) as any;
      const name = lead?.name || conv.sender_id;
      const isUnanswered = conv.last_user_msg && (!conv.last_bot_msg || conv.last_user_msg > conv.last_bot_msg);

      if (unanswered_only && !isUnanswered) continue;
      if (isUnanswered) unansweredCount++;

      const status = lead?.lead_status || lead?.status || '';
      const paused = lead?.bot_paused ? ' ⏸️' : '';
      const hot = isUnanswered ? ' 🔥' : '';
      const lastMsg = conv.last_user_content?.slice(0, 80) || '';
      const time = conv.last_user_msg?.split(' ')[1]?.slice(0, 5) || '';

      result += `${hot} **${name}** (${conv.sender_id})${paused}\n`;
      result += `  ${status ? `📋 ${status} | ` : ''}💬 ${conv.user_msgs} הודעות | ⏰ ${time}\n`;
      if (lastMsg) result += `  📩 "${lastMsg}"\n`;
      result += '\n';
    }

    result += `---\n📊 סה"כ: ${conversations.length} שיחות | ${unansweredCount} ממתינות לתשובה`;
    return result;
  },
};

const toggleBotPause: ToolHandler = {
  name: 'toggle_bot_pause',
  definition: {
    name: 'toggle_bot_pause',
    description: 'Pause or resume the bot for a specific lead. When paused, the bot won\'t auto-respond — Alon manages manually. Use "pause" to take over a conversation, "resume" to let the bot handle it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        phone: { type: 'string', description: 'Lead phone number or name' },
        action: { type: 'string', enum: ['pause', 'resume'], description: 'pause or resume the bot' },
      },
      required: ['phone', 'action'],
    },
  },
  async execute(input: any) {
    const { phone, action } = input;

    let resolvedPhone = phone;
    if (!phone.match(/^\d{10,}/)) {
      const lead = db.prepare('SELECT phone FROM leads WHERE name LIKE ? ORDER BY updated_at DESC LIMIT 1').get(`%${phone}%`) as any;
      if (lead) resolvedPhone = lead.phone;
      else return `לא מצאתי ליד בשם "${phone}".`;
    }

    const paused = action === 'pause' ? 1 : 0;
    db.prepare('UPDATE leads SET bot_paused = ? WHERE phone = ?').run(paused, resolvedPhone);

    const lead = db.prepare('SELECT name FROM leads WHERE phone = ?').get(resolvedPhone) as any;
    const name = lead?.name || resolvedPhone;

    return action === 'pause'
      ? `⏸️ בוט מושהה ל-${name}. כל ההודעות שלו יגיעו אליך בלי תגובה אוטומטית.`
      : `▶️ בוט חוזר לפעול ל-${name}. תגובות אוטומטיות מופעלות.`;
  },
};

export default [viewConversation, sendLeadMessage, listActiveConversations, toggleBotPause];
