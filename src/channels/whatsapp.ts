import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';
import { mkdirSync, existsSync } from 'fs';

const log = createLogger('whatsapp');

const SESSION_DIR = `${config.dataDir}/whatsapp-session`;
const MAX_RETRIES = 3;
const PHONE_NUMBER = config.allowedWhatsApp[0]; // Use first allowed number for pairing

export function createWhatsAppAdapter(): ChannelAdapter {
  let sock: ReturnType<typeof makeWASocket> | null = null;
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;
  let retryCount = 0;

  function jidToNumber(jid: string): string {
    return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  }

  function hasSession(): boolean {
    return existsSync(`${SESSION_DIR}/creds.json`);
  }

  async function connect() {
    mkdirSync(SESSION_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['AlonBot', 'Chrome', '22.0'],
    });

    // If not registered yet, request pairing code
    if (!hasSession() && PHONE_NUMBER) {
      setTimeout(async () => {
        try {
          const code = await sock!.requestPairingCode(PHONE_NUMBER);
          log.info({ code }, 'pairing code — open WhatsApp > Linked Devices > Link with phone number');
        } catch (err: any) {
          log.warn({ err: err.message }, 'pairing code request failed');
        }
      }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.info('QR code received (use pairing code instead)');
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          log.warn('logged out — delete session and restart');
        } else if (retryCount < MAX_RETRIES) {
          retryCount++;
          log.info({ retryCount, maxRetries: MAX_RETRIES }, 'reconnecting');
          setTimeout(connect, 5000);
        } else {
          log.error('max retries reached — WhatsApp disabled');
        }
      }

      if (connection === 'open') {
        retryCount = 0;
        log.info('connected');
      }
    });

    sock.ev.on('messages.upsert', ({ messages: msgs, type }) => {
      if (type !== 'notify') return;

      for (const msg of msgs) {
        if (!msg.message || msg.key.fromMe) continue;

        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || '';

        if (!text) continue;

        const senderId = jidToNumber(msg.key.remoteJid || '');

        // Security: only allowed numbers
        if (config.allowedWhatsApp.length > 0 && !config.allowedWhatsApp.includes(senderId)) {
          continue;
        }

        if (!messageHandler) continue;

        const unified: UnifiedMessage = {
          id: msg.key.id || '',
          channel: 'whatsapp',
          senderId,
          senderName: msg.pushName || senderId,
          text,
          timestamp: (msg.messageTimestamp as number) * 1000,
          raw: msg,
        };

        messageHandler(unified);
      }
    });
  }

  return {
    name: 'whatsapp',

    async start() {
      log.info('starting');
      await connect();
    },

    async stop() {
      sock?.end(undefined);
    },

    async sendReply(original: UnifiedMessage, reply: UnifiedReply) {
      if (!sock) return;
      const jid = `${original.senderId}@s.whatsapp.net`;

      if (reply.text) {
        await sock.sendMessage(jid, { text: reply.text });
      }
      if (reply.image) {
        await sock.sendMessage(jid, { image: reply.image });
      }
    },

    onMessage(handler) {
      messageHandler = handler;
    },
  };
}
