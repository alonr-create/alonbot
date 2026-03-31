import { getDb } from '../db/index.js';
import { isAdminPhone } from '../db/tenant-config.js';

export interface FollowUpRow {
  id: number;
  phone: string;
  message_number: 1 | 2 | 3;
  scheduled_at: string;
  name: string;
  interest: string;
  status: string;
  tenant_id: number | null;
}

const TERMINAL_STATUSES = ['escalated', 'meeting-scheduled', 'closed-won', 'closed-lost'];

/**
 * Schedule a follow-up message for a lead.
 * Skips Alon's own phone number.
 * Accepts optional tenantId for multi-tenant routing.
 */
export function scheduleFollowUp(phone: string, messageNumber: 1 | 2 | 3, scheduledAt: Date, tenantId?: number): void {
  if (isAdminPhone(phone)) return;

  const db = getDb();
  db.prepare(
    'INSERT INTO follow_ups (phone, message_number, scheduled_at, tenant_id) VALUES (?, ?, ?, ?)',
  ).run(phone, messageNumber, scheduledAt.toISOString(), tenantId ?? null);
}

/**
 * Get all follow-ups that are due for sending.
 * Filters out cancelled, already sent, future, and leads in terminal statuses.
 */
export function getDueFollowUps(): FollowUpRow[] {
  const db = getDb();
  const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');

  return db.prepare(`
    SELECT f.id, f.phone, f.message_number, f.scheduled_at, f.tenant_id,
           l.name, l.interest, l.status
    FROM follow_ups f
    JOIN leads l ON l.phone = f.phone
    WHERE f.sent_at IS NULL
      AND f.cancelled = 0
      AND f.scheduled_at <= datetime('now')
      AND l.status NOT IN (${placeholders})
  `).all(...TERMINAL_STATUSES) as FollowUpRow[];
}

/**
 * Cancel all pending follow-ups for a phone number.
 * Returns the number of cancelled rows.
 */
export function cancelFollowUps(phone: string): number {
  const db = getDb();
  const result = db.prepare(
    'UPDATE follow_ups SET cancelled = 1 WHERE phone = ? AND sent_at IS NULL AND cancelled = 0',
  ).run(phone);
  return result.changes;
}

/**
 * Mark a follow-up as sent by setting sent_at to current time.
 */
export function markFollowUpSent(id: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE follow_ups SET sent_at = datetime('now') WHERE id = ?",
  ).run(id);
}
