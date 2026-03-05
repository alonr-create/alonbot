import { Bot, InputFile, InlineKeyboard } from 'grammy';
import { config } from '../utils/config.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';

export function createTelegramAdapter(): ChannelAdapter {
  const bot = new Bot(config.telegramBotToken);
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;

  function isAllowed(senderId: string): boolean {
    return config.allowedTelegram.length === 0 || config.allowedTelegram.includes(senderId);
  }

  function makeUnified(ctx: any, text: string, extra?: Partial<UnifiedMessage>): UnifiedMessage {
    return {
      id: String(ctx.message.message_id),
      channel: 'telegram',
      senderId: String(ctx.from.id),
      senderName: ctx.from.first_name || 'Unknown',
      text,
      timestamp: ctx.message.date * 1000,
      raw: ctx,
      ...extra,
    };
  }

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    if (!isAllowed(String(ctx.from.id))) { await ctx.reply('Unauthorized.'); return; }
    if (!messageHandler) return;
    messageHandler(makeUnified(ctx, ctx.message.text));
  });

  // Handle photo messages (image understanding)
  bot.on('message:photo', async (ctx) => {
    if (!isAllowed(String(ctx.from.id)) || !messageHandler) return;

    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;

      const res = await fetch(fileUrl);
      const buf = Buffer.from(await res.arrayBuffer());

      messageHandler(makeUnified(ctx, ctx.message.caption || 'מה יש בתמונה?', {
        image: buf.toString('base64'),
      }));
    } catch (err: any) {
      console.error('[Telegram] Photo error:', err.message);
    }
  });

  // Handle /menu command — quick action buttons
  bot.command('menu', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id))) return;

    const keyboard = new InlineKeyboard()
      .text('צלם מסך', 'action:צלם מסך').text('סטטוס פרויקטים', 'action:מה הסטטוס של כל הפרויקטים?').row()
      .text('לידים חדשים', 'action:מה הלידים החדשים בדקל?').text('תזכורות', 'action:הצג תזכורות').row()
      .text('סיכום יומי', 'action:תן לי סיכום יומי').text('חדשות', 'action:מה החדשות היום בישראל?').row();

    await ctx.reply('מה תרצה לעשות?', { reply_markup: keyboard });
  });

  // Handle inline button callbacks
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('action:')) return;
    await ctx.answerCallbackQuery();

    const text = data.slice('action:'.length);
    if (!messageHandler) return;

    // Create a unified message from the callback
    const unified: UnifiedMessage = {
      id: String(ctx.callbackQuery.id),
      channel: 'telegram',
      senderId: String(ctx.from.id),
      senderName: ctx.from.first_name || 'Unknown',
      text,
      timestamp: Date.now(),
      raw: ctx,
    };

    messageHandler(unified);
  });

  // Handle voice messages (STT → text)
  bot.on('message:voice', async (ctx) => {
    if (!isAllowed(String(ctx.from.id)) || !messageHandler) return;

    try {
      const file = await ctx.api.getFile(ctx.message.voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;

      const audioRes = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      // Use Groq Whisper API for fast, free STT
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
      formData.append('model', 'whisper-large-v3');
      formData.append('language', 'he');

      const sttRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.groqApiKey}` },
        body: formData,
      });

      if (!sttRes.ok) {
        // Fallback: tell Claude we got a voice message we can't transcribe
        messageHandler(makeUnified(ctx, '[הודעה קולית — לא הצלחתי לתמלל. בקש מהמשתמש לכתוב בטקסט.]'));
        return;
      }

      const sttData = await sttRes.json() as { text: string };
      const transcription = sttData.text;

      console.log(`[Telegram] Voice transcribed: ${transcription.slice(0, 80)}`);
      messageHandler(makeUnified(ctx, transcription));
    } catch (err: any) {
      console.error('[Telegram] Voice error:', err.message);
    }
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

    async sendTyping(original: UnifiedMessage) {
      const ctx = original.raw as any;
      if (ctx?.replyWithChatAction) {
        await ctx.replyWithChatAction('typing');
      }
    },

    async sendReply(original: UnifiedMessage, reply: UnifiedReply) {
      const ctx = original.raw as any;
      if (!ctx?.reply) return;

      if (reply.voice) {
        try {
          await ctx.replyWithVoice(new InputFile(reply.voice, 'voice.ogg'));
        } catch (err: any) {
          console.error('[Telegram] Voice send error:', err.message);
        }
      }

      if (reply.image) {
        try {
          await ctx.replyWithPhoto(new InputFile(reply.image, 'image.png'));
        } catch (err: any) {
          console.error('[Telegram] Image send error:', err.message);
        }
      }

      if (reply.text) {
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
