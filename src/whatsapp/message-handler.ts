import type { WASocket } from '@whiskeysockets/baileys';
import { createLogger } from '../utils/logger.js';
import { getDb } from '../db/index.js';
import { sendWithTyping } from './rate-limiter.js';

const log = createLogger('message-handler');

const TEST_RESPONSE =
  'היי! הגעת לאלון מ-Alon.dev. המערכת בשלבי הקמה, אחזור אליך בקרוב!';

/**
 * Set up the incoming message handler on the Baileys socket.
 * Processes incoming text messages, stores them in the database,
 * creates leads if needed, and sends a test response.
 */
export function setupMessageHandler(sock: WASocket): void {
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only handle real-time notifications, not history sync
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Skip own messages
      if (msg.key.fromMe) continue;

      // Skip protocol messages (no content)
      if (!msg.message) continue;

      // Extract text content
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text;

      // Skip non-text messages (media handled in later phases)
      if (!text) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // Extract phone number from JID
      const phone = remoteJid.replace(/@s\.whatsapp\.net$/, '');

      log.info(
        { phone, preview: text.slice(0, 50) },
        'incoming message'
      );

      const db = getDb();

      // Store incoming message
      db.prepare(
        'INSERT INTO messages (phone, direction, content) VALUES (?, ?, ?)'
      ).run(phone, 'in', text);

      // Check if lead exists, create if not
      const existingLead = db
        .prepare('SELECT id FROM leads WHERE phone = ?')
        .get(phone) as { id: number } | undefined;

      let leadId: number;
      if (!existingLead) {
        const result = db
          .prepare('INSERT INTO leads (phone) VALUES (?)')
          .run(phone);
        leadId = Number(result.lastInsertRowid);
        log.info({ phone, leadId }, 'new lead created');
      } else {
        leadId = existingLead.id;
      }

      // Send test response via rate-limited sender
      try {
        await sendWithTyping(sock, remoteJid, TEST_RESPONSE);

        log.info({ phone, leadId }, 'test response sent');

        // Store outbound message
        db.prepare(
          'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)'
        ).run(phone, leadId, 'out', TEST_RESPONSE);
      } catch (err) {
        log.error({ err, phone }, 'failed to send test response');
      }
    }
  });

  log.info('message handler registered');
}
