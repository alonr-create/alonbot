import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import { config } from '../utils/config.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';
import { existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

const log = createLogger('whatsapp');

const SESSION_DIR = './data/whatsapp-wwjs-session';
const CHROME_SESSION = join(SESSION_DIR, 'session');

/** Remove Chrome singleton lock files that prevent restart after crash */
function clearChromeLocks() {
  if (!existsSync(CHROME_SESSION)) return;
  const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
  for (const f of lockFiles) {
    const p = join(CHROME_SESSION, f);
    try { unlinkSync(p); } catch { /* doesn't exist — fine */ }
  }
  log.info('cleared Chrome lock files');
}
const MAX_RETRIES = 10;

export function createWhatsAppAdapter(): ChannelAdapter {
  let client: InstanceType<typeof Client> | null = null;
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;
  let retryCount = 0;

  function numberFromId(chatId: string): string {
    // whatsapp-web.js uses number@c.us or number@lid for contacts
    return chatId.replace(/@c\.us$/, '').replace(/@g\.us$/, '').replace(/@lid$/, '');
  }

  // Map LID → phone number for allowed check (populated on first message via getContact)
  const lidToPhone = new Map<string, string>();

  function hasSession(): boolean {
    return existsSync(SESSION_DIR);
  }

  async function connect() {
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--no-first-run',
          '--js-flags=--max-old-space-size=128',
        ],
      },
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/niconiahi/niconiahi.github.io/main/niconiahi/niconiahi-web-versions/2.3000.1020019991.html'
      },
    });

    client.on('qr', async (qr: string) => {
      log.warn('QR code received — open http://localhost:3701 to scan');
      // Start a temporary QR server for pairing
      try {
        const { createServer } = await import('http');
        const QRCode = (await import('qrcode')).default;
        const qrServer = createServer(async (req, res) => {
          if (req.url?.startsWith('/qr.png')) {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            const buf = await QRCode.toBuffer(qr, { width: 400 });
            res.end(buf);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html dir="rtl"><head><title>WhatsApp QR</title>
<meta http-equiv="refresh" content="5">
<style>body{font-family:system-ui;text-align:center;padding:40px;background:#111;color:#fff}
img{border-radius:12px;margin:20px}h1{color:#25D366}</style>
</head><body><h1>🔗 קישור WhatsApp</h1>
<img src="/qr.png?t=${Date.now()}" width="400"><br>
<p>📱 WhatsApp > מכשירים מקושרים > קשר מכשיר</p>
</body></html>`);
        });
        qrServer.listen(3701).on('error', () => {});
        // Close QR server once connected
        client!.once('ready', () => { qrServer.close(); });
      } catch { /* QR server optional */ }
    });

    client.on('ready', () => {
      retryCount = 0;
      log.info('connected');
    });

    client.on('auth_failure', (msg: string) => {
      log.error({ msg }, 'auth failure — delete session and re-pair');
    });

    client.on('disconnected', (reason: string) => {
      log.warn({ reason }, 'disconnected');
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        const delay = Math.min(5000 * retryCount, 30_000); // exponential backoff up to 30s
        log.info({ retryCount, maxRetries: MAX_RETRIES, delayMs: delay }, 'reconnecting');
        setTimeout(async () => {
          try { await client?.destroy(); } catch { /* ignore */ }
          clearChromeLocks();
          connect();
        }, delay);
      } else {
        log.error('max retries reached — WhatsApp disabled');
      }
    });

    client.on('message_create', async (msg) => {
      try {
        // Skip group messages and status updates
        if (msg.from.endsWith('@g.us') || msg.from === 'status@broadcast') return;

        log.debug({ from: msg.from, fromMe: msg.fromMe, body: msg.body?.slice(0, 50) }, 'WA message received');

        // Skip own messages (sent from this device / bot replies)
        if (msg.fromMe) return;

        const rawId = numberFromId(msg.from);

        // Resolve LID to phone number via contact
        let senderId = lidToPhone.get(rawId) || rawId;
        if (msg.from.endsWith('@lid') && !lidToPhone.has(rawId)) {
          try {
            const contact = await msg.getContact();
            const phone = contact.number; // phone number without +
            if (phone) {
              lidToPhone.set(rawId, phone);
              senderId = phone;
              log.info({ lid: rawId, phone }, 'resolved LID to phone');
            }
          } catch { /* fallback to rawId */ }
        }

        // Security: allowed numbers OR registered leads from voice agent
        const isAllowed = config.allowedWhatsApp.length === 0 || config.allowedWhatsApp.includes(senderId);
        let isLead = false;
        if (!isAllowed) {
          try {
            const lead = db.prepare('SELECT phone FROM leads WHERE phone = ?').get(senderId) as any;
            isLead = !!lead;
          } catch { /* DB error — treat as not a lead */ }
        }
        if (!isAllowed && !isLead) {
          log.debug({ senderId }, 'blocked — not in allowed list and not a registered lead');
          return;
        }

        if (!messageHandler) return;

        let text = msg.body || '';
        let image: string | undefined;
        let imageMediaType: UnifiedMessage['imageMediaType'] | undefined;
        let document: string | undefined;
        let documentName: string | undefined;
        let isVoice = false;

        // Handle media messages
        if (msg.hasMedia) {
          const media = await msg.downloadMedia();
          if (media) {
            if (media.mimetype.startsWith('image/')) {
              image = media.data; // base64
              imageMediaType = media.mimetype as UnifiedMessage['imageMediaType'];
            } else if (media.mimetype === 'application/pdf' || media.mimetype.startsWith('application/')) {
              document = media.data;
              documentName = media.filename || 'document';
            } else if (media.mimetype.startsWith('audio/') && msg.type === 'ptt') {
              isVoice = true;
              // Transcribe voice message with Groq Whisper STT
              if (config.groqApiKey) {
                try {
                  const audioBuffer = Buffer.from(media.data, 'base64');
                  const formData = new FormData();
                  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
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
                      log.info({ text: text.slice(0, 80) }, 'WA voice transcribed');
                    }
                  } else {
                    log.warn({ status: sttRes.status }, 'WA voice STT failed');
                  }
                } catch (sttErr: any) {
                  log.error({ err: sttErr.message }, 'WA voice STT error');
                }
              }
            }
          }
        }

        // If it's a voice message with no text, set a placeholder
        if (isVoice && !text) {
          text = '[הודעה קולית — לא הצלחתי לתמלל]';
        }

        // Skip if no content at all
        if (!text && !image && !document) return;

        const contact = await msg.getContact();
        const unified: UnifiedMessage = {
          id: msg.id._serialized,
          channel: 'whatsapp',
          senderId,
          senderName: contact.pushname || contact.name || senderId,
          text,
          timestamp: msg.timestamp * 1000,
          image,
          imageMediaType,
          document,
          documentName,
          isVoice,
          raw: msg,
        };

        messageHandler(unified);
      } catch (err: any) {
        log.error({ err: err.message }, 'error processing message');
      }
    });

    // Clear stale Chrome locks before launching (prevents "browser already running" after crash)
    clearChromeLocks();

    log.info('initializing (Puppeteer loading)...');
    // Timeout: if Puppeteer hangs for 60s, kill and retry
    const initTimeout = setTimeout(() => {
      log.warn('initialize timed out after 60s — destroying client');
      client?.destroy().catch(() => {});
    }, 60_000);
    try {
      await client.initialize();
    } finally {
      clearTimeout(initTimeout);
    }
  }

  return {
    name: 'whatsapp',

    async start() {
      log.info('starting');
      await connect();
    },

    async stop() {
      try { await client?.destroy(); } catch { /* ignore */ }
      clearChromeLocks();
    },

    async sendReply(original: UnifiedMessage, reply: UnifiedReply) {
      if (!client) return;
      // Use the original raw message's chat ID to reply (preserves LID/@c.us format)
      const rawMsg = original.raw as any;
      const chatId = rawMsg?.from || `${original.senderId}@c.us`;

      if (reply.voice) {
        const media = new MessageMedia('audio/ogg; codecs=opus', reply.voice.toString('base64'));
        await client.sendMessage(chatId, media, { sendAudioAsVoice: true });
      }

      if (reply.document) {
        const mime = reply.documentMimetype || 'text/html';
        const filename = reply.documentName || 'file';
        const media = new MessageMedia(mime, reply.document.toString('base64'), filename);
        await client.sendMessage(chatId, media, { sendMediaAsDocument: true, caption: reply.text || '' });
      } else if (reply.image) {
        const media = new MessageMedia('image/png', reply.image.toString('base64'));
        await client.sendMessage(chatId, media, { caption: reply.text || '' });
      } else if (reply.text) {
        await client.sendMessage(chatId, reply.text);
      }
    },

    onMessage(handler) {
      messageHandler = handler;
    },
  };
}
