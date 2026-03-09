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
  alonPhone: process.env.ALON_PHONE || '972546300783',
  nodeEnv: process.env.NODE_ENV || 'development',
} as const;
