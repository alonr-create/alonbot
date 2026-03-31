import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import QRCode from 'qrcode';
import { mkdirSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { setQR, clearQR, setConnectionStatus, setPairingCode } from './qr.js';
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

    async sendAudio(jid: string, audioBuffer: Buffer, ptt = true) {
      const phone = jid.split('@')[0];
      const chat = chatRegistry.get(phone);
      const media = new MessageMedia('audio/mpeg', audioBuffer.toString('base64'), 'voice.mp3');
      if (chat) {
        await chat.sendMessage(media, { sendAudioAsVoice: ptt });
      } else {
        const chatId = jid.includes('@c.us') ? jid : `${phone}@c.us`;
        await wwebClient.sendMessage(chatId, media, { sendAudioAsVoice: ptt });
      }
    },

    async sendImage(jid: string, imageBuffer: Buffer, caption?: string) {
      const phone = jid.split('@')[0];
      const chat = chatRegistry.get(phone);
      const media = new MessageMedia('image/png', imageBuffer.toString('base64'), 'screenshot.png');
      const options: Record<string, any> = {};
      if (caption) options.caption = caption;
      if (chat) {
        await chat.sendMessage(media, options);
      } else {
        const chatId = jid.includes('@c.us') ? jid : `${phone}@c.us`;
        await wwebClient.sendMessage(chatId, media, options);
      }
    },

    async sendDocument(jid: string, buffer: Buffer, filename: string, caption?: string) {
      const phone = jid.split('@')[0];
      const chat = chatRegistry.get(phone);
      const media = new MessageMedia('application/pdf', buffer.toString('base64'), filename);
      const options: Record<string, any> = { sendMediaAsDocument: true };
      if (caption) options.caption = caption;
      if (chat) {
        await chat.sendMessage(media, options);
      } else {
        const chatId = jid.includes('@c.us') ? jid : `${phone}@c.us`;
        await wwebClient.sendMessage(chatId, media, options);
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

/**
 * BotAdapter interface — the public contract used by conversation, schedulers, etc.
 * Implemented by whatsapp-web.js adapter (createAdapter) and CloudBotAdapter.
 */
export interface BotAdapter {
  sendMessage(jid: string, content: { text: string }): Promise<void>;
  sendPresenceUpdate(state: 'composing' | 'paused', jid: string): Promise<void>;
  sendAudio(jid: string, audioBuffer: Buffer, ptt?: boolean): Promise<void>;
  sendImage(jid: string, imageBuffer: Buffer, caption?: string): Promise<void>;
  sendDocument(jid: string, buffer: Buffer, filename: string, caption?: string): Promise<void>;
}

let adapter: BotAdapter | null = null;

function removeStaleLocks(dir: string): void {
  try {
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name === 'SingletonLock' || entry.name === 'SingletonSocket' || entry.name === 'SingletonCookie') {
          log.info({ file: full }, 'removing stale Chromium lock');
          rmSync(full, { force: true });
        }
      }
    };
    walk(dir);
  } catch (_) {
    // Session dir may not exist yet
  }
}

export async function connectWhatsApp(): Promise<BotAdapter> {
  mkdirSync(config.sessionDir, { recursive: true });

  // Remove stale Chromium lock files from previous container
  removeStaleLocks(config.sessionDir);

  const puppeteerArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--single-process'];
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;

  // Use pairing code (phone number) instead of QR if env WHATSAPP_PAIR=1
  const usePairing = process.env.WHATSAPP_PAIR === '1';

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionDir }),
    puppeteer: {
      headless: true,
      args: puppeteerArgs,
      ...(execPath ? { executablePath: execPath } : {}),
    },
    ...(usePairing ? { pairWithPhoneNumber: { phoneNumber: config.alonPhone, showNotification: true } } : {}),
  } as any);

  // Pairing code event (when using phone number pairing)
  client.on('code' as any, (code: string) => {
    setPairingCode(code);
    setConnectionStatus('connecting');
    log.info({ code }, 'pairing code received — enter in WhatsApp > Linked Devices > Link with phone number');
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
