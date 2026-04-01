import 'dotenv/config';
import { join } from 'path';

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  dataDir: process.env.DATA_DIR || './data',
  get sessionDir() {
    return join(this.dataDir, 'whatsapp-session');
  },
  get dbPath() {
    return join(this.dataDir, 'bot.db');
  },
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  alonPhone: process.env.ALON_PHONE || process.env.ALLOWED_WHATSAPP || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  mondayApiToken: process.env.MONDAY_API_TOKEN || process.env.MONDAY_API_KEY || '',
  mondayBoardId: process.env.MONDAY_BOARD_ID || '',
  mondayBoardIdDprisha: process.env.MONDAY_BOARD_ID_DPRISHA || '',
  mondayStatusColumnId: process.env.MONDAY_STATUS_COLUMN_ID || 'status',
  googleCalendarScriptUrl: process.env.GOOGLE_CALENDAR_SCRIPT_URL || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
  voiceAgentUrl: process.env.VOICE_AGENT_URL || '',
  voiceAgentSecret: process.env.VOICE_AGENT_SECRET || '',
  waCloudToken: process.env.WA_CLOUD_TOKEN || '',
  waCloudPhoneId: process.env.WA_CLOUD_PHONE_ID || '',
  waCloudPhoneIdAlondev: process.env.WA_PHONE_ID_ALONDEV || '',
  waCloudVerifyToken: process.env.WA_CLOUD_VERIFY_TOKEN || '',
  waCloudWabaId: process.env.WA_CLOUD_WABA_ID || '',
  waCloudWabaIdAlondev: process.env.WA_CLOUD_WABA_ID_ALONDEV || '',
} as const;
