import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import { parseWebhookPayload, createCloudAdapter } from '../../whatsapp/cloud-api.js';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { addMessageToBatch } from '../../whatsapp/message-batcher.js';
import { handleConversation } from '../../ai/conversation.js';
import { cancelFollowUps } from '../../follow-up/follow-up-db.js';
import { isAdminPhone } from '../../db/tenant-config.js';
import { lookupTenantByPhoneNumberId } from '../../db/tenants.js';
import { getDb } from '../../db/index.js';

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
  // Verify Meta X-Hub-Signature-256 HMAC
  const appSecret = process.env.META_APP_SECRET;
  if (appSecret) {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!signature) {
      log.warn('cloud-webhook: missing X-Hub-Signature-256 header');
      res.status(401).json({ error: 'Missing signature' });
      return;
    }

    const rawBody = (req as any)._rawBody as Buffer | undefined;
    if (!rawBody) {
      log.error('cloud-webhook: raw body not captured — cannot verify signature');
      res.status(500).json({ error: 'Internal error' });
      return;
    }

    const expectedSig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSig);
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      log.warn('cloud-webhook: invalid HMAC signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  }

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

      // Resolve tenant from phoneNumberId for multi-tenant routing
      const tenant = lookupTenantByPhoneNumberId(msg.phoneNumberId) ?? undefined;
      if (tenant) {
        log.info({ phoneNumberId: msg.phoneNumberId, tenant: tenant.name }, 'cloud-webhook: tenant resolved');
      } else {
        log.warn({ phoneNumberId: msg.phoneNumberId }, 'cloud-webhook: no tenant found for phoneNumberId — falling back to global config');
      }

      const isAdmin = isAdminPhone(msg.senderPhone, tenant);
      if (isAdmin) {
        log.info({ phone: msg.senderPhone }, 'cloud-webhook: admin phone — boss mode');
      }

      // Persist incoming message immediately — before batcher/AI, so it's never lost
      try {
        const db = getDb();
        const lead = db.prepare('SELECT id FROM leads WHERE phone = ?').get(msg.senderPhone) as { id: number } | undefined;
        db.prepare(
          'INSERT INTO messages (phone, lead_id, direction, content, tenant_id) VALUES (?, ?, ?, ?, ?)'
        ).run(msg.senderPhone, lead?.id ?? null, 'in', msg.text, tenant?.id ?? null);
        // Upsert lead record if not exists
        db.prepare(`
          INSERT OR IGNORE INTO leads (phone, source, status, tenant_id, created_at, updated_at)
          VALUES (?, 'whatsapp-cloud', 'new', ?, datetime('now'), datetime('now'))
        `).run(msg.senderPhone, tenant?.id ?? null);
      } catch (dbErr: any) {
        log.warn({ dbErr, phone: msg.senderPhone }, 'cloud-webhook: failed to persist incoming message');
      }

      // Cancel any pending follow-ups when lead replies (not for admin)
      const cancelled = isAdmin ? 0 : cancelFollowUps(msg.senderPhone);
      if (cancelled > 0) {
        log.info({ phone: msg.senderPhone, cancelled }, 'cloud-webhook: follow-ups cancelled on reply');
      }

      // Build Cloud API adapter scoped to this message's phone number ID and tenant token
      const adapter = createCloudAdapter(msg.phoneNumberId, tenant?.wa_cloud_token ?? undefined);
      const senderPhone = msg.senderPhone;

      // Route through message batcher → AI conversation (with tenant context)
      addMessageToBatch(
        senderPhone,
        msg.text,
        async (batchPhone: string, batchMessages: string[]) => {
          try {
            await handleConversation(batchPhone, batchMessages, adapter, tenant);
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
