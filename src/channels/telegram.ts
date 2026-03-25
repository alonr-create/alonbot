import { Bot, InputFile, InlineKeyboard, webhookCallback } from 'grammy';
import { config } from '../utils/config.js';
import { withRetry } from '../utils/retry.js';
import type { ChannelAdapter, UnifiedMessage, UnifiedReply } from './types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('telegram');

export function createTelegramAdapter(): ChannelAdapter {
  const bot = new Bot(config.telegramBotToken);
  let messageHandler: ((msg: UnifiedMessage) => void) | null = null;

  let botUsername = ''; // Set on start

  function isAllowed(senderId: string): boolean {
    if (config.allowedTelegram.length === 0) return false;
    return config.allowedTelegram.includes(senderId);
  }

  function isGroupChat(ctx: any): boolean {
    return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  }

  function isMentioned(ctx: any): boolean {
    const text = ctx.message?.text || ctx.message?.caption || '';
    if (botUsername && text.includes(`@${botUsername}`)) return true;
    // Also respond to replies to bot's messages
    if (ctx.message?.reply_to_message?.from?.is_bot) return true;
    return false;
  }

  function stripMention(text: string): string {
    if (!botUsername) return text;
    return text.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '').trim();
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

  // === COMMANDS (must be registered BEFORE bot.on('message:text') in grammY) ===

  // Handle /export command — export chat history as file
  bot.command('export', async (ctx) => {
    log.info('/export command triggered');
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
      log.error({ err: err.message }, 'export error');
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
    log.info('/menu command triggered');
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
      '/search — חיפוש בהיסטוריה\n' +
      '/dashboard — דאשבורד\n' +
      '/help — כל מה שאני יודע לעשות\n\n' +
      'מה תרצה לעשות?'
    );
  });

  // Handle /tasks command — quick view of open tasks
  bot.command('tasks', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id)) || !messageHandler) return;
    messageHandler(makeUnified(ctx, 'הצג משימות פתוחות'));
  });

  // Handle /help command — explain what the bot can do
  bot.command('help', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id))) return;
    await ctx.reply(
      '*AlonBot — מה אני יודע לעשות?*\n\n' +
      '*חיפוש ומידע:* חדשות, מזג אוויר, חיפוש באינטרנט, מחקר עמוק, סיכום דפי אינטרנט\n\n' +
      '*יצירת תוכן:* כתיבת פוסטים, מיילים, יצירת תמונות AI, הודעות קוליות\n\n' +
      '*זיכרון:* אני זוכר מה שמספרים לי, ומשתמש בזה בהמשך\n\n' +
      '*משימות:* ניהול רשימת מטלות עם עדיפות ותאריכי יעד\n\n' +
      '*תזכורות:* הגדרת תזכורות חוזרות או חד-פעמיות\n\n' +
      '*עסקים:* שליפת לידים ונתונים מ-Monday.com, שליחת מיילים\n\n' +
      '*קבצים:* קריאה, כתיבה, צילום מסך (כשהמחשב מחובר)\n\n' +
      '*בסיס ידע:* טעינת מסמכים/URLs/PDFs וחיפוש סמנטי בהם\n\n' +
      '*אוטומציות:* יצירת תגובות אוטומטיות לפי מילות מפתח\n\n' +
      '*תמונות:* שליחת תמונה ואני מנתח מה יש בה (OCR, תיאור)\n\n' +
      '*קול:* שליחת הודעה קולית ואני מתמלל ועונה (גם בקול)\n\n' +
      '*סטיקרים:* שלח סטיקר ואני אגיב\n\n' +
      '*אודיו:* שלח קובץ MP3/M4A ואני מתמלל אותו\n\n' +
      '*קבוצות:* הוסף אותי לקבוצה ותייג @' + (botUsername || 'alonbot') + '\n\n' +
      '*פקודות:*\n' +
      '/menu — תפריט פעולות מהירות\n' +
      '/tasks — משימות פתוחות\n' +
      '/opus שאלה — שאלה ל-Claude Opus (מודל חזק יותר)\n' +
      '/summary — סיכום השיחה האחרונה\n' +
      '/search מילה — חיפוש בהיסטוריה\n' +
      '/backup — גיבוי מסד הנתונים\n' +
      '/export — ייצוא שיחה כקובץ\n' +
      '/dashboard — קישור לדאשבורד\n' +
      '/help — ההודעה הזאת',
      { parse_mode: 'Markdown' }
    );
  });

  // Handle /summary command — summarize recent conversation
  bot.command('summary', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id)) || !messageHandler) return;
    messageHandler(makeUnified(ctx, 'סכם את השיחה האחרונה שלנו ב-3-5 משפטים'));
  });

  // Handle /search command — search message history
  bot.command('search', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id))) return;
    const query = ctx.match?.trim();
    if (!query) {
      await ctx.reply('שימוש: /search מילת חיפוש\nדוגמה: /search דקל');
      return;
    }

    try {
      const { db } = await import('../utils/db.js');
      const rows = db.prepare(
        `SELECT sender_name, role, content, created_at FROM messages
         WHERE channel = 'telegram' AND sender_id = ? AND content LIKE ?
         ORDER BY id DESC LIMIT 10`
      ).all(String(ctx.from.id), `%${query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`) as any[];

      if (rows.length === 0) {
        await ctx.reply(`לא נמצאו תוצאות עבור "${query}"`);
        return;
      }

      const results = rows.map((r: any, i: number) => {
        const who = r.role === 'user' ? r.sender_name : 'Bot';
        const content = r.content.length > 150 ? r.content.slice(0, 150) + '...' : r.content;
        return `${i + 1}. [${r.created_at}] ${who}:\n${content}`;
      }).join('\n\n');

      await ctx.reply(`חיפוש: "${query}" — ${rows.length} תוצאות:\n\n${results}`);
    } catch (err: any) {
      log.error({ err: err.message }, 'search error');
      await ctx.reply('שגיאה בחיפוש.');
    }
  });

  // Handle /backup command — send DB backup file
  bot.command('backup', async (ctx) => {
    log.info('/backup command triggered');
    if (!ctx.from || !isAllowed(String(ctx.from.id))) return;

    try {
      const { db } = await import('../utils/db.js');
      const { config: cfg } = await import('../utils/config.js');
      // Use SQLite backup API via VACUUM INTO for a safe copy
      const backupPath = `/tmp/alonbot-backup-${Date.now()}.db`;
      db.exec(`VACUUM INTO '${backupPath}'`);
      const { readFileSync, unlinkSync } = await import('fs');
      const buf = readFileSync(backupPath);
      await ctx.replyWithDocument(
        new InputFile(buf, `alonbot-backup-${new Date().toISOString().slice(0, 10)}.db`),
        { caption: `גיבוי DB — ${(buf.length / 1024).toFixed(0)} KB` }
      );
      unlinkSync(backupPath);
    } catch (err: any) {
      log.error({ err: err.message }, 'backup error');
      await ctx.reply(`שגיאה בגיבוי: ${err.message}`);
    }
  });

  // Handle /opus command — send one question to Claude Opus
  bot.command('opus', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id)) || !messageHandler) return;
    const question = ctx.match?.trim();
    if (!question) {
      await ctx.reply('שימוש: /opus השאלה שלך\nדוגמה: /opus נתח את האסטרטגיה העסקית של דקל');
      return;
    }
    // Tag the message so agent.ts knows to use Opus
    messageHandler(makeUnified(ctx, `[OPUS] ${question}`));
  });

  // Handle /dashboard command — send link to dashboard
  bot.command('dashboard', async (ctx) => {
    if (!ctx.from || !isAllowed(String(ctx.from.id))) return;
    const keyboard = new InlineKeyboard()
      .webApp('Dashboard', `https://alonbot.onrender.com/dashboard?token=${config.localApiSecret}`)
      .row()
      .webApp('Chat', `https://alonbot.onrender.com/chat?token=${config.localApiSecret}`);
    await ctx.reply('פתח ממשק:', { reply_markup: keyboard });
  });

  // === MESSAGE HANDLERS (after commands, so commands take priority) ===

  // Handle text messages (commands should be caught above, this is for regular text)
  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) {
      log.warn({ command: ctx.message.text }, 'command fell through to text handler');
    }
    const senderId = String(ctx.from.id);

    // Group chats: only respond if @mentioned or replied to
    if (isGroupChat(ctx)) {
      if (!isAllowed(senderId)) return; // Silent in groups for unauthorized users
      if (!isMentioned(ctx)) return; // Ignore messages that don't mention the bot
      if (!messageHandler) return;
      const text = stripMention(ctx.message.text);
      if (!text) return;
      messageHandler(makeUnified(ctx, text));
      return;
    }

    // Private chats: existing behavior
    if (!isAllowed(senderId)) { await ctx.reply('Unauthorized.'); return; }
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
      log.error({ err: err.message }, 'photo error');
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
      log.error({ err: err.message }, 'document error');
    }
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

  // Handle sticker messages
  bot.on('message:sticker', async (ctx) => {
    if (!isAllowed(String(ctx.from.id)) || !messageHandler) return;

    const sticker = ctx.message.sticker;
    const emoji = sticker.emoji || '';
    const setName = sticker.set_name || 'unknown';
    messageHandler(makeUnified(ctx, `[סטיקר: ${emoji} מסט "${setName}"]`));
  });

  // Handle audio files (MP3, M4A, etc.) — transcribe with Whisper
  bot.on('message:audio', async (ctx) => {
    if (!isAllowed(String(ctx.from.id)) || !messageHandler) return;

    try {
      const audio = ctx.message.audio;
      const file = await ctx.api.getFile(audio.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;

      const audioRes = await fetch(fileUrl);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      // Detect mime type from file extension
      const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'mp3';
      const mimeMap: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' };
      const mimeType = mimeMap[ext] || 'audio/mpeg';

      // Transcribe with Groq Whisper
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${ext}`);
      formData.append('model', 'whisper-large-v3');
      formData.append('language', 'he');

      const sttRes = await withRetry(() => fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.groqApiKey}` },
        body: formData,
      }));

      if (!sttRes.ok) {
        messageHandler(makeUnified(ctx, `[קובץ אודיו: ${audio.file_name || 'audio'} (${audio.duration}s) — לא הצלחתי לתמלל]`));
        return;
      }

      const sttData = await sttRes.json() as { text: string };
      const caption = ctx.message.caption || '';
      const transcription = sttData.text;
      log.info({ text: transcription.slice(0, 80) }, 'audio transcribed');

      messageHandler(makeUnified(ctx, `${caption ? caption + '\n\n' : ''}[תמלול אודיו "${audio.file_name || 'audio'}":]:\n${transcription}`));
    } catch (err: any) {
      log.error({ err: err.message }, 'audio error');
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

      const sttRes = await withRetry(() => fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.groqApiKey}` },
        body: formData,
      }));

      if (!sttRes.ok) {
        // Fallback: tell Claude we got a voice message we can't transcribe
        messageHandler(makeUnified(ctx, '[הודעה קולית — לא הצלחתי לתמלל. בקש מהמשתמש לכתוב בטקסט.]'));
        return;
      }

      const sttData = await sttRes.json() as { text: string };
      const transcription = sttData.text;

      log.info({ text: transcription.slice(0, 80) }, 'voice transcribed');
      messageHandler(makeUnified(ctx, transcription, { isVoice: true }));
    } catch (err: any) {
      log.error({ err: err.message }, 'voice error');
    }
  });

  return {
    name: 'telegram',

    async start() {
      if (!config.telegramBotToken) {
        log.info('no bot token — skipping');
        return;
      }
      log.info('starting bot');

      // Get bot username for @mention detection in groups
      try {
        const me = await bot.api.getMe();
        botUsername = me.username || '';
        log.info({ username: botUsername }, 'bot username retrieved');
      } catch (e: any) {
        log.warn({ err: e.message }, 'could not get bot username');
      }

      // Set bot commands (shows in Telegram's "/" menu)
      try {
        await bot.api.setMyCommands([
          { command: 'menu', description: 'תפריט פעולות מהירות' },
          { command: 'monday', description: 'מאנדי — לידים, משימות, בורדים' },
          { command: 'ads', description: 'פייסבוק — קמפיינים, תקציב, ביצועים' },
          { command: 'calendar', description: 'יומן — פגישות, תזכורות' },
          { command: 'email', description: 'שלח מייל' },
          { command: 'voice', description: 'הודעה קולית (קול אלון)' },
          { command: 'image', description: 'צור תמונה עם AI' },
          { command: 'search', description: 'חיפוש באינטרנט' },
          { command: 'site', description: 'בנה אתר / deploy' },
          { command: 'tasks', description: 'משימות פתוחות' },
          { command: 'opus', description: 'שאלה ל-Claude Opus' },
          { command: 'help', description: 'כל היכולות שלי' },
        ]);
      } catch (e: any) {
        log.warn({ err: e.message }, 'failed to set commands');
      }

      // Set menu button to show commands (instead of WebApp)
      try {
        await bot.api.setChatMenuButton({
          menu_button: { type: 'commands' },
        });
        log.info('menu button set to commands');
      } catch (e: any) {
        log.warn({ err: e.message }, 'failed to set menu button');
      }

      bot.catch((err) => {
        log.error({ err: err.message || String(err) }, 'Telegram bot error');
      });

      if (config.mode === 'cloud') {
        // Cloud: use webhook (avoids 409 conflicts during deploys)
        await bot.api.deleteWebhook({ drop_pending_updates: true });
        const webhookUrl = `${process.env.RENDER_EXTERNAL_URL || 'https://alonbot.onrender.com'}/telegram-webhook`;
        await bot.api.setWebhook(webhookUrl, { secret_token: config.localApiSecret });
        log.info({ webhookUrl }, 'Telegram webhook set');
      } else {
        // Local: polling
        bot.start({
          onStart: () => log.info('Telegram polling started'),
          drop_pending_updates: true,
        });
      }
      log.info('bot running');
    },

    async stop() {
      if (config.mode !== 'cloud') await bot.stop();
    },

    getWebhookHandler() {
      return webhookCallback(bot, 'express', { secretToken: config.localApiSecret });
    },

    async sendTyping(original: UnifiedMessage) {
      const ctx = original.raw as any;
      if (ctx?.replyWithChatAction) {
        await ctx.replyWithChatAction('typing');
      }
    },

    async sendStreamStart(original: UnifiedMessage, text: string): Promise<number | null> {
      const ctx = original.raw as any;
      if (!ctx?.reply) return null;
      try {
        const sent = await ctx.reply(text);
        return sent.message_id;
      } catch {
        return null;
      }
    },

    async editStreamMessage(original: UnifiedMessage, messageId: number, text: string) {
      const ctx = original.raw as any;
      const chatId = ctx?.chat?.id || Number(original.senderId);
      if (!chatId) return;
      try {
        await bot.api.editMessageText(chatId, messageId, text);
      } catch (err: any) {
        // Ignore "message not modified" errors (same content)
        if (!err.message?.includes('message is not modified')) {
          log.error({ err: err.message }, 'edit stream error');
        }
      }
    },

    async sendReply(original: UnifiedMessage, reply: UnifiedReply) {
      const ctx = original.raw as any;

      // Direct send by chat ID (for cron messages where raw is null)
      if (!ctx?.reply) {
        const chatId = Number(original.senderId);
        if (!chatId) return;
        if (reply.text) {
          const MAX_CHUNKS = 10;
          const chunks = (reply.text.match(/[\s\S]{1,4000}/g) || [reply.text]).slice(0, MAX_CHUNKS);
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
          log.error({ err: err.message }, 'voice send error');
        }
      }

      if (reply.image) {
        try {
          await ctx.replyWithPhoto(new InputFile(reply.image, 'image.png'));
        } catch (err: any) {
          log.error({ err: err.message }, 'image send error');
        }
      }

      if (reply.text) {
        const MAX_CHUNKS = 10;
        const chunks = (reply.text.match(/[\s\S]{1,4000}/g) || [reply.text]).slice(0, MAX_CHUNKS);
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
