import { Bot } from 'grammy';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('telegram');

let bot: Bot | null = null;

function getBot(): Bot | null {
  if (!config.telegramBotToken) {
    return null;
  }
  if (!bot) {
    bot = new Bot(config.telegramBotToken);
  }
  return bot;
}

/**
 * Send a notification message to Alon via Telegram.
 * Gracefully degrades if no token or chat ID is configured.
 * Never throws -- notifications must not crash the bot.
 */
export async function notifyAlon(message: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    log.warn('telegram not configured (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)');
    return;
  }

  const b = getBot();
  if (!b) return;

  try {
    await b.api.sendMessage(config.telegramChatId, message, {
      parse_mode: 'HTML',
    });
    log.debug('notification sent to Alon');
  } catch (err) {
    log.error({ err }, 'telegram notification failed');
    // Never throw -- notifications are best-effort
  }
}
