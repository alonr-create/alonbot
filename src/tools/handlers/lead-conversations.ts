import type { ToolHandler } from '../types.js';
import { db } from '../../utils/db.js';
import { config } from '../../utils/config.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('lead-conversations');

/**
 * Fetch leads from 360Shmikley CRM (alon-dev-whatsapp)
 */
async function fetchCrmLeads(): Promise<any[]> {
  if (!config.crmApiSecret) return [];
  try {
    const resp = await fetch(`${config.crmApiUrl}/wa-inbox/api/leads?token=${config.crmApiSecret}`);
    if (!resp.ok) { log.warn(`CRM API error: ${resp.status}`); return []; }
    return await resp.json();
  } catch (e: any) {
    log.warn('CRM fetch failed:', e.message);
    return [];
  }
}

/**
 * Fetch conversation for a specific phone from 360Shmikley CRM
 */
async function fetchCrmConversation(phone: string): Promise<any[]> {
  if (!config.crmApiSecret) return [];
  try {
    const cleanPhone = phone.replace(/^\+/, '');
    const resp = await fetch(`${config.crmApiUrl}/wa-inbox/api/conversations/${cleanPhone}?token=${config.crmApiSecret}`);
    if (!resp.ok) return [];
    return await resp.json();
  } catch (e: any) {
    log.warn('CRM conversation fetch failed:', e.message);
    return [];
  }
}

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

    // If not found locally, try CRM
    if (!phone) {
      const crmLeads = await fetchCrmLeads();
      const match = crmLeads.find((l: any) => {
        const q = query.toLowerCase();
        return (l.name || '').toLowerCase().includes(q) ||
               (l.phone || '').includes(query.replace(/[^0-9]/g, ''));
      });
      if (match) {
        phone = match.phone;
        leadInfo = match;
      }
    }

    if (!phone) {
      return `לא מצאתי ליד עם "${query}". נסה שם מלא או מספר טלפון.`;
    }

    // Get conversation from local DB
    const localMessages = db.prepare(
      `SELECT role, content, created_at, sender_name FROM messages
       WHERE channel = 'whatsapp-inbound' AND sender_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(phone, limit) as any[];

    // Also fetch from CRM
    const crmMessages = await fetchCrmConversation(phone);

    // Merge messages — normalize to common format
    type MsgEntry = { role: string; content: string; time: string; source: string };
    const allMessages: MsgEntry[] = [];

    for (const msg of localMessages) {
      allMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content || '',
        time: msg.created_at || '',
        source: 'bot',
      });
    }

    for (const msg of crmMessages) {
      allMessages.push({
        role: msg.fromMe ? 'assistant' : 'user',
        content: msg.body || '',
        time: msg.timestamp ? new Date(msg.timestamp).toISOString().replace('T', ' ').slice(0, 16) : '',
        source: 'crm',
      });
    }

    // Deduplicate by content+time proximity
    const deduped: MsgEntry[] = [];
    for (const msg of allMessages) {
      const isDupe = deduped.some(d =>
        d.content === msg.content && d.role === msg.role &&
        Math.abs(new Date(d.time).getTime() - new Date(msg.time).getTime()) < 60000
      );
      if (!isDupe) deduped.push(msg);
    }

    // Sort by time
    deduped.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    if (deduped.length === 0) {
      return `מצאתי את הליד ${leadInfo?.name || phone} אבל אין הודעות בהיסטוריה.`;
    }

    // Format conversation
    const name = leadInfo?.name || phone;
    let result = `## שיחה עם ${name}\n`;
    result += `**טלפון**: ${phone}\n`;
    if (leadInfo) {
      result += `**סטטוס**: ${leadInfo.lead_status || leadInfo.status || 'לא ידוע'}\n`;
      result += `**מקור**: ${leadInfo.source || 'לא ידוע'}\n`;
      if (leadInfo.bot_paused) result += `**בוט**: מושהה ⏸️\n`;
    }
    const crmCount = deduped.filter(m => m.source === 'crm').length;
    result += `**הודעות**: ${deduped.length}${crmCount ? ` (${crmCount} מ-CRM)` : ''}\n\n`;

    for (const msg of deduped) {
      const time = msg.time?.split(/[T ]/)[1]?.slice(0, 5) || '';
      const role = msg.role === 'user' ? `👤 ${name}` : '🤖 יעל';
      const crmTag = msg.source === 'crm' ? ' [CRM]' : '';
      const content = msg.content?.slice(0, 500) || '(ריק)';
      result += `**${time} ${role}${crmTag}**: ${content}\n\n`;
    }

    // Add analysis
    const lastUserMsg = deduped.filter(m => m.role === 'user').pop();
    const lastBotMsg = deduped.filter(m => m.role === 'assistant').pop();
    const unanswered = lastUserMsg && (!lastBotMsg || new Date(lastUserMsg.time) > new Date(lastBotMsg.time));

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
    const cutoffDate = new Date(Date.now() - hours * 60 * 60 * 1000);

    // Fetch from both sources in parallel
    const [localConversations, crmLeads] = await Promise.all([
      db.prepare(`
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
      `).all(cutoff, ...config.allowedWhatsApp) as any[],
      fetchCrmLeads(),
    ]);

    // Merge: track phones we already have from local DB
    const seenPhones = new Set(localConversations.map((c: any) => c.sender_id.replace(/^\+/, '').slice(-9)));

    // Build unified list
    type ConvEntry = {
      phone: string; name: string; status: string; source: string;
      lastUserMsg: string; lastBotMsg: string; userMsgs: number;
      lastContent: string; paused: boolean; from: 'local' | 'crm';
    };
    const unified: ConvEntry[] = [];

    // Add local conversations
    for (const conv of localConversations) {
      const lead = db.prepare('SELECT name, lead_status, status, bot_paused, source FROM leads WHERE phone = ?').get(conv.sender_id) as any;
      unified.push({
        phone: conv.sender_id,
        name: lead?.name || conv.sender_id,
        status: lead?.lead_status || lead?.status || '',
        source: lead?.source || '',
        lastUserMsg: conv.last_user_msg || '',
        lastBotMsg: conv.last_bot_msg || '',
        userMsgs: conv.user_msgs || 0,
        lastContent: conv.last_user_content || '',
        paused: !!lead?.bot_paused,
        from: 'local',
      });
    }

    // Add CRM conversations not already in local
    for (const lead of crmLeads) {
      const phone9 = (lead.phone || '').replace(/^\+/, '').slice(-9);
      if (seenPhones.has(phone9)) continue; // already in local results

      const lastMsgDate = new Date(lead.last_message_at || lead.updated_at || 0);
      if (lastMsgDate < cutoffDate) continue; // outside time window

      const isOutgoing = lead.last_message_role === 'outgoing' || lead.is_outgoing;
      unified.push({
        phone: lead.phone,
        name: lead.name || lead.phone,
        status: lead.status || '',
        source: lead.source || 'crm',
        lastUserMsg: isOutgoing ? '' : (lead.last_message_at || ''),
        lastBotMsg: isOutgoing ? (lead.last_message_at || '') : '',
        userMsgs: lead.message_count || 0,
        lastContent: lead.last_message || '',
        paused: false,
        from: 'crm',
      });
      seenPhones.add(phone9);
    }

    if (unified.length === 0) {
      return `אין שיחות פעילות ב-${hours} שעות האחרונות.`;
    }

    let result = `## שיחות פעילות (${hours} שעות אחרונות)\n\n`;
    let unansweredCount = 0;
    let crmCount = 0;

    for (const conv of unified) {
      const isUnanswered = conv.lastUserMsg && (!conv.lastBotMsg || conv.lastUserMsg > conv.lastBotMsg);

      if (unanswered_only && !isUnanswered) continue;
      if (isUnanswered) unansweredCount++;
      if (conv.from === 'crm') crmCount++;

      const paused = conv.paused ? ' ⏸️' : '';
      const hot = isUnanswered ? ' 🔥' : '';
      const crmTag = conv.from === 'crm' ? ' [CRM]' : '';
      const lastMsg = conv.lastContent?.slice(0, 80) || '';
      const time = (conv.lastUserMsg || conv.lastBotMsg)?.split(/[T ]/)[1]?.slice(0, 5) || '';

      result += `${hot} **${conv.name}** (${conv.phone})${paused}${crmTag}\n`;
      result += `  ${conv.status ? `📋 ${conv.status} | ` : ''}💬 ${conv.userMsgs} הודעות | ⏰ ${time}\n`;
      if (lastMsg) result += `  📩 "${lastMsg}"\n`;
      result += '\n';
    }

    result += `---\n📊 סה"כ: ${unified.length} שיחות (${crmCount} מ-CRM) | ${unansweredCount} ממתינות לתשובה`;
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
