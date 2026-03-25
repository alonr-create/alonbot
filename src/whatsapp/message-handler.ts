import { createLogger } from '../utils/logger.js';
import { getDb } from '../db/index.js';
import { sendWithTyping } from './rate-limiter.js';
import { addMessageToBatch } from './message-batcher.js';
import { handleConversation, sendFirstMessage } from '../ai/conversation.js';
import { setOnNewLeadCallback, setWebhookBotAdapter } from '../monday/webhook-handler.js';
import { cancelFollowUps } from '../follow-up/follow-up-db.js';
import { transcribeAudio } from '../ai/voice-transcribe.js';
import { analyzeImage } from '../ai/image-analysis.js';
import { isAdminPhone } from '../db/tenant-config.js';
import { createBoardItem, updateColumnValue } from '../monday/api.js';
import { config } from '../config.js';
import type { BotAdapter } from './connection.js';
import { registerChat } from './connection.js';

const log = createLogger('message-handler');

const IMAGE_MEDIA_RESPONSE =
  'קיבלתי! כרגע אני עובד רק עם הודעות טקסט ואודיו, אבל אשמח לעזור - ספר לי במילים מה אתה מחפש';
const VOICE_FAIL_RESPONSE =
  'קיבלתי את ההודעה הקולית 🎤 אבל לא הצלחתי לתמלל אותה. אפשר לנסות שוב או לכתוב בטקסט?';

/**
 * Create a new lead in local DB + Monday.com board.
 * Sets source_detail to 'facebook-ads' since all inbound WhatsApp leads
 * from the bot number come from Facebook ad campaigns.
 */
async function createNewLead(phone: string, firstMessage?: string): Promise<void> {
  const db = getDb();
  db.prepare(
    "INSERT INTO leads (phone, source, source_detail) VALUES (?, 'whatsapp', 'facebook-ads')"
  ).run(phone);
  log.info({ phone }, 'new lead created (local + Monday.com)');

  // Create Monday.com item async (non-blocking)
  const boardId = config.mondayBoardId;
  if (!boardId) return;

  try {
    const itemName = `ליד חדש — ${phone}`;
    const columnValues: Record<string, string> = {};
    if (config.mondayStatusColumnId) {
      columnValues[config.mondayStatusColumnId] = 'חדש';
    }
    const result = await createBoardItem(itemName, columnValues);
    if (result?.id) {
      const mondayItemId = parseInt(result.id, 10);
      db.prepare('UPDATE leads SET monday_item_id = ?, monday_board_id = ? WHERE phone = ?')
        .run(mondayItemId, parseInt(boardId, 10), phone);
      log.info({ phone, mondayItemId }, 'Monday.com item created for new lead');

      // Set phone column (board column ID: phone_mm16hqz2)
      try {
        await updateColumnValue(mondayItemId, parseInt(boardId, 10), 'phone_mm16hqz2', phone);
      } catch { /* phone column might have different ID */ }

      // Set source column (board column ID: text_mm16pfzp)
      try {
        await updateColumnValue(mondayItemId, parseInt(boardId, 10), 'text_mm16pfzp', 'WhatsApp בוט');
      } catch { /* source column might have different ID */ }
    }
  } catch (err) {
    log.error({ err, phone }, 'Failed to create Monday.com item for new lead');
  }
}

/**
 * Set up the incoming message handler on the whatsapp-web.js client.
 * Routes incoming text to message batcher -> AI conversation flow.
 */
