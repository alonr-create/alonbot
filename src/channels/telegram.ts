import { Bot, InputFile } from 'grammy';
import { config } from '../utils/config.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';

export function createTelegramAdapter(): ChannelAdapter {
  const bot = new Bot(config.telegramBotToken);
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;

  bot.on('message:text', async (ctx) => {
    const senderId = String(ctx.from.id);

    // Security: only allowed users
    if (config.allowedTelegram.length > 0 && !config.allowedTelegram.includes(senderId)) {
      await ctx.reply('Unauthorized.');
      return;
    }

    if (!messageHandler) return;

    const unified: UnifiedMessage = {
      id: String(ctx.message.message_id),
      channel: 'telegram',
      senderId,
      senderName: ctx.from.first_name || 'Unknown',
      text: ctx.message.text,
      timestamp: ctx.message.date * 1000,
      raw: ctx,
    };

    messageHandler(unified);
  });

  return {
    name: 'telegram',

    async start() {
      if (!config.telegramBotToken) {
        console.log('[Telegram] No bot token — skipping');
        return;
      }
      console.log('[Telegram] Starting bot...');
      bot.start();
      console.log('[Telegram] Bot running');
    },

    async stop() {
      await bot.stop();
    },

    async sendReply(original: UnifiedMessage, reply: UnifiedReply) {
      const ctx = original.raw as any;
      if (reply.image) {
        await ctx.replyWithPhoto(new InputFile(reply.image));
      }
      if (reply.text) {
        // Split long messages (Telegram limit: 4096 chars)
        const chunks = reply.text.match(/[\s\S]{1,4000}/g) || [reply.text];
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      }
    },

    onMessage(handler) {
      messageHandler = handler;
    },
  };
}
