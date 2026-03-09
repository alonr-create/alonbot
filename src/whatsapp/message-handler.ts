import type { WASocket } from '@whiskeysockets/baileys';
import { createLogger } from '../utils/logger.js';
import { getDb } from '../db/index.js';
import { sendWithTyping } from './rate-limiter.js';
import { addMessageToBatch } from './message-batcher.js';
import { handleConversation, sendFirstMessage } from '../ai/conversation.js';
import { setOnNewLeadCallback } from '../monday/webhook-handler.js';

const log = createLogger('message-handler');

const MEDIA_RESPONSE =
  'קיבלתי! כרגע אני עובד רק עם הודעות טקסט, אבל אשמח לעזור - ספר לי במילים מה אתה מחפש';

/**
 * Set up the incoming message handler on the Baileys socket.
 * Routes incoming text to message batcher -> AI conversation flow.
 * Handles non-text media with a friendly text-only notice.
 * Wires Monday.com new-lead callback for auto-intro.
 */
export function setupMessageHandler(sock: WASocket): void {
  // Wire Monday.com webhook callback for first message
  setOnNewLeadCallback(async (phone: string, name: string, interest: string) => {
    await sendFirstMessage(phone, name, interest, sock);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only handle real-time notifications, not history sync
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip own messages
      if (msg.key.fromMe) continue;

      // Skip protocol messages (no content)
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // Extract phone number from JID
      const phone = remoteJid.replace(/@s\.whatsapp\.net$/, '');

      // Check for media messages
      const hasMedia =
        msg.message.imageMessage ||
        msg.message.audioMessage ||
        msg.message.videoMessage ||
        msg.message.documentMessage;

      if (hasMedia) {
        log.info({ phone, mediaType: 'media' }, 'media message received');
        try {
          await sendWithTyping(sock, remoteJid, MEDIA_RESPONSE);
        } catch (err) {
          log.error({ err, phone }, 'failed to send media response');
        }
        continue;
      }

      // Extract text content
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text;

      // Skip non-text, non-media messages
      if (!text) continue;

      log.info(
        { phone, preview: text.slice(0, 50) },
        'incoming message',
      );

      const db = getDb();

      // Check if lead exists, create if not
      const existingLead = db
        .prepare('SELECT id FROM leads WHERE phone = ?')
        .get(phone) as { id: number } | undefined;

      if (!existingLead) {
        db.prepare('INSERT INTO leads (phone) VALUES (?)').run(phone);
        log.info({ phone }, 'new lead created');
      }

      // Store incoming message immediately (for restart resilience)
      // Note: handleConversation will also store, but we want the message
      // persisted even if the bot crashes before AI responds
      // Actually, handleConversation stores messages - we skip double-storing
      // by letting the batcher handle it

      // Route to batcher -> AI conversation
      addMessageToBatch(
        phone,
        text,
        async (batchPhone: string, batchMessages: string[]) => {
          try {
            await handleConversation(batchPhone, batchMessages, sock);
          } catch (err) {
            log.error({ err, phone: batchPhone }, 'conversation handling failed');
          }
        },
      );
    }
  });

  log.info('message handler registered');
}
