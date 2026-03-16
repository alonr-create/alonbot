import { Router } from 'express';
import { getAdapter } from '../../whatsapp/connection.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('send-whatsapp');

export const sendWhatsappRouter = Router();

/**
 * POST /api/send-whatsapp
 * External API for sending WhatsApp messages (used by Voice Agent).
 * Secured with API_SECRET header.
 *
 * Body: { phone: "972XXXXXXXXX" | "05XXXXXXXX", message: "text" }
 * Header: x-api-secret: <API_SECRET env var>
 */
sendWhatsappRouter.post('/api/send-whatsapp', async (req, res) => {
  // Auth check
  const secret = process.env.API_SECRET;
  if (secret && req.headers['x-api-secret'] !== secret) {
    log.warn('unauthorized send-whatsapp attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { phone, message } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message required' });
  }

  const adapter = getAdapter();
  if (!adapter) {
    log.error('WhatsApp not connected');
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  try {
    // Normalize phone: 05XXXXXXXX → 972XXXXXXXX
    let normalized = phone.replace(/[\s\-\(\)]/g, '');
    if (normalized.startsWith('+')) normalized = normalized.slice(1);
    if (normalized.startsWith('0')) normalized = '972' + normalized.slice(1);

    const jid = `${normalized}@s.whatsapp.net`;
    await adapter.sendMessage(jid, { text: message });

    log.info({ phone: normalized }, 'WhatsApp message sent via API');
    res.json({ success: true, phone: normalized });
  } catch (err: any) {
    log.error({ err, phone }, 'Failed to send WhatsApp message');
    res.status(500).json({ error: err.message });
  }
});
