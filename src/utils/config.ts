import 'dotenv/config';

export const config = {
  mode: (process.env.MODE || 'local') as 'cloud' | 'local',
  port: parseInt(process.env.PORT || '3700'),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  mondayApiKey: process.env.MONDAY_API_KEY || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
  groqApiKey: process.env.GROQ_API_KEY || '',
  gmailUser: process.env.GMAIL_USER || '',
  gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
  allowedWhatsApp: (process.env.ALLOWED_WHATSAPP || '').split(',').filter(Boolean),
  allowedTelegram: (process.env.ALLOWED_TELEGRAM || '').split(',').filter(Boolean),
  localApiUrl: process.env.LOCAL_API_URL || '',
  localApiSecret: process.env.LOCAL_API_SECRET || 'alonbot-secret-2026',
  googleCalendarScriptUrl: process.env.GOOGLE_CALENDAR_SCRIPT_URL || '',
  dataDir: new URL('../../data/', import.meta.url).pathname,
  skillsDir: new URL('../../skills/', import.meta.url).pathname,
};
