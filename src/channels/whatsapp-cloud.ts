import { config } from '../utils/config.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';
import { createMondayLead } from '../utils/monday-leads.js';
import { withRetry } from '../utils/retry.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';

const log = createLogger('whatsapp-cloud');

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export function createWhatsAppCloudAdapter(): ChannelAdapter {
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;

  const token = config.waCloudToken;
  const phoneNumberId = config.waCloudPhoneId;

  if (!token || !phoneNumberId) {
    log.warn('WA_CLOUD_TOKEN or WA_CLOUD_PHONE_ID not set');
  }

  async function sendGraphApi(endpoint: string, body: Record<string, unknown>) {
    const res = await withRetry(() => fetch(`${GRAPH_API}/${phoneNumberId}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }));
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      log.error({ status: res.status, data }, 'Graph API error');
    }
    return data;
  }

  async function uploadMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string | null> {
    try {
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
      formData.append('type', mimeType);

      const res = await fetch(`${GRAPH_API}/${phoneNumberId}/media`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json() as { id?: string };
      return data.id || null;
    } catch (e: any) {
      log.error({ err: e.message }, 'media upload failed');
      return null;
    }
  }

  // Process webhook entries (extracted for cloud/local forwarding logic)
  function processWebhookEntries(body: any) {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        if (value.messages) {
          for (const msg of value.messages) {
            processIncomingMessage(msg, value.contacts).catch(err =>
              log.error({ err: err.message }, 'error processing message')
            );
          }
        }
        if (value.statuses) {
          for (const status of value.statuses) {
            log.debug({ recipient: status.recipient_id, status: status.status }, 'status update');
          }
        }
      }
    }
  }

  // Webhook handler — receives forwarded messages from the webhook middleware
  function webhookHandler(req: any, res: any) {
    const body = req.body;

    // Direct Meta webhook format
    if (body.object === 'whatsapp_business_account') {
      // Cloud mode: try forwarding to local Mac first (has local tools: shell, files, camera)
      // Only process on cloud if local is unreachable (fallback)
      if (config.mode === 'cloud' && (config as any).localApiUrl) {
        const localUrl = (config as any).localApiUrl;
        fetch(`${localUrl}/whatsapp-cloud-webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        }).then(r => {
          if (r.ok) {
            log.info('webhook forwarded to local — local will handle');
          } else {
            log.warn({ status: r.status }, 'local returned error — processing on cloud');
            processWebhookEntries(body);
          }
        }).catch(err => {
          log.warn({ err: err.message }, 'local unreachable — processing on cloud');
          processWebhookEntries(body);
        });
      } else {
        // Local mode or no local connected: process directly
        processWebhookEntries(body);
      }
      res.sendStatus(200);
      return;
    }

    // Forwarded format from webhook middleware: { from, type, text, message, timestamp }
    if (body.from && body.message) {
      processIncomingMessage(body.message, null, body.from).catch(err =>
        log.error({ err: err.message }, 'error processing forwarded message')
      );
      res.sendStatus(200);
      return;
    }

    // Webhook verification (GET is handled by Express route, but just in case)
    res.sendStatus(200);
  }

  async function processIncomingMessage(msg: any, contacts?: any[] | null, overrideFrom?: string) {
    if (!messageHandler) return;

    const from = overrideFrom || msg.from;
    if (!from) return;

    // Normalize phone number
    let senderId = from.replace(/^\+/, '');

    // Get sender name from contacts array or fallback
    let senderName = senderId;
    if (contacts) {
      const contact = contacts.find((c: any) => c.wa_id === from);
      if (contact?.profile?.name) senderName = contact.profile.name;
    }

    log.debug({ from: senderId, type: msg.type }, 'Cloud API message received');

    // Auto-upsert lead in leads table for dashboard tracking
    try {
      const pushName = senderName !== senderId ? senderName : '';
      db.prepare(`INSERT INTO leads (phone, name, source, created_at, updated_at) VALUES (?, ?, 'whatsapp', datetime('now'), datetime('now')) ON CONFLICT(phone) DO UPDATE SET name = COALESCE(NULLIF(?, ''), name), updated_at = datetime('now')`).run(senderId, pushName, pushName);
    } catch (e: any) {
      log.warn({ err: e.message, senderId }, 'lead upsert failed');
    }

    // Security: check allowed list or lead status
    const isAllowed = config.allowedWhatsApp.length === 0 || config.allowedWhatsApp.includes(senderId);
    let isLead = false;
    try {
      const lead = db.prepare('SELECT phone FROM leads WHERE phone = ?').get(senderId) as any;
      isLead = !!lead;
    } catch { /* DB error */ }

    // Ensure lead exists for dashboard tracking (even allowed users)
    if (!isLead) {
      const msgText = msg.text?.body || '[media]';
      const itemId = await createMondayLead(senderId, senderName, msgText);
      if (itemId) {
        isLead = true;
        log.info({ senderId, senderName, itemId }, 'new lead auto-created');
      } else if (!isAllowed) {
        log.debug({ senderId }, 'blocked — not allowed and lead creation failed');
        return;
      }
    }

    let text = '';
    let image: string | undefined;
    let imageMediaType: UnifiedMessage['imageMediaType'] | undefined;
    let document: string | undefined;
    let documentName: string | undefined;
    let isVoice = false;

    const type = msg.type;

    if (type === 'text') {
      text = msg.text?.body || '';
    } else if (type === 'image') {
      text = msg.image?.caption || '';
      // Download image from Cloud API
      const mediaId = msg.image?.id;
      if (mediaId) {
        const buffer = await downloadCloudMedia(mediaId);
        if (buffer) {
          image = buffer.toString('base64');
          imageMediaType = (msg.image?.mime_type as UnifiedMessage['imageMediaType']) || 'image/jpeg';
        }
      }
    } else if (type === 'document') {
      text = msg.document?.caption || '';
      const mediaId = msg.document?.id;
      if (mediaId) {
        const buffer = await downloadCloudMedia(mediaId);
        if (buffer) {
          document = buffer.toString('base64');
          documentName = msg.document?.filename || 'document';
        }
      }
    } else if (type === 'audio') {
      isVoice = true;
      const mediaId = msg.audio?.id;
      if (mediaId && config.groqApiKey) {
        try {
          const buffer = await downloadCloudMedia(mediaId);
          if (buffer) {
            const formData = new FormData();
            formData.append('file', new Blob([new Uint8Array(buffer)], { type: 'audio/ogg' }), 'voice.ogg');
            formData.append('model', 'whisper-large-v3');
            formData.append('language', 'he');

            const sttRes = await withRetry(() => fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${config.groqApiKey}` },
              body: formData,
            }));

            if (sttRes.ok) {
              const sttData = await sttRes.json() as { text: string };
              if (sttData.text) {
                text = sttData.text;
                log.info({ text: text.slice(0, 80) }, 'voice transcribed');
              }
            }
          }
        } catch (e: any) {
          log.error({ err: e.message }, 'voice STT error');
        }
      }
      if (!text) text = '[הודעה קולית — לא הצלחתי לתמלל]';
    } else if (type === 'video') {
      text = msg.video?.caption || '[סרטון]';
    } else if (type === 'sticker') {
      text = '[סטיקר — כנראה לייק/אישור/תגובה רגשית. התייחס לכוונה, לא לתמונה]';
    } else if (type === 'location') {
      text = `[מיקום: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
    } else if (type === 'contacts') {
      text = '[איש קשר שותף]';
    } else if (type === 'reaction') {
      // Skip reactions
      return;
    } else {
      text = `[${type}]`;
    }

    if (!text && !image && !document) return;

    const unified: UnifiedMessage = {
      id: msg.id || `cloud_${Date.now()}`,
      channel: 'whatsapp',
      senderId,
      senderName,
      text,
      timestamp: msg.timestamp ? parseInt(msg.timestamp) * 1000 : Date.now(),
      image,
      imageMediaType,
      document,
      documentName,
      isVoice,
      raw: { from: senderId, cloudApi: true },
    };

    messageHandler(unified);
  }

  async function downloadCloudMedia(mediaId: string): Promise<Buffer | null> {
    try {
      // Step 1: Get media URL
      const metaRes = await fetch(`${GRAPH_API}/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const meta = await metaRes.json() as { url?: string };
      if (!meta.url) return null;

      // Step 2: Download the actual file
      const fileRes = await fetch(meta.url, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const arrayBuf = await fileRes.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (e: any) {
      log.warn({ err: e.message, mediaId }, 'cloud media download failed');
      return null;
    }
  }

  return {
    name: 'whatsapp' as const,

    async start() {
      if (!token || !phoneNumberId) {
        log.error('cannot start — WA_CLOUD_TOKEN or WA_CLOUD_PHONE_ID missing');
        return;
      }
      log.info({ phoneNumberId }, 'WhatsApp Cloud API adapter started');
    },

    async stop() {
      log.info('WhatsApp Cloud API adapter stopped');
    },

    async sendReply(original: UnifiedMessage, reply: UnifiedReply) {
      if (!token || !phoneNumberId) return;
      const to = original.senderId;

      // Template message (works outside 24-hour window)
      if (reply.template) {
        await sendGraphApi('messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: reply.template,
            language: { code: reply.templateLanguage || 'he' },
          },
        });
        return;
      }

      // Voice message
      if (reply.voice) {
        const mediaId = await uploadMedia(reply.voice, 'audio/ogg', 'voice.ogg');
        if (mediaId) {
          await sendGraphApi('messages', {
            messaging_product: 'whatsapp',
            to,
            type: 'audio',
            audio: { id: mediaId },
          });
        }
      }

      // Document
      if (reply.document) {
        const mime = reply.documentMimetype || 'application/octet-stream';
        const filename = reply.documentName || 'file';
        const mediaId = await uploadMedia(reply.document, mime, filename);
        if (mediaId) {
          await sendGraphApi('messages', {
            messaging_product: 'whatsapp',
            to,
            type: 'document',
            document: {
              id: mediaId,
              filename,
              caption: reply.text || undefined,
            },
          });
          return; // Caption included with document
        }
      }

      // Image
      if (reply.image) {
        const mediaId = await uploadMedia(reply.image, 'image/png', 'image.png');
        if (mediaId) {
          await sendGraphApi('messages', {
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: {
              id: mediaId,
              caption: reply.text || undefined,
            },
          });
          return; // Caption included with image
        }
      }

      // Text message
      if (reply.text) {
        await sendGraphApi('messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: reply.text },
        });
      }
    },

    onMessage(handler) {
      messageHandler = handler;
    },

    getWebhookHandler() {
      return webhookHandler;
    },
  };
}
