import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode';
import { mkdirSync } from 'fs';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { setQR, clearQR, setConnectionStatus } from './qr.js';
import { setupMessageHandler } from './message-handler.js';
import { notifyAlon } from '../notifications/telegram.js';

const log = createLogger('whatsapp');

let client: InstanceType<typeof Client> | null = null;
let hasConnectedOnce = false;

// Chat registry: phone number -> wweb.js chat object
// Populated when messages arrive so we can reply via the correct chat object
const chatRegistry = new Map<string, any>();

export function registerChat(phone: string, chat: any): void {
  chatRegistry.set(phone, chat);
}

/**
 * Adapter: wraps whatsapp-web.js Client with a Baileys-compatible interface.
 * Uses chat registry to send via chat.sendMessage() which handles LID format.
 */
function createAdapter(wwebClient: InstanceType<typeof Client>) {
  return {
    _wwebClient: wwebClient,

    async sendMessage(jid: string, content: { text: string }) {
      // Extract phone from jid (strip any @suffix)
      const phone = jid.split('@')[0];
      const chat = chatRegistry.get(phone);
      if (chat) {
        await chat.sendMessage(content.text);
      } else {
        // Fallback: try direct send with @c.us format
        const chatId = jid.includes('@c.us') ? jid : `${phone}@c.us`;
        await wwebClient.sendMessage(chatId, content.text);
      }
    },

    async sendPresenceUpdate(state: 'composing' | 'paused', jid: string) {
      try {
        const phone = jid.split('@')[0];
        const chat = chatRegistry.get(phone);
        if (chat) {
          if (state === 'composing') {
            await chat.sendStateTyping();
          } else {
            await chat.clearState();
          }
        }
      } catch (_) {
        // presence updates are best-effort
      }
    },
  };
}

export type BotAdapter = ReturnType<typeof createAdapter>;

let adapter: BotAdapter | null = null;

export async function connectWhatsApp(): Promise<BotAdapter> {
  mkdirSync(config.sessionDir, { recursive: true });

  const puppeteerArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'];
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionDir }),
    puppeteer: {
      headless: true,
      args: puppeteerArgs,
      ...(execPath ? { executablePath: execPath } : {}),
    },
  });

  client.on('qr', async (qr: string) => {
    try {
      const dataUrl = await QRCode.toDataURL(qr);
      setQR(dataUrl);
      setConnectionStatus('connecting');
      log.info('QR code ready — open http://localhost:3000/qr to scan');
    } catch (err) {
      log.error({ err }, 'failed to generate QR');
    }
  });

  client.on('ready', async () => {
    clearQR();
    setConnectionStatus('connected');
    log.info('connected to WhatsApp');

    if (hasConnectedOnce) {
      await notifyAlon('<b>WhatsApp reconnected</b> successfully');
    }
    hasConnectedOnce = true;
  });

  client.on('authenticated', () => {
    log.info('WhatsApp authenticated');
  });

  client.on('auth_failure', async (msg: string) => {
    log.error({ msg }, 'WhatsApp auth failure');
    setConnectionStatus('disconnected');
    await notifyAlon(`<b>WhatsApp auth failed</b>: ${msg}`);
  });

  client.on('disconnected', async (reason: string) => {
    log.warn({ reason }, 'WhatsApp disconnected — reconnecting in 5s');
    setConnectionStatus('disconnected');
    await notifyAlon(`<b>WhatsApp disconnected</b>: ${reason}`);
    setTimeout(
      () => connectWhatsApp().catch(err => log.error({ err }, 'reconnect failed')),
      5000
    );
  });

  adapter = createAdapter(client);
  setupMessageHandler(client, adapter);

  await client.initialize();

  return adapter;
}

export function getAdapter(): BotAdapter | null {
  return adapter;
}

export { getConnectionStatus } from './qr.js';
