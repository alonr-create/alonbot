import { createLogger } from '../utils/logger.js';
import { config } from '../config.js';

const log = createLogger('whatsapp-notify');

/**
 * Send a notification to Alon's personal WhatsApp number.
 * Used as backup channel when Telegram may not be available.
 * Never throws -- notifications must not crash the bot.
 */
export async function notifyAlonWhatsApp(
  sock: any,
  message: string
): Promise<void> {
  if (!config.alonPhone) {
    log.warn('ALON_PHONE not configured, skipping WhatsApp notification');
    return;
  }

  const jid = `${config.alonPhone}@s.whatsapp.net`;

  try {
    await sock.sendMessage(jid, { text: message });
    log.debug('whatsapp notification sent to Alon');
  } catch (err) {
    log.error({ err }, 'whatsapp notification failed');
    // Never throw -- notifications are best-effort
  }
}
