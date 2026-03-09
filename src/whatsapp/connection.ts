import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import { mkdirSync, rmSync } from 'fs';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { setQR, clearQR, setConnectionStatus, getConnectionStatus } from './qr.js';
import { setupMessageHandler } from './message-handler.js';
import { notifyAlon } from '../notifications/telegram.js';
import { notifyAlonWhatsApp } from '../notifications/whatsapp-notify.js';

import type { ConnectionState } from '@whiskeysockets/baileys';

const log = createLogger('whatsapp');

let sock: ReturnType<typeof makeWASocket> | null = null;
let retryCount = 0;
const MAX_RETRIES = 10;
let hasConnectedOnce = false;

/**
 * Connect to WhatsApp via Baileys.
 * Shows QR in terminal, generates data URL for web page, persists session,
 * auto-reconnects with exponential backoff on transient disconnects.
 */
export async function connectWhatsApp(): Promise<ReturnType<typeof makeWASocket>> {
  // Ensure session directory exists
  mkdirSync(config.sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['AlonDev Sales', 'Chrome', '22.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        setQR(dataUrl);
        setConnectionStatus('connecting');
        log.info('QR code generated -- scan with WhatsApp');
      } catch (err) {
        log.error({ err }, 'failed to generate QR data URL');
      }
    }

    if (connection === 'open') {
      clearQR();
      setConnectionStatus('connected');
      retryCount = 0;

      if (hasConnectedOnce) {
        log.info('reconnected to WhatsApp');
        await notifyAlon('<b>WhatsApp reconnected</b> successfully');
      } else {
        log.info('connected to WhatsApp');
        hasConnectedOnce = true;
      }
    }

    if (connection === 'close') {
      setConnectionStatus('disconnected');
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        log.warn('session logged out -- clearing session and re-showing QR');

        // Delete session directory
        try {
          rmSync(config.sessionDir, { recursive: true, force: true });
        } catch (err) {
          log.error({ err }, 'failed to delete session directory');
        }

        // Notify Alon on both channels
        await notifyAlon(
          '<b>WhatsApp session logged out</b> -- QR re-scan needed at /qr'
        );
        if (sock) {
          await notifyAlonWhatsApp(
            sock,
            'WhatsApp session logged out -- QR re-scan needed'
          );
        }

        // Reconnect to show new QR
        hasConnectedOnce = false;
        retryCount = 0;
        setTimeout(() => {
          connectWhatsApp().catch((err) =>
            log.error({ err }, 'reconnect after logout failed')
          );
        }, 2000);
      } else if (retryCount < MAX_RETRIES) {
        const delay = Math.min(5000 * Math.pow(2, retryCount), 60000);
        retryCount++;
        log.info(
          { retryCount, maxRetries: MAX_RETRIES, delay },
          'reconnecting with exponential backoff'
        );
        setTimeout(() => {
          connectWhatsApp().catch((err) =>
            log.error({ err }, 'reconnect failed')
          );
        }, delay);
      } else {
        log.error('max retries reached -- manual intervention needed');
        await notifyAlon(
          '<b>WhatsApp reconnection failed</b> after 10 attempts -- manual intervention needed'
        );
      }
    }
  });

  // Set up incoming message handler
  setupMessageHandler(sock);

  return sock;
}

/**
 * Get the current WhatsApp socket instance.
 */
export function getSocket(): ReturnType<typeof makeWASocket> | null {
  return sock;
}

export { getConnectionStatus } from './qr.js';
