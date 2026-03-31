import { Router } from 'express';
import { parseWebhookPayload, createCloudAdapter } from '../../whatsapp/cloud-api.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { addMessageToBatch } from '../../whatsapp/message-batcher.js';
import { handleConversation } from '../../ai/conversation.js';
import { cancelFollowUps } from '../../follow-up/follow-up-db.js';
import { isAdminPhone } from '../../db/tenant-config.js';

const log = createLogger('cloud-webhook');

export const cloudWebhookRouter = Router();

/**
 * GET /whatsapp-cloud-webhook
 * Meta verification endpoint — called once during webhook setup.
 */
cloudWebhookRouter.get('/whatsapp-cloud-webhook', (req, res) => {
  const mode = req.query['hub.mode'] as string;
  const token = req.query['hub.verify_token'] as string;
  const challenge = req.query['hub.challenge'] as string;

  if (mode === 'subscribe' && token === config.waCloudVerifyToken) {
    log.info({ mode }, 'cloud-webhook: verification successful');
    res.status(200).send(challenge);
    return;
  }

  log.warn({ mode, token: token ? '[present]' : '[missing]' }, 'cloud-webhook: verification failed');
  res.status(403).json({ error: 'Forbidden' });
});

/**
 * POST /whatsapp-cloud-webhook
 * Receives incoming WhatsApp messages from Meta Cloud API.
 * Always returns 200 to prevent Meta retry storms.
 * Routes text messages through message batcher → AI conversation handler.
 */
cloudWebhookRouter.post('/whatsapp-cloud-webhook', (req, res) => {
  try {
    const messages = parseWebhookPayload(req.body);

    for (const msg of messages) {
      log.info(
        {
          phoneNumberId: msg.phoneNumberId,
          senderPhone: msg.senderPhone,
          messageId: msg.messageId,
          textPreview: msg.text.slice(0, 50),
        },
        'cloud-webhook: incoming message'
      );

      // Skip admin phone — boss messages are not processed via Cloud API webhook
      if (isAdminPhone(msg.senderPhone)) {
        log.info({ phone: msg.senderPhone }, 'cloud-webhook: skipping admin phone');
        continue;
      }

      // Cancel any pending follow-ups when lead replies
      const cancelled = cancelFollowUps(msg.senderPhone);
      if (cancelled > 0) {
        log.info({ phone: msg.senderPhone, cancelled }, 'cloud-webhook: follow-ups cancelled on reply');
      }

      // Build Cloud API adapter scoped to this message's phone number ID
      const adapter = createCloudAdapter(msg.phoneNumberId);
      const senderPhone = msg.senderPhone;

      // Route through message batcher → AI conversation
      addMessageToBatch(
        senderPhone,
        msg.text,
        async (batchPhone: string, batchMessages: string[]) => {
          try {
            await handleConversation(batchPhone, batchMessages, adapter);
          } catch (err: any) {
            log.error({ err, phone: batchPhone }, 'cloud-webhook: conversation handling failed');
          }
        }
      );
    }
  } catch (err: any) {
    log.error({ err }, 'cloud-webhook: error processing POST (non-fatal)');
  }

  // Always 200 — Meta will retry on non-200 responses
  res.status(200).json({ status: 'ok' });
});