export function setupMessageHandler(client: any, adapter: BotAdapter): void {
  // Register adapter for Monday.com webhook → WhatsApp messages
  setWebhookBotAdapter(adapter);

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

    // Use real phone number for sending (chat registry handles LID resolution)
    const jid = phone;

    // Handle media messages
    if (msg.hasMedia) {
      const msgType: string = msg.type ?? '';
      const isVoice = msgType === 'ptt' || msgType === 'audio';

      if (isVoice) {
        log.info({ phone, type: msgType }, 'voice message received — transcribing');
        try {
          const media = await msg.downloadMedia();
          if (media?.data) {
            const audioBuffer = Buffer.from(media.data, 'base64');
            const transcribed = await transcribeAudio(audioBuffer, media.mimetype);
            if (transcribed) {
              // Route transcribed text through the normal flow
              log.info({ phone, preview: transcribed.slice(0, 50) }, 'voice transcribed');
              // Fall through to text handling below
              msg._transcribedText = transcribed;
            } else {
              try { await sendWithTyping(adapter, jid, VOICE_FAIL_RESPONSE); } catch (e) { log.error({ err: e, phone }, 'send fail'); }
              return;
            }
          } else {
            try { await sendWithTyping(adapter, jid, VOICE_FAIL_RESPONSE); } catch (e) { log.error({ err: e, phone }, 'send fail'); }
            return;
          }
        } catch (err) {
          log.error({ err, phone }, 'voice transcription failed');
          try {
            await sendWithTyping(adapter, jid, VOICE_FAIL_RESPONSE);
          } catch (sendErr) {
            log.error({ err: sendErr, phone }, 'failed to send voice fail response');
          }
          return;
        }
      } else if (msgType === 'image' || msgType === 'sticker') {
        // Image/sticker: analyze with Claude Vision
        log.info({ phone, type: msgType }, 'image received — analyzing');
        try {
          const media = await msg.downloadMedia();
          if (media?.data) {
            // Build lead context
            const db = getDb();
            const leadRow = db
              .prepare('SELECT name, interest, status FROM leads WHERE phone = ?')
              .get(phone) as { name: string | null; interest: string | null; status: string } | undefined;
            const leadContext = leadRow
              ? `שם: ${leadRow.name || 'לא ידוע'}, עניין: ${leadRow.interest || 'לא ידוע'}, סטטוס: ${leadRow.status}`
              : 'ליד חדש';

            const analysisResult = await analyzeImage(media.data, media.mimetype, leadContext);

            // Route through normal conversation flow (add as message to batch)
            // Create lead if not exists (skip for admin — boss is not a lead)
            if (!isAdminPhone(phone)) {
              const existingLead = db
                .prepare('SELECT id FROM leads WHERE phone = ?')
                .get(phone) as { id: number } | undefined;
              if (!existingLead) {
                await createNewLead(phone);
              }
            }

            addMessageToBatch(
              phone,
              `[הלקוח שלח תמונה. תוצאת הניתוח: ${analysisResult}]`,
              async (batchPhone: string, batchMessages: string[]) => {
                try {
                  await handleConversation(batchPhone, batchMessages, adapter);
                } catch (err) {
                  log.error({ err, phone: batchPhone }, 'conversation handling failed (image)');
                }
              }
            );
          } else {
            await sendWithTyping(adapter, jid, IMAGE_MEDIA_RESPONSE);
          }
        } catch (err) {
          log.error({ err, phone }, 'image analysis failed');
          await sendWithTyping(adapter, jid, IMAGE_MEDIA_RESPONSE);
        }
        return;
      } else {
        // Non-voice, non-image media (video, documents, etc.)
        log.info({ phone, type: msgType }, 'non-voice media received');
        try {
          await sendWithTyping(adapter, jid, IMAGE_MEDIA_RESPONSE);
        } catch (err) {
          log.error({ err, phone }, 'failed to send media response');
        }
        return;
      }
    }

    const text: string = msg._transcribedText ?? msg.body ?? '';
    if (!text.trim()) return;

    const isVoiceMessage = !!msg._transcribedText;

    log.info({ phone, preview: text.slice(0, 50), voice: isVoiceMessage }, 'incoming message');

    const db = getDb();

    // Create lead if not exists (skip for admin — boss is not a lead)
    if (!isAdminPhone(phone)) {
      const existingLead = db
        .prepare('SELECT id FROM leads WHERE phone = ?')
        .get(phone) as { id: number } | undefined;

      if (!existingLead) {
        await createNewLead(phone, text);
      }
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
