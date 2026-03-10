import { getDb } from '../db/index.js';
import { notifyAlon } from '../notifications/telegram.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import { updateMondayStatus } from '../monday/api.js';
import { generateEscalationSummary } from './summary.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { LeadStatus } from '../monday/types.js';

const log = createLogger('escalation');

// Hebrew patterns that indicate a request to speak with a human
const HUMAN_REQUEST_PATTERN = /דבר.*אד[םמ]|נציג|מישהו אמיתי|אלון|בן אדם|תעביר.*אלון/i;

/**
 * Increment the escalation counter for a lead. Returns the new count.
 */
export function incrementEscalationCount(phone: string): number {
  const db = getDb();
  const result = db
    .prepare(
      'UPDATE leads SET escalation_count = escalation_count + 1 WHERE phone = ? RETURNING escalation_count',
    )
    .get(phone) as { escalation_count: number } | undefined;

  const count = result?.escalation_count ?? 0;
  log.debug({ phone, count }, 'escalation count incremented');
  return count;
}

/**
 * Reset the escalation counter for a lead.
 */
export function resetEscalationCount(phone: string): void {
  const db = getDb();
  db.prepare('UPDATE leads SET escalation_count = 0 WHERE phone = ?').run(phone);
  log.debug({ phone }, 'escalation count reset');
}

/**
 * Check whether a conversation should be escalated to Alon.
 * Triggers on: count >= 3 failed attempts, or explicit human request in message text.
 */
export function shouldEscalate(
  phone: string,
  messageText: string,
): { escalate: boolean; reason: 'count' | 'human-request' | null } {
  // Check for human-request patterns first (takes priority)
  if (HUMAN_REQUEST_PATTERN.test(messageText)) {
    return { escalate: true, reason: 'human-request' };
  }

  // Check escalation count from DB
  const db = getDb();
  const lead = db
    .prepare('SELECT escalation_count FROM leads WHERE phone = ?')
    .get(phone) as { escalation_count: number } | undefined;

  if (lead && lead.escalation_count >= 3) {
    return { escalate: true, reason: 'count' };
  }

  return { escalate: false, reason: null };
}

/**
 * Execute full escalation flow:
 * 1. Generate conversation summary
 * 2. Notify Alon via WhatsApp (primary) + Telegram (backup)
 * 3. Update lead status in DB and Monday.com
 * 4. Send WhatsApp message to lead
 *
 * Never throws -- escalation failures are logged but don't crash the bot.
 */
export async function triggerEscalation(
  phone: string,
  leadName: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  sock: any,
  mondayItemId?: number,
  mondayBoardId?: number,
): Promise<void> {
  try {
    // 1. Generate summary
    const summary = await generateEscalationSummary(messages, leadName);

    // 2. Notify Alon via WhatsApp (primary channel)
    const alonJid = `${config.alonPhone}@s.whatsapp.net`;
    const whatsappAlert = [
      `⚠️ *העברה לטיפול ידני*`,
      ``,
      `*שם:* ${leadName}`,
      `*טלפון:* ${phone}`,
      ``,
      `*סיכום:*`,
      summary,
      ``,
      `💬 תכתוב לו ישירות: wa.me/${phone}`,
    ].join('\n');

    try {
      await sendWithTyping(sock, alonJid, whatsappAlert);
      log.info({ phone, leadName }, 'escalation WhatsApp alert sent to Alon');
    } catch (err) {
      log.error({ err }, 'failed to send WhatsApp alert to Alon');
    }

    // 2b. Also try Telegram as backup (if configured)
    const telegramMessage = [
      `<b>העברה לטיפול ידני</b>`,
      ``,
      `<b>שם:</b> ${leadName}`,
      `<b>טלפון:</b> ${phone}`,
      ``,
      `<b>סיכום:</b>`,
      summary,
    ].join('\n');
    notifyAlon(telegramMessage).catch(() => {
      // Telegram is backup — silently ignore failures
    });

    // 3. Update lead status in DB
    const db = getDb();
    db.prepare('UPDATE leads SET status = ? WHERE phone = ?').run(
      'escalated' satisfies LeadStatus,
      phone,
    );

    // 4. Update Monday.com status (fire-and-forget)
    if (mondayItemId && mondayBoardId) {
      updateMondayStatus(mondayItemId, mondayBoardId, 'escalated').catch((err) => {
        log.error({ err }, 'failed to update Monday.com status during escalation');
      });
    }

    // 5. Send WhatsApp message to lead
    const jid = `${phone}@s.whatsapp.net`;
    try {
      await sock.sendPresenceUpdate('composing', jid);
      await sock.sendMessage(jid, {
        text: 'תודה על הסבלנות! אלון יחזור אליך בהקדם האפשרי.',
      });
    } catch (err) {
      log.error({ err, phone }, 'failed to send escalation WhatsApp message');
    }

    log.info({ phone, leadName }, 'escalation completed');
  } catch (err) {
    log.error({ err, phone, leadName }, 'escalation failed');
    // Never throw -- escalation failures must not crash the bot
  }
}
