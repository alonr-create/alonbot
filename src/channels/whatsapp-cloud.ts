import { config } from '../utils/config.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';
import { createMondayLead } from '../utils/monday-leads.js';
import { withRetry } from '../utils/retry.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';

const log = createLogger('whatsapp-cloud');

function nowIsrael(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}

const GRAPH_API = 'https://graph.facebook.com/v21.0';

// Phone number → workspace/token mapping for multi-tenant WhatsApp
interface PhoneConfig {
  phoneNumberId: string;
  token: string;
  workspaceId: string;
  source: string;
}

function buildPhoneMap(): Map<string, PhoneConfig> {
  const map = new Map<string, PhoneConfig>();
  // Primary: דקל לפרישה (148)
  if (config.waCloudPhoneId && config.waCloudToken) {
    map.set(config.waCloudPhoneId, {
      phoneNumberId: config.waCloudPhoneId,
      token: config.waCloudToken,
      workspaceId: 'dekel',
      source: 'voice_agent',
    });
  }
  // Secondary: Alon.dev (3249)
  if (config.waCloudPhoneId2 && config.waCloudToken2) {
    map.set(config.waCloudPhoneId2, {
      phoneNumberId: config.waCloudPhoneId2,
      token: config.waCloudToken2,
      workspaceId: 'alon_dev',
      source: 'alon_dev_whatsapp',
    });
  }
  return map;
}

