import { Bot, InputFile, InlineKeyboard } from 'grammy';
import { config } from '../utils/config.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';

export function createTelegramAdapter(): ChannelAdapter {
  const bot = new Bot(config.telegramBotToken);
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;

  function isAllowed(senderId: string): boolean {
    if (config.allowedTelegram.length === 0) return false;
    return config.allowedTelegram.includes(senderId);
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

    const text = ctx.message.text;

    // Auto-detect bare URL messages → ask to summarize
    const urlOnly = text.match(/^(https?:\/\/\S+)$/);
    if (urlOnly) {
      messageHandler(makeUnified(ctx, `סכם את התוכן של הדף הזה: ${urlOnly[1]}`));
      return;
    }

    messageHandler(makeUnified(ctx, text));
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

      // Detect media type from file extension (Telegram compresses to JPEG)
      const ext = file.file_path?.split('.').pop()?.toLowerCase();
      const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

      messageHandler(makeUnified(ctx, ctx.message.caption || 'מה יש בתמונה?', {
        image: buf.toString('base64'),
        imageMediaType: mediaType,
      }));
    } catch (err: any) {
      console.error('[Telegram] Photo error:', err.message);
    }
  });

  // Handle document messages (PDF, text files, etc)
  bot.on('message:document', async (ctx) => {
    if (!isAllowed(String(ctx.from.id)) || !messageHandler) return;

    try {
      const doc = ctx.message.document;
      const fileName = doc.file_name || 'document';
      const mimeType = doc.mime_type || '';

      // Only handle text-based documents
      const textTypes = ['application/pdf', 'text/', 'application/json', 'application/xml', 'application/csv'];
      if (!textTypes.some(t => mimeType.startsWith(t)) && !fileName.match(/\.(txt|md|json|csv|xml|html|js|ts|py|sh)$/i)) {
        messageHandler(makeUnified(ctx, `[קובץ: ${fileName} (${mimeType}) — לא נתמך לניתוח]`));
        return;
      }

      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
      const res = await fetch(fileUrl);

      if (mimeType === 'application/pdf') {
        // Send PDF as base64 document to Claude API
        const buf = Buffer.from(await res.arrayBuffer());
        messageHandler(makeUnified(ctx, ctx.message.caption || 'נתח את המסמך הזה', {
          document: buf.toString('base64'),
          documentName: fileName,
        }));
      } else {
        // Text files — read content directly
        const text = await res.text();
        const truncated = text.slice(0, 6000);
        messageHandler(makeUnified(ctx, `${ctx.message.caption || 'נתח את הקובץ'}\n\n--- ${fileName} ---\n${truncated}`));
      }
    } catch (err: any) {
      console.error('[Telegram] Document error:', err.message);
    }
  });

  // Handle /export command — export chat history as file
  bot.command('export', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id))) return;

    try {
      const { db } = await import('../utils/db.js');
      const rows = db.prepare(
        `SELECT sender_name, role, content, created_at FROM messages
         WHERE channel = 'telegram' AND sender_id = ?
         ORDER BY id ASC`
      ).all(String(ctx.from.id)) as any[];

      if (rows.length === 0) {
        await ctx.reply('אין היסטוריית שיחות.');
        return;
      }

      const lines = rows.map((r: any) =>
        `[${r.created_at}] ${r.role === 'user' ? r.sender_name : 'AlonBot'}: ${r.content}`
      );
      const text = lines.join('\n\n');
      const buf = Buffer.from(text, 'utf-8');

      await ctx.replyWithDocument(new InputFile(buf, `chat-export-${new Date().toISOString().slice(0, 10)}.txt`), {
        caption: `היסטוריית שיחה — ${rows.length} הודעות`,
      });
    } catch (err: any) {
      console.error('[Telegram] Export error:', err.message);
      await ctx.reply('שגיאה בייצוא.');
    }
  });

  // --- Menu categories for inline keyboard ---
  const menuCategories: Record<string, { label: string; items: Array<{ label: string; action: string }> }> = {
    info: {
      label: '🔍 מידע ואינטרנט',
      items: [
        { label: '📰 חדשות', action: 'מה החדשות היום בישראל?' },
        { label: '🌤 מזג אוויר', action: 'מה מזג האוויר בתל אביב?' },
        { label: '📅 תאריך עברי', action: 'מה התאריך העברי היום?' },
        { label: '🔎 חפש באינטרנט', action: 'חפש באינטרנט: ' },
      ],
    },
    system: {
      label: '🖥️ מערכת',
      items: [
        { label: '📸 צלם מסך', action: 'צלם מסך' },
        { label: '📊 סטטוס פרויקטים', action: 'מה הסטטוס של כל הפרויקטים?' },
        { label: '💰 עלויות API', action: 'הצג עלויות API' },
        { label: '🧠 מה אתה זוכר?', action: 'מה אתה זוכר עליי?' },
      ],
    },
    content: {
      label: '🎨 יצירת תוכן',
      items: [
        { label: '✍️ כתוב פוסט', action: 'כתוב פוסט שיווקי קצר על ' },
        { label: '📧 נסח מייל', action: 'נסח מייל מקצועי בנושא ' },
        { label: '💡 רעיונות תוכן', action: 'תן לי 5 רעיונות לתוכן עבור ' },
        { label: '📝 סכם טקסט', action: 'סכם את הטקסט הבא: ' },
      ],
    },
    memory: {
      label: '🧠 זיכרון ותזמון',
      items: [
        { label: '⏰ תזכורות', action: 'הצג תזכורות' },
        { label: '📋 סיכום יומי', action: 'תן לי סיכום יומי' },
        { label: '💭 על מה דיברנו?', action: 'על מה דיברנו לאחרונה?' },
        { label: '🔔 הגדר תזכורת', action: 'הגדר תזכורת ל' },
      ],
    },
    business: {
      label: '💼 עסקים — דקל',
      items: [
        { label: '📈 לידים חדשים', action: 'מה הלידים החדשים בדקל?' },
        { label: '📊 דוח יומי', action: 'הכן דוח יומי לדקל' },
        { label: '📋 משימות פתוחות', action: 'הצג משימות פתוחות' },
        { label: '📆 פגישות השבוע', action: 'מה הפגישות שלי השבוע?' },
      ],
    },
    tasks: {
      label: '✅ משימות',
      items: [
        { label: '📋 משימות פתוחות', action: 'הצג משימות פתוחות' },
        { label: '➕ הוסף משימה', action: 'הוסף משימה: ' },
        { label: '✅ סמן כבוצע', action: 'סמן משימה מספר ' },
        { label: '📊 סיכום שבועי', action: 'תן סיכום שבועי' },
      ],
    },
    projects: {
      label: '🛠 פרויקטים',
      items: [
        { label: '📂 קרא קובץ', action: 'קרא את הקובץ ' },
        { label: '📁 רשימת קבצים', action: 'הצג קבצים בתיקייה ' },
        { label: '🔧 הרץ פקודה', action: 'הרץ: ' },
      ],
    },
    knowledge: {
      label: '📚 בסיס ידע',
      items: [
        { label: '🌐 למד מ-URL', action: 'למד את התוכן מ-' },
        { label: '📖 רשימת מסמכים', action: 'הצג רשימת מסמכים בבסיס הידע' },
        { label: '🔍 חפש בידע', action: 'חפש בבסיס הידע: ' },
      ],
    },
    automations: {
      label: '⚡ אוטומציות',
      items: [
        { label: '📋 הצג אוטומציות', action: 'הצג אוטומציות פעילות' },
        { label: '➕ צור אוטומציה', action: 'צור אוטומציה חדשה: ' },
        { label: '📊 הצג cron jobs', action: 'הצג cron jobs פעילים' },
      ],
    },
  };

  // Handle /menu command — show category buttons
  bot.command('menu', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id))) return;

    const keyboard = new InlineKeyboard();
    const cats = Object.entries(menuCategories);
    for (let i = 0; i < cats.length; i++) {
      keyboard.text(cats[i][1].label, `cat:${cats[i][0]}`);
      if (i % 2 === 1) keyboard.row();
    }
    if (cats.length % 2 === 1) keyboard.row();

    await ctx.reply('בחר קטגוריה:', { reply_markup: keyboard });
  });

  // Handle /start command
  bot.command('start', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id))) return;
    await ctx.reply(
      'שלום! אני AlonBot — העוזר האישי שלך.\n\n' +
      'אפשר פשוט לכתוב לי בטקסט חופשי, או להשתמש בתפריט:\n' +
      '/menu — תפריט פעולות מהירות\n' +
      '/tasks — משימות פתוחות\n' +
      '/export — ייצוא היסטוריית שיחה\n\n' +
      'מה תרצה לעשות?'
    );
  });

  // Handle /tasks command — quick view of open tasks
  bot.command('tasks', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id)) || !messageHandler) return;
    messageHandler(makeUnified(ctx, 'הצג משימות פתוחות'));
  });

  // Handle inline button callbacks
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    // Category selection — show items in that category
    if (data.startsWith('cat:')) {
      const catKey = data.slice(4);
      const cat = menuCategories[catKey];
      if (!cat) return;

      const keyboard = new InlineKeyboard();
      for (let i = 0; i < cat.items.length; i++) {
        keyboard.text(cat.items[i].label, `action:${cat.items[i].action}`);
        if (i % 2 === 1) keyboard.row();
      }
      if (cat.items.length % 2 === 1) keyboard.row();
      keyboard.text('◀️ חזור לתפריט', 'back:menu');

      await ctx.editMessageText(`${cat.label}:`, { reply_markup: keyboard });
      return;
    }

    // Back to main menu
    if (data === 'back:menu') {
      const keyboard = new InlineKeyboard();
      const cats = Object.entries(menuCategories);
      for (let i = 0; i < cats.length; i++) {
        keyboard.text(cats[i][1].label, `cat:${cats[i][0]}`);
        if (i % 2 === 1) keyboard.row();
      }
      if (cats.length % 2 === 1) keyboard.row();

      await ctx.editMessageText('בחר קטגוריה:', { reply_markup: keyboard });
      return;
    }

    // Action execution
    if (data.startsWith('action:')) {
      const actionText = data.slice('action:'.length);
      if (!messageHandler) return;

      // If action ends with space/colon, it needs user input — prompt them
      if (actionText.endsWith(' ') || actionText.endsWith(': ')) {
        await ctx.editMessageText(`כתוב את ההמשך:\n\`${actionText}...\``, { parse_mode: 'Markdown' });
        return;
      }

      const unified: UnifiedMessage = {
        id: String(ctx.callbackQuery.id),
        channel: 'telegram',
        senderId: String(ctx.from.id),
        senderName: ctx.from.first_name || 'Unknown',
        text: actionText,
        timestamp: Date.now(),
        raw: ctx,
      };

      messageHandler(unified);
    }
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
      messageHandler(makeUnified(ctx, transcription, { isVoice: true }));
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

      // Set bot commands (shows in Telegram's "/" menu)
      try {
        await bot.api.setMyCommands([
          { command: 'menu', description: 'תפריט פעולות מהירות' },
          { command: 'tasks', description: 'משימות פתוחות' },
          { command: 'export', description: 'ייצוא היסטוריית שיחה' },
          { command: 'start', description: 'התחל מחדש' },
        ]);
      } catch (e: any) {
        console.warn('[Telegram] Failed to set commands:', e.message);
      }

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

      // Direct send by chat ID (for cron messages where raw is null)
      if (!ctx?.reply) {
        const chatId = Number(original.senderId);
        if (!chatId) return;
        if (reply.text) {
          const chunks = reply.text.match(/[\s\S]{1,4000}/g) || [reply.text];
          for (const chunk of chunks) {
            try {
              await bot.api.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
            } catch {
              await bot.api.sendMessage(chatId, chunk);
            }
          }
        }
        return;
      }

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
          try {
            await ctx.reply(chunk, { parse_mode: 'Markdown' });
          } catch {
            // Fallback to plain text if Markdown parsing fails
            await ctx.reply(chunk);
          }
        }
      }
    },

    onMessage(handler) {
      messageHandler = handler;
    },
  };
}
