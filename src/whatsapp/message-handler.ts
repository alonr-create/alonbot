import { createLogger } from '../utils/logger.js';
import { getDb } from '../db/index.js';
import { sendWithTyping } from './rate-limiter.js';
import { addMessageToBatch } from './message-batcher.js';
import { handleConversation, sendFirstMessage } from '../ai/conversation.js';
import { setOnNewLeadCallback } from '../monday/webhook-handler.js';
import { cancelFollowUps } from '../follow-up/follow-up-db.js';
import type { BotAdapter } from './connection.js';
import { registerChat } from './connection.js';

const log = createLogger('message-handler');

const MEDIA_RESPONSE =
  'קיבלתי! כרגע אני עובד רק עם הודעות טקסט, אבל אשמח לעזור - ספר לי במילים מה אתה מחפש';

/**
 * Set up the incoming message handler on the whatsapp-web.js client.
 * Routes incoming text to message batcher -> AI conversation flow.
 */
export function setupMessageHandler(client: any, adapter: BotAdapter): void {
  // Wire Monday.com webhook callback for first message
  setOnNewLeadCallback(async (phone: string, name: string, interest: string) => {
    await sendFirstMessage(phone, name, interest, adapter);
  });

  client.on('message', async (msg: any) => {
    // Skip own messages
    if (msg.fromMe) return;

    const from: string = msg.from ?? '';

    // Skip group messages
    if (from.includes('@g.us')) return;

    // Extract phone number — resolve real number from contact if LID format
    let phone = from.split('@')[0];
    try {
      const contact = await msg.getContact();
      if (contact?.number) {
        phone = contact.number; // Real phone: 972546300783
      }
    } catch (_) {}

    // Register chat object for sending replies (handles LID format)
    try {
      const chat = await msg.getChat();
      registerChat(phone, chat);
    } catch (_) {}

    // Cancel any pending follow-ups when lead replies
    const cancelled = cancelFollowUps(phone);
    if (cancelled > 0) {
      log.info({ phone, cancelled }, 'follow-ups cancelled on reply');
    }

    // Use original chat ID for sending (whatsapp-web.js native format)
    const jid = from;

    // Handle media messages
    if (msg.hasMedia) {
      log.info({ phone }, 'media message received');
      try {
        await sendWithTyping(adapter, jid, MEDIA_RESPONSE);
      } catch (err) {
        log.error({ err, phone }, 'failed to send media response');
      }
      return;
    }

    const text: string = msg.body ?? '';
    if (!text.trim()) return;

    log.info({ phone, preview: text.slice(0, 50) }, 'incoming message');

    const db = getDb();

    // Create lead if not exists
    const existingLead = db
      .prepare('SELECT id FROM leads WHERE phone = ?')
      .get(phone) as { id: number } | undefined;

    if (!existingLead) {
      db.prepare('INSERT INTO leads (phone) VALUES (?)').run(phone);
      log.info({ phone }, 'new lead created');
    }

    // Route to batcher -> AI conversation
    addMessageToBatch(
      phone,
      text,
      async (batchPhone: string, batchMessages: string[]) => {
        try {
          await handleConversation(batchPhone, batchMessages, adapter);
        } catch (err) {
          log.error({ err, phone: batchPhone }, 'conversation handling failed');
        }
      }
    );
  });

  log.info('message handler registered');
}
