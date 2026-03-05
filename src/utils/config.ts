import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '3700'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  mondayApiKey: process.env.MONDAY_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  allowedWhatsApp: (process.env.ALLOWED_WHATSAPP || '').split(',').filter(Boolean),
  allowedTelegram: (process.env.ALLOWED_TELEGRAM || '').split(',').filter(Boolean),
  dataDir: new URL('../../data/', import.meta.url).pathname,
  skillsDir: new URL('../../skills/', import.meta.url).pathname,
};
