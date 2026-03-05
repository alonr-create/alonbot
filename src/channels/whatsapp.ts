import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { config } from '../utils/config.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';
import { mkdirSync } from 'fs';
import qrcode from 'qrcode-terminal';

const SESSION_DIR = `${config.dataDir}/whatsapp-session`;

export function createWhatsAppAdapter(): ChannelAdapter {
  let sock: ReturnType<typeof makeWASocket> | null = null;
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;

  function jidToNumber(jid: string): string {
    return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@g\.us$/, '');
  }

  async function connect() {
    mkdirSync(SESSION_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WhatsApp] Scan QR code:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (reason !== DisconnectReason.loggedOut) {
          console.log('[WhatsApp] Reconnecting...');
          setTimeout(connect, 3000);
        } else {
          console.log('[WhatsApp] Logged out. Delete session and restart.');
        }
      }

      if (connection === 'open') {
        console.log('[WhatsApp] Connected!');
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
      console.log('[WhatsApp] Starting...');
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
