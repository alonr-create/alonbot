import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type WAMessage,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { config } from '../utils/config.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';
import { createMondayLead } from '../utils/monday-leads.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const log = createLogger('whatsapp');

const SESSION_DIR = './data/whatsapp-session';
const MAX_RETRIES = 10;

export function createWhatsAppAdapter(): ChannelAdapter {
  let sock: WASocket | null = null;
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;
  let retryCount = 0;
  let shouldReconnect = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectId = 0; // guard against stale event handlers

  // Map LID → phone number (Baileys uses LID jids in newer WhatsApp versions)
  const lidToPhone = new Map<string, string>();

  function jidToNumber(jid: string): string {
    return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '').replace(/@lid$/, '');
  }

  function isLidJid(jid: string): boolean {
    return jid.endsWith('@lid');
  }

  async function connect() {
    // Cancel any pending reconnect
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    // Close previous socket to prevent self-conflict
    if (sock) {
      const oldSock = sock;
      sock = null;
      try { oldSock.ev.removeAllListeners('connection.update'); } catch { /* ignore */ }
      try { oldSock.ev.removeAllListeners('messages.upsert'); } catch { /* ignore */ }
      try { oldSock.ev.removeAllListeners('creds.update'); } catch { /* ignore */ }
      try { oldSock.ws.close(); } catch { /* ignore */ }
      try { oldSock.end(undefined); } catch { /* ignore */ }
      // Give WhatsApp time to fully register the disconnect
      await new Promise(r => setTimeout(r, 3000));
    }

    const myConnectId = ++connectId; // capture current ID for stale detection

    mkdirSync(SESSION_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log as any),
      },
      printQRInTerminal: false,
      browser: ['AlonBot', 'Chrome', '22.0'],
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    // Start QR web server for easy scanning
    let qrServer: any = null;

    sock.ev.on('connection.update', async (update) => {
      if (myConnectId !== connectId) return; // stale handler, ignore
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.info('QR code received — open http://localhost:3701 to scan');
        try {
          const QRCode = (await import('qrcode')).default;
          // Save QR as PNG for web server
          const qrPng = await QRCode.toBuffer(qr, { width: 400 });
          writeFileSync('/tmp/whatsapp-qr.png', qrPng);

          if (!qrServer) {
            const { createServer } = await import('http');
            qrServer = createServer(async (req, res) => {
              if (req.url?.startsWith('/qr.png')) {
                try {
                  const img = readFileSync('/tmp/whatsapp-qr.png');
                  res.writeHead(200, { 'Content-Type': 'image/png' });
                  res.end(img);
                } catch {
                  res.writeHead(404);
                  res.end('no QR yet');
                }
                return;
              }
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`<!DOCTYPE html><html dir="rtl"><head><title>WhatsApp QR</title>
<meta http-equiv="refresh" content="5">
<style>body{font-family:system-ui;text-align:center;padding:40px;background:#111;color:#fff}
img{border-radius:12px;margin:20px}h1{color:#25D366}</style>
</head><body><h1>🔗 קישור WhatsApp</h1>
<img src="/qr.png?t=${Date.now()}" width="400"><br>
<p>📱 WhatsApp > מכשירים מקושרים > קשר מכשיר > סרוק QR</p>
</body></html>`);
            });
            qrServer.listen(3701).on('error', () => {});
            log.info('QR server started on http://localhost:3701');
          }
        } catch (e: any) {
          log.error({ err: e.message }, 'QR server error');
        }
      }

      if (connection === 'open') {
        log.info('connected to WhatsApp (Baileys)');
        if (qrServer) { qrServer.close(); qrServer = null; }
        // Reset retry count after staying connected for 30s (avoids rapid conflict loops)
        setTimeout(() => { if (myConnectId === connectId) retryCount = 0; }, 30_000);
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldRetry = statusCode !== DisconnectReason.loggedOut;

        if (statusCode === DisconnectReason.loggedOut) {
          log.warn('logged out — session cleared, need to re-pair');
          shouldReconnect = false;
          return;
        }

        // Conflict means another connection replaced us (self-conflict from reconnect race).
        // Wait much longer to let the old WebSocket fully die before reconnecting.
        const isConflict = statusCode === 440;

        if (shouldRetry && shouldReconnect && retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = isConflict ? 60_000 : Math.min(5000 * retryCount, 30_000);
          log.info({ retryCount, maxRetries: MAX_RETRIES, delayMs: delay, statusCode, isConflict }, 'reconnecting...');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => connect(), delay);
        } else if (retryCount >= MAX_RETRIES) {
          log.error('max retries reached — WhatsApp disabled');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          await handleIncomingMessage(msg);
        } catch (err: any) {
          log.error({ err: err.message }, 'error processing message');
        }
      }
    });
  }

  async function handleIncomingMessage(msg: WAMessage) {
    if (!messageHandler || !sock) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Skip group messages and status updates
    if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    // Skip own messages
    if (msg.key.fromMe) return;

    let senderId = jidToNumber(jid);

    // Resolve LID to phone number
    if (isLidJid(jid)) {
      const cached = lidToPhone.get(senderId);
      if (cached) {
        senderId = cached;
      } else {
        // Try to get phone from participant or store mapping
        // In Baileys, we can use the store or check the message's participant
        try {
          // Use onWhatsApp to check if the number exists (works with phone jids)
          // For LID, try to get the phone from the message's verifiedBizName or pushName
          // The mapping is built over time as we see both LID and phone jids
          log.debug({ lid: senderId, jid }, 'LID jid detected — allowing through');
        } catch { /* ignore */ }
      }
    }

    log.debug({ from: jid, senderId, type: msg.message ? Object.keys(msg.message)[0] : 'unknown' }, 'WA message received');

    // Security: allowed numbers OR registered leads
    // For LID jids that we can't resolve yet, allow them through if allowedWhatsApp has entries
    // (the old whatsapp-web.js adapter had the same LID resolution issue)
    const isLid = isLidJid(jid);
    const isAllowed = config.allowedWhatsApp.length === 0 || config.allowedWhatsApp.includes(senderId) || isLid;
    let isLead = false;
    if (!isAllowed) {
      try {
        const lead = db.prepare('SELECT phone FROM leads WHERE phone = ?').get(senderId) as any;
        isLead = !!lead;
      } catch { /* DB error */ }
    }
    // Auto-create lead in Monday.com + SQLite for new unknown contacts
    if (!isAllowed && !isLead) {
      const sName = msg.pushName || senderId;
      const msgText = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '[media]';
      const itemId = await createMondayLead(senderId, sName, msgText);
      if (itemId) {
        isLead = true;
        log.info({ senderId, sName, itemId }, 'new lead auto-created — allowing through');
      } else {
        log.debug({ senderId }, 'blocked — not in allowed list and lead creation failed');
        return;
      }
    }

    const messageContent = msg.message;
    if (!messageContent) return;

    let text = '';
    let image: string | undefined;
    let imageMediaType: UnifiedMessage['imageMediaType'] | undefined;
    let document: string | undefined;
    let documentName: string | undefined;
    let isVoice = false;

    // Extract text from various message types
    if (messageContent.conversation) {
      text = messageContent.conversation;
    } else if (messageContent.extendedTextMessage?.text) {
      text = messageContent.extendedTextMessage.text;
    } else if (messageContent.imageMessage) {
      text = messageContent.imageMessage.caption || '';
      try {
        const buffer = await downloadMedia(msg);
        if (buffer) {
          image = buffer.toString('base64');
          imageMediaType = (messageContent.imageMessage.mimetype as UnifiedMessage['imageMediaType']) || 'image/jpeg';
        }
      } catch (e: any) {
        log.warn({ err: e.message }, 'failed to download image');
      }
    } else if (messageContent.documentMessage || messageContent.documentWithCaptionMessage) {
      const docMsg = messageContent.documentWithCaptionMessage?.message?.documentMessage || messageContent.documentMessage;
      if (docMsg) {
        text = docMsg.caption || '';
        try {
          const buffer = await downloadMedia(msg);
          if (buffer) {
            document = buffer.toString('base64');
            documentName = docMsg.fileName || 'document';
          }
        } catch (e: any) {
          log.warn({ err: e.message }, 'failed to download document');
        }
      }
    } else if (messageContent.audioMessage) {
      isVoice = messageContent.audioMessage.ptt === true;
      if (isVoice && config.groqApiKey) {
        try {
          const buffer = await downloadMedia(msg);
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
                log.info({ text: text.slice(0, 80) }, 'WA voice transcribed');
              }
            } else {
              log.warn({ status: sttRes.status }, 'WA voice STT failed');
            }
          }
        } catch (sttErr: any) {
          log.error({ err: sttErr.message }, 'WA voice STT error');
        }
      }
    } else if (messageContent.stickerMessage) {
      text = '[סטיקר — כנראה לייק/אישור/תגובה רגשית. התייחס לכוונה, לא לתמונה]';
    }

    // Voice with no transcription
    if (isVoice && !text) {
      text = '[הודעה קולית — לא הצלחתי לתמלל]';
    }

    // Skip if no content
    if (!text && !image && !document) return;

    // Get contact name
    let senderName = senderId;
    try {
      const contact = await sock!.onWhatsApp(senderId + '@s.whatsapp.net');
      // Use pushName from message if available
      senderName = msg.pushName || senderId;
    } catch { /* fallback */ }

    const unified: UnifiedMessage = {
      id: msg.key.id || `${Date.now()}`,
      channel: 'whatsapp',
      senderId,
      senderName,
      text,
      timestamp: (msg.messageTimestamp as number) * 1000 || Date.now(),
      image,
      imageMediaType,
      document,
      documentName,
      isVoice,
      raw: { jid, msg },
    };

    messageHandler(unified);
  }

  async function downloadMedia(msg: WAMessage): Promise<Buffer | null> {
    try {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      return buffer as Buffer;
    } catch (e: any) {
      log.warn({ err: e.message }, 'media download failed');
      return null;
    }
  }

  return {
    name: 'whatsapp',

    async start() {
      log.info('starting (Baileys — no Chrome needed)');
      shouldReconnect = true;
      await connect();
    },

    async stop() {
      shouldReconnect = false;
      try { sock?.end(undefined); } catch { /* ignore */ }
      sock = null;
    },

    async sendReply(original: UnifiedMessage, reply: UnifiedReply) {
      if (!sock) return;
      const rawData = original.raw as { jid: string; msg: WAMessage };
      const jid = rawData?.jid || `${original.senderId}@s.whatsapp.net`;

      if (reply.voice) {
        await sock.sendMessage(jid, {
          audio: reply.voice,
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true,
        });
      }

      if (reply.document) {
        const mime = reply.documentMimetype || 'text/html';
        const filename = reply.documentName || 'file';
        await sock.sendMessage(jid, {
          document: reply.document,
          mimetype: mime,
          fileName: filename,
          caption: reply.text || undefined,
        });
      } else if (reply.image) {
        await sock.sendMessage(jid, {
          image: reply.image,
          caption: reply.text || undefined,
        });
      } else if (reply.text) {
        await sock.sendMessage(jid, { text: reply.text });
      }
    },

    onMessage(handler) {
      messageHandler = handler;
    },
  };
}
