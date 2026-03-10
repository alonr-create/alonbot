import { getDb } from '../db/index.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import { getTimezone } from '../db/tenant-config.js';
import { createLogger } from '../utils/logger.js';
import type { BotAdapter } from '../whatsapp/connection.js';

const log = createLogger('reminders');

const REMINDER_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

/**
 * Schedule a reminder to be sent at a specific time.
 */
export function scheduleReminder(
  phone: string,
  message: string,
  scheduledAt: Date,
): number {
  const db = getDb();
  const result = db
    .prepare(
      'INSERT INTO reminders (phone, message, scheduled_at) VALUES (?, ?, ?)',
    )
    .run(phone, message, scheduledAt.toISOString());

  log.info(
    { phone, message, scheduledAt: scheduledAt.toISOString() },
    'reminder scheduled',
  );

  return result.lastInsertRowid as number;
}

interface ReminderRow {
  id: number;
  phone: string;
  message: string;
  scheduled_at: string;
}

/**
 * Check for due reminders and send them via WhatsApp.
 */
async function processDueReminders(sock: BotAdapter): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const dueReminders = db
    .prepare(
      'SELECT id, phone, message, scheduled_at FROM reminders WHERE sent = 0 AND scheduled_at <= ?',
    )
    .all(now) as ReminderRow[];

  if (dueReminders.length === 0) return;

  log.info({ count: dueReminders.length }, 'processing due reminders');

  for (const reminder of dueReminders) {
    try {
      const jid = reminder.phone + '@s.whatsapp.net';
      const reminderText = `\u23F0 תזכורת: ${reminder.message}`;

      await sendWithTyping(sock, jid, reminderText);

      // Mark as sent
      db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(reminder.id);

      log.info(
        { id: reminder.id, phone: reminder.phone, message: reminder.message },
        'reminder sent',
      );
    } catch (err) {
      log.error(
        { err, reminderId: reminder.id, phone: reminder.phone },
        'error sending reminder',
      );
    }
  }
}

/**
 * Start the reminder scheduler. Checks every minute for due reminders.
 */
export function startReminderScheduler(sock: BotAdapter): void {
  log.info('starting reminder scheduler (1 min interval)');

  // Run immediately on startup
  processDueReminders(sock).catch((err) =>
    log.error({ err }, 'reminder scheduler initial run error'),
  );

  // Then every minute
  setInterval(() => {
    processDueReminders(sock).catch((err) =>
      log.error({ err }, 'reminder scheduler tick error'),
    );
  }, REMINDER_CHECK_INTERVAL_MS);
}
