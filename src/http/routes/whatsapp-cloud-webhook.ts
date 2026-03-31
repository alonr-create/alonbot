import { Router } from 'express';
import { parseWebhookPayload } from '../../whatsapp/cloud-api.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

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
 * Phase 9: logs messages with phoneNumberId tag — routing to conversation handler is Phase 10.
 */
cloudWebhookRouter.post('/whatsapp-cloud-webhook', (req, res) => {
  try {
    const messages = parseWebhookPayload(req.body);

    if (messages.length > 0) {
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
      }
    }
  } catch (err: any) {
    log.error({ err }, 'cloud-webhook: error processing POST (non-fatal)');
  }

  // Always 200 — Meta will retry on non-200 responses
  res.status(200).json({ status: 'ok' });
});
