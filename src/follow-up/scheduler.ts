import { createLogger } from '../utils/logger.js';
import { getDueFollowUps, markFollowUpSent, scheduleFollowUp } from './follow-up-db.js';
import { generateFollowUpMessage } from './follow-up-ai.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import { isBusinessHours, getNextBusinessDay } from '../calendar/business-hours.js';
import { getDb } from '../db/index.js';

const log = createLogger('follow-up-scheduler');

const FOLLOW_UP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Day offsets between follow-ups: #1 sent -> #2 in 2 days, #2 sent -> #3 in 4 days
const NEXT_FOLLOW_UP_DAYS: Record<number, { next: 2 | 3; days: number } | null> = {
  1: { next: 2, days: 2 },
  2: { next: 3, days: 4 },
  3: null, // no follow-up after #3
};

/**
 * Process all due follow-ups: check business hours, send messages, schedule next.
 * Exported for testing.
 */
export async function processFollowUps(sock: any): Promise<void> {
  const dueFollowUps = getDueFollowUps();

  if (dueFollowUps.length === 0) return;

  log.info({ count: dueFollowUps.length }, 'processing due follow-ups');

  for (const fu of dueFollowUps) {
    try {
      // Check business hours
      if (!isBusinessHours()) {
        // Defer to next business day at 09:30
        const nextDay = getNextBusinessDay();
        const deferredAt = new Date(nextDay.getTime() + 30 * 60 * 1000); // +30min = 09:30

        const db = getDb();
        db.prepare('UPDATE follow_ups SET scheduled_at = ? WHERE id = ?')
          .run(deferredAt.toISOString(), fu.id);

        log.info({ id: fu.id, phone: fu.phone, deferredTo: deferredAt.toISOString() },
          'deferred follow-up to next business day');
        continue;
      }

      // Re-check cancellation (race condition guard)
      const db = getDb();
      const current = db.prepare(
        'SELECT cancelled FROM follow_ups WHERE id = ?',
      ).get(fu.id) as { cancelled: number } | undefined;

      if (!current || current.cancelled === 1) {
        log.info({ id: fu.id }, 'follow-up cancelled before send, skipping');
        continue;
      }

      // Generate and send message
      const message = await generateFollowUpMessage(
        fu.message_number,
        fu.name,
        fu.interest,
      );

      const jid = `${fu.phone}@s.whatsapp.net`;
      await sendWithTyping(sock, jid, message);

      // Mark as sent
      markFollowUpSent(fu.id);

      // Store outgoing message
      db.prepare(
        'INSERT INTO messages (phone, direction, content) VALUES (?, ?, ?)',
      ).run(fu.phone, 'out', message);

      log.info({ id: fu.id, phone: fu.phone, messageNumber: fu.message_number },
        'follow-up sent');

      // Schedule next follow-up if applicable
      const nextConfig = NEXT_FOLLOW_UP_DAYS[fu.message_number];
      if (nextConfig) {
        const nextDate = new Date(Date.now() + nextConfig.days * 24 * 60 * 60 * 1000);
        scheduleFollowUp(fu.phone, nextConfig.next as 1 | 2 | 3, nextDate);
        log.info({ phone: fu.phone, nextNumber: nextConfig.next, scheduledAt: nextDate.toISOString() },
          'next follow-up scheduled');
      }
    } catch (err) {
      log.error({ err, followUpId: fu.id, phone: fu.phone }, 'error processing follow-up');
    }
  }
}

/**
 * Start the follow-up scheduler. Runs processFollowUps every 15 minutes.
 */
export function startFollowUpScheduler(sock: any): void {
  log.info('starting follow-up scheduler (15 min interval)');

  // Run immediately on startup
  processFollowUps(sock).catch((err) =>
    log.error({ err }, 'follow-up scheduler initial run error'),
  );

  // Then every 15 minutes
  setInterval(() => {
    processFollowUps(sock).catch((err) =>
      log.error({ err }, 'follow-up scheduler tick error'),
    );
  }, FOLLOW_UP_INTERVAL_MS);
}
