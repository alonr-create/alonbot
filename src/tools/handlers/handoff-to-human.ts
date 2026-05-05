import type { ToolHandler } from '../types.js';
import { db } from '../../utils/db.js';
import { LEAD_STATUS } from '../../utils/lead-status.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('handoff');

function nowIsrael(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}

const handler: ToolHandler = {
  name: 'handoff_to_human',
  definition: {
    name: 'handoff_to_human',
    description:
      'Hand off the conversation to a human (Alon). Pauses the bot for this lead so it stops auto-replying, and notifies Alon on Telegram with a link to the conversation. Use when: (1) lead is angry/confused, (2) two attempts to book/reschedule failed, (3) lead asked to talk to a human/representative, (4) lead said something the bot cannot answer correctly, (5) lead complained about a previous bot reply.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Short reason in Hebrew explaining why handoff is needed (will be shown to Alon).',
        },
        urgency: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'How urgent the handoff is. high = lead is angry / about to drop off.',
        },
        reply_to_lead: {
          type: 'string',
          description:
            'Optional short Hebrew message to send to the lead now, telling them a human will follow up. Keep it under 200 characters. If empty, no message is sent.',
        },
      },
      required: ['reason'],
    },
  },
  async execute(input, ctx) {
    const phone = ctx.senderId;
    if (!phone) return 'Error: handoff_to_human can only run inside a lead conversation.';
    if (!ctx.isLeadConversation) return 'Error: handoff_to_human is only for lead conversations.';

    const reason = String(input.reason || '').slice(0, 500);
    const urgency = (input.urgency as string) || 'normal';
    const replyToLead = input.reply_to_lead ? String(input.reply_to_lead).slice(0, 400) : '';

    const lead = db
      .prepare('SELECT name, source, monday_item_id, lead_status FROM leads WHERE phone = ?')
      .get(phone) as any;
    const name = lead?.name || ctx.senderName || phone;

    // 1. Pause bot for this lead — stop all auto-replies + followups
    try {
      db.prepare(
        'UPDATE leads SET bot_paused = 1, lead_status = COALESCE(lead_status, ?), next_followup = NULL, updated_at = ? WHERE phone = ?'
      ).run(LEAD_STATUS.WAITING, nowIsrael(), phone);
      db.prepare('INSERT OR IGNORE INTO lead_tags (phone, tag) VALUES (?, ?)').run(phone, 'handoff_pending');
    } catch (e: any) {
      log.warn({ phone, err: e.message }, 'failed to pause lead');
    }

    // 2. Send the customer a graceful message if requested
    if (replyToLead) {
      try {
        const { getPhoneConfigForWorkspace, getWorkspaceForSource } = await import('../../utils/workspaces.js');
        const ws = lead?.source ? getWorkspaceForSource(lead.source) : null;
        const pc = ws
          ? getPhoneConfigForWorkspace(ws.id)
          : { phoneId: ctx.config.waCloudPhoneId, token: ctx.config.waCloudToken };
        if (pc.token && pc.phoneId) {
          const to = phone.replace(/\D/g, '');
          await fetch(`https://graph.facebook.com/v21.0/${pc.phoneId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${pc.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to,
              type: 'text',
              text: { body: replyToLead },
            }),
          });
          db.prepare(
            "INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)"
          ).run(phone, replyToLead, nowIsrael());
        }
      } catch (e: any) {
        log.warn({ phone, err: e.message }, 'handoff lead reply failed');
      }
    }

    // 3. Alert Alon on Telegram (immediate via scheduled_messages with send_at = now)
    try {
      const alonTarget = ctx.config.allowedTelegram?.[0] || '';
      if (alonTarget) {
        const urgencyMark = urgency === 'high' ? '🚨🚨' : urgency === 'low' ? 'ℹ️' : '🚨';
        const mondayUrl = lead?.monday_item_id
          ? `\nMonday: https://palm530671.monday.com/boards/1443363020/pulses/${lead.monday_item_id}`
          : '';
        const crmUrl = `https://alonbot.onrender.com/wa-manager?token=${ctx.config.dashboardSecret || 'alonbot-secret-2026'}#${phone}`;
        const alertMsg = [
          `${urgencyMark} *צריך אותך — ליד דקל*`,
          ``,
          `*שם:* ${name}`,
          `*טלפון:* ${phone}`,
          `*סיבה:* ${reason}`,
          mondayUrl,
          ``,
          `שיחה: ${crmUrl}`,
          ``,
          `הבוט הושהה לליד הזה — הוא מחכה לך.`,
        ].join('\n');
        db.prepare(
          'INSERT INTO scheduled_messages (label, message, send_at, channel, target_id) VALUES (?, ?, ?, ?, ?)'
        ).run(`handoff: ${name}`, alertMsg, nowIsrael(), 'telegram', alonTarget);
      }
    } catch (e: any) {
      log.warn({ phone, err: e.message }, 'failed to alert Alon');
    }

    log.info({ phone, name, reason, urgency }, 'handoff_to_human triggered');
    return `Handoff queued. Lead ${name} (${phone}) is now paused and Alon was notified. Reason: ${reason}. Stop replying to this lead — Alon will take over.`;
  },
};

export default handler;