export function createWhatsAppCloudAdapter(): ChannelAdapter {
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;

  const token = config.waCloudToken;
  const phoneNumberId = config.waCloudPhoneId;
  const phoneMap = buildPhoneMap();

  if (!token || !phoneNumberId) {
    log.warn('WA_CLOUD_TOKEN or WA_CLOUD_PHONE_ID not set');
  }
  if (config.waCloudPhoneId2) {
    log.info({ phoneId2: config.waCloudPhoneId2 }, 'second WhatsApp number configured (Alon.dev)');
  }

  function getPhoneConfig(forPhoneId?: string): PhoneConfig {
    if (forPhoneId && phoneMap.has(forPhoneId)) return phoneMap.get(forPhoneId)!;
    // Default to primary
    return { phoneNumberId: phoneNumberId, token: token, workspaceId: 'dekel', source: 'voice_agent' };
  }

  async function sendGraphApi(endpoint: string, body: Record<string, unknown>, usePhoneId?: string, useToken?: string) {
    const pid = usePhoneId || phoneNumberId;
    const tk = useToken || token;
    const res = await withRetry(() => fetch(`${GRAPH_API}/${pid}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tk}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }));
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) {
      log.error({ status: res.status, data, phoneId: pid }, 'Graph API error');
    }
    return data;
  }

  async function uploadMedia(buffer: Buffer, mimeType: string, filename: string, usePhoneId?: string, useToken?: string): Promise<string | null> {
    const pid = usePhoneId || phoneNumberId;
    const tk = useToken || token;
    try {
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
      formData.append('type', mimeType);

      const res = await fetch(`${GRAPH_API}/${pid}/media`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tk}` },
        body: formData,
      });
      const data = await res.json() as { id?: string; error?: { message?: string; code?: number } };
      if (!data.id) {
        log.error({ filename, mimeType, error: data.error }, 'media upload returned no id');
        return null;
      }
      return data.id;
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
        // Extract receiving phone_number_id from Meta webhook metadata
        const receivingPhoneId = value.metadata?.phone_number_id || phoneNumberId;
        if (value.messages) {
          for (const msg of value.messages) {
            processIncomingMessage(msg, value.contacts, undefined, receivingPhoneId).catch(err =>
              log.error({ err: err.message }, 'error processing message')
            );
          }
        }
        if (value.statuses) {
          for (const s of value.statuses) {
            log.debug({ recipient: s.recipient_id, status: s.status, wamid: s.id }, 'delivery receipt');
            try {
              // db already imported at top of file
              const now = nowIsrael().replace('T', ' ');
              const phone = (s.recipient_id || '').replace(/^\+/, '');
              const wamid = s.id || '';
              if (wamid && phone) {
                db.prepare(`INSERT INTO delivery_receipts (wamid, phone, status, created_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(wamid) DO UPDATE SET status = excluded.status`).run(wamid, phone, s.status, now);
                if (s.status === 'sent') db.prepare('UPDATE delivery_receipts SET sent_at = ? WHERE wamid = ?').run(now, wamid);
                if (s.status === 'delivered') db.prepare('UPDATE delivery_receipts SET delivered_at = ? WHERE wamid = ?').run(now, wamid);
                if (s.status === 'read') db.prepare('UPDATE delivery_receipts SET read_at = ? WHERE wamid = ?').run(now, wamid);
                if (s.status === 'failed') {
                  const err = s.errors?.[0];
                  db.prepare('UPDATE delivery_receipts SET failed_at = ?, error_code = ?, error_title = ? WHERE wamid = ?')
                    .run(now, err?.code || '', err?.title || '', wamid);
                }
              }
            } catch (e) { log.warn({ err: (e as Error).message }, 'delivery receipt save failed'); }
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
      // Always process on this instance (cloud or local) — keeps all messages in one DB
      // Local tools (shell, camera) are proxied via localApiUrl when needed
      processWebhookEntries(body);
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

  // Dedup at adapter level — prevent processing same wamid twice
  const processedWamIds = new Map<string, number>();
  // Outbound dedup — prevent sending identical messages within 30s
  const lastOutbound = new Map<string, { text: string; ts: number }>();
  setInterval(() => {
    const cutoff = Date.now() - 600_000; // 10 min
    for (const [k, v] of processedWamIds) if (v < cutoff) processedWamIds.delete(k);
  }, 120_000);

  async function processIncomingMessage(msg: any, contacts?: any[] | null, overrideFrom?: string, receivingPhoneId?: string) {
    if (!messageHandler) return;

    const from = overrideFrom || msg.from;
    if (!from) return;

    // Dedup by wamid
    const wamid = msg.id;
    if (wamid && processedWamIds.has(wamid)) {
      log.warn({ wamid }, 'duplicate wamid skipped');
      return;
    }
    if (wamid) processedWamIds.set(wamid, Date.now());

    // Determine which phone number received this message → workspace routing
    const phoneCfg = getPhoneConfig(receivingPhoneId);

    // Normalize phone number
    let senderId = from.replace(/^\+/, '');

    // Get sender name from contacts array or fallback
    let senderName = senderId;
    if (contacts) {
      const contact = contacts.find((c: any) => c.wa_id === from);
      if (contact?.profile?.name) senderName = contact.profile.name;
    }

    log.debug({ from: senderId, type: msg.type, workspace: phoneCfg.workspaceId, receivingPhone: receivingPhoneId }, 'Cloud API message received');

    // Auto-upsert lead in leads table for dashboard tracking
    // Source is determined by which phone number received the message
    try {
      const pushName = senderName !== senderId ? senderName : '';
      const now = nowIsrael();
      db.prepare(`INSERT INTO leads (phone, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET name = COALESCE(NULLIF(?, ''), name), source = ?, updated_at = ?`).run(senderId, pushName, phoneCfg.source, now, now, pushName, phoneCfg.source, now);
    } catch (e: any) {
      log.warn({ err: e.message, senderId }, 'lead upsert failed');
    }

    // Security: check allowed list or lead status
    const isAllowed = config.allowedWhatsApp.length === 0 || config.allowedWhatsApp.includes(senderId);
    let isLead = false;
    try {
      const lead = db.prepare('SELECT phone FROM leads WHERE phone = ?').get(senderId) as any;
      isLead = !!lead;
    } catch (e) { log.debug({ err: (e as Error).message, senderId }, 'lead check DB query failed'); }

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
        const buffer = await downloadCloudMedia(mediaId, phoneCfg.token);
        if (buffer) {
          image = buffer.toString('base64');
          imageMediaType = (msg.image?.mime_type as UnifiedMessage['imageMediaType']) || 'image/jpeg';
        }
      }
    } else if (type === 'document') {
      text = msg.document?.caption || '';
      const mediaId = msg.document?.id;
      if (mediaId) {
        const buffer = await downloadCloudMedia(mediaId, phoneCfg.token);
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
          const buffer = await downloadCloudMedia(mediaId, phoneCfg.token);
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
      text = '[סטיקר]';
      // Download sticker image for dashboard display
      const stickerId = msg.sticker?.id;
      if (stickerId) {
        const buffer = await downloadCloudMedia(stickerId, phoneCfg.token);
        if (buffer) {
          image = buffer.toString('base64');
          imageMediaType = 'image/webp';
        }
      }
    } else if (type === 'location') {
      text = `[מיקום: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
    } else if (type === 'contacts') {
      text = '[איש קשר שותף]';
    } else if (type === 'interactive') {
      // User clicked a button or selected from a list
      const interactive = msg.interactive;
      if (interactive?.type === 'button_reply') {
        text = interactive.button_reply?.title || interactive.button_reply?.id || '[כפתור]';
      } else if (interactive?.type === 'list_reply') {
        text = interactive.list_reply?.title || interactive.list_reply?.id || '[בחירה מרשימה]';
      } else {
        text = '[תגובה אינטראקטיבית]';
      }
    } else if (type === 'reaction') {
      // Skip reactions
      return;
    } else {
      text = `[${type}]`;
    }

    if (!text && !image && !document) return;

    // Save incoming media to disk for dashboard display
    let mediaPath: string | undefined;
    if (image || document) {
      try {
        const mediaDir = join(config.dataDir, 'media');
        if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
        const ext = image ? (imageMediaType === 'image/png' ? '.png' : imageMediaType === 'image/webp' ? '.webp' : '.jpg') : (documentName?.split('.').pop() || 'bin');
        const filename = `${senderId}_${Date.now()}.${ext.replace(/^\./, '')}`;
        const filepath = join(mediaDir, filename);
        writeFileSync(filepath, Buffer.from((image || document)!, 'base64'));
        mediaPath = filename;
        // Prepend media tag to text for dashboard rendering
        if (image) {
          text = `[media:image:${filename}]${text ? ' ' + text : ''}`;
        } else {
          text = `[media:file:${filename}:${documentName || 'file'}]${text ? ' ' + text : ''}`;
        }
        log.debug({ filename, type: image ? 'image' : 'document' }, 'media saved for dashboard');
      } catch (e: any) {
        log.warn({ err: e.message }, 'media save failed');
      }
    }

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
      raw: { from: senderId, cloudApi: true, receivingPhoneId: phoneCfg.phoneNumberId },
    };

    messageHandler(unified);
  }

  async function downloadCloudMedia(mediaId: string, useToken?: string): Promise<Buffer | null> {
    const tk = useToken || token;
    try {
      // Step 1: Get media URL
      const metaRes = await fetch(`${GRAPH_API}/${mediaId}`, {
        headers: { 'Authorization': `Bearer ${tk}` },
      });
      const meta = await metaRes.json() as { url?: string };
      if (!meta.url) return null;

      // Step 2: Download the actual file
      const fileRes = await fetch(meta.url, {
        headers: { 'Authorization': `Bearer ${tk}` },
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

      // Determine which phone number to reply from (based on which received the message)
      const rawData = original.raw as Record<string, any> | undefined;
      const replyPhoneCfg = getPhoneConfig(rawData?.receivingPhoneId);
      const replyPhoneId = replyPhoneCfg.phoneNumberId;
      const replyToken = replyPhoneCfg.token;

      // Dedup: skip if exact same text was sent to same number within 30s
      if (reply.text && !reply.template && !reply.image && !reply.voice && !reply.document) {
        const last = lastOutbound.get(to);
        if (last && last.text === reply.text && Date.now() - last.ts < 30_000) {
          log.warn({ to, chars: reply.text.length }, 'outbound dedup — skipping duplicate reply');
          return;
        }
        lastOutbound.set(to, { text: reply.text, ts: Date.now() });
        // Cleanup old entries
        if (lastOutbound.size > 100) {
          const cutoff = Date.now() - 60_000;
          for (const [k, v] of lastOutbound) if (v.ts < cutoff) lastOutbound.delete(k);
        }
      }

      // Template message (works outside 24-hour window)
      if (reply.template) {
        const tpl: any = {
          name: reply.template,
          language: { code: reply.templateLanguage || 'he' },
        };
        if (reply.templateParams && reply.templateParams.length > 0) {
          tpl.components = [{
            type: 'body',
            parameters: reply.templateParams.map(val => ({ type: 'text', text: val })),
          }];
        }
        await sendGraphApi('messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: tpl,
        }, replyPhoneId, replyToken);
        return;
      }

      // Voice message
      if (reply.voice) {
        const mediaId = await uploadMedia(reply.voice, 'audio/ogg', 'voice.ogg', replyPhoneId, replyToken);
        if (mediaId) {
          await sendGraphApi('messages', {
            messaging_product: 'whatsapp',
            to,
            type: 'audio',
            audio: { id: mediaId },
          }, replyPhoneId, replyToken);
        } else {
          log.error({ to }, 'voice upload failed — sending text fallback');
          await sendGraphApi('messages', {
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: reply.text || '⚠️ לא הצלחתי לשלוח הודעה קולית' },
          }, replyPhoneId, replyToken);
          return;
        }
      }

      // Document
      if (reply.document) {
        const mime = reply.documentMimetype || 'application/octet-stream';
        const filename = reply.documentName || 'file';
        const mediaId = await uploadMedia(reply.document, mime, filename, replyPhoneId, replyToken);
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
          }, replyPhoneId, replyToken);
          return; // Caption included with document
        }
      }

      // Image
      if (reply.image) {
        const mediaId = await uploadMedia(reply.image, 'image/png', 'image.png', replyPhoneId, replyToken);
        if (mediaId) {
          await sendGraphApi('messages', {
            messaging_product: 'whatsapp',
            to,
            type: 'image',
            image: {
              id: mediaId,
              caption: reply.text || undefined,
            },
          }, replyPhoneId, replyToken);
          // Save outbound image to disk + tag DB for dashboard display
          try {
            const mediaDir = join(config.dataDir, 'media');
            if (!existsSync(mediaDir)) mkdirSync(mediaDir, { recursive: true });
            const filename = `out_${to}_${Date.now()}.png`;
            writeFileSync(join(mediaDir, filename), reply.image);
            const taggedContent = `[media:image:${filename}]${reply.text ? ' ' + reply.text : ''}`;
            db.prepare(`UPDATE messages SET content = ? WHERE rowid = (SELECT MAX(rowid) FROM messages WHERE channel = 'whatsapp-outbound' AND sender_id = ? AND role = 'assistant')`).run(taggedContent, to);
          } catch (e: any) {
            log.warn({ err: e.message }, 'outbound image save failed (non-critical)');
          }
          return; // Caption included with image
        }
      }

      // Interactive buttons (up to 3 quick-reply buttons)
      if (reply.buttons && reply.buttons.length > 0) {
        const interactive: any = {
          type: 'button',
          body: { text: reply.interactiveBody || reply.text || '' },
          action: {
            buttons: reply.buttons.slice(0, 3).map(b => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        };
        if (reply.interactiveHeader) interactive.header = { type: 'text', text: reply.interactiveHeader };
        if (reply.interactiveFooter) interactive.footer = { text: reply.interactiveFooter };
        await sendGraphApi('messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive,
        }, replyPhoneId, replyToken);
        return;
      }

      // Interactive list (up to 10 rows across sections)
      if (reply.listSections && reply.listSections.length > 0) {
        const interactive: any = {
          type: 'list',
          body: { text: reply.interactiveBody || reply.text || '' },
          action: {
            button: reply.listButtonText || 'בחר אופציה',
            sections: reply.listSections.map(s => ({
              title: s.title.slice(0, 24),
              rows: s.rows.slice(0, 10).map(r => ({
                id: r.id,
                title: r.title.slice(0, 24),
                description: r.description?.slice(0, 72),
              })),
            })),
          },
        };
        if (reply.interactiveHeader) interactive.header = { type: 'text', text: reply.interactiveHeader };
        if (reply.interactiveFooter) interactive.footer = { text: reply.interactiveFooter };
        await sendGraphApi('messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive,
        }, replyPhoneId, replyToken);
        return;
      }

      // CTA URL button
      if (reply.ctaUrl) {
        await sendGraphApi('messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            body: { text: reply.interactiveBody || reply.text || '' },
            action: {
              name: 'cta_url',
              parameters: {
                display_text: reply.ctaUrl.display_text,
                url: reply.ctaUrl.url,
              },
            },
          },
        }, replyPhoneId, replyToken);
        return;
      }

      // Text message
      if (reply.text) {
        await sendGraphApi('messages', {
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: reply.text },
        }, replyPhoneId, replyToken);
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
