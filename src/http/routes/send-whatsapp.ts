import { Router } from 'express';
import { getAdapter } from '../../whatsapp/connection.js';
import { getDb } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { sendCloudMessage } from '../../whatsapp/cloud-api.js';

const log = createLogger('send-whatsapp');

export const sendWhatsappRouter = Router();

/**
 * POST /api/send-whatsapp
 * External API for sending WhatsApp messages (used by Voice Agent).
 * Secured with API_SECRET header.
 *
 * Body: { phone: "972XXXXXXXXX" | "05XXXXXXXX", message: "text", source?: "dekel" | "alon-dev", leadName?: "string" }
 * Header: x-api-secret: <API_SECRET env var>
 */
sendWhatsappRouter.post('/api/send-whatsapp', async (req, res) => {
  // Auth check — fail-closed: reject if no secret configured
  const secret = process.env.API_SECRET || process.env.DASHBOARD_SECRET;
  if (!secret || req.headers['x-api-secret'] !== secret) {
    log.warn('unauthorized send-whatsapp attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { phone, message, source, leadName, phone_number_id } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message required' });
  }

  try {
    // Normalize phone: 05XXXXXXXX → 972XXXXXXXX
    let normalized = phone.replace(/[\s\-\(\)]/g, '');
    if (normalized.startsWith('+')) normalized = normalized.slice(1);
    if (normalized.startsWith('0')) normalized = '972' + normalized.slice(1);

    // Tag lead in DB so conversation handler knows the source
    if (source) {
      try {
        const db = getDb();
        const existing = db.prepare('SELECT id FROM leads WHERE phone = ?').get(normalized) as { id: number } | undefined;
        if (existing) {
          db.prepare('UPDATE leads SET source_detail = ? WHERE phone = ?').run(source, normalized);
          log.info({ phone: normalized, source }, 'tagged existing lead with source');
        } else if (leadName) {
          db.prepare('INSERT INTO leads (phone, name, source, source_detail, status) VALUES (?, ?, ?, ?, ?)').run(
            normalized, leadName, 'voice-agent', source, 'contacted'
          );
          log.info({ phone: normalized, name: leadName, source }, 'created new lead from voice agent');
        }
      } catch (dbErr: any) {
        log.warn({ err: dbErr }, 'failed to tag lead source (non-fatal)');
      }
    }

    // Routing: if phone_number_id provided AND WA_CLOUD_TOKEN is set → use Cloud API
    const cloudToken = process.env.WA_CLOUD_TOKEN;
    if (phone_number_id && cloudToken) {
      const result = await sendCloudMessage({ to: normalized, message, phoneNumberId: phone_number_id });
      if (!result.success) {
        log.error({ phone: normalized, phone_number_id, error: result.error }, 'Cloud API send failed');
        return res.status(500).json({ error: result.error });
      }
      log.info({ phone: normalized, phone_number_id }, 'WhatsApp message sent via Cloud API');
      return res.json({ success: true, phone: normalized, via: 'cloud-api' });
    }

    // Default path: whatsapp-web.js adapter (backward compatible)
    const adapter = getAdapter();
    if (!adapter) {
      log.error('WhatsApp not connected');
      return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const jid = `${normalized}@s.whatsapp.net`;
    await adapter.sendMessage(jid, { text: message });

    log.info({ phone: normalized, source }, 'WhatsApp message sent via API');
    res.json({ success: true, phone: normalized });
  } catch (err: any) {
    log.error({ err, phone }, 'Failed to send WhatsApp message');
    res.status(500).json({ error: err.message });
  }
});
