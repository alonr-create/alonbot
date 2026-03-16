import { Router } from 'express';
import { getDb } from '../db/index.js';
import { fetchMondayItem } from './api.js';
import { createLogger } from '../utils/logger.js';
import { isAdminPhone } from '../db/tenant-config.js';
import type { MondayWebhookPayload } from './types.js';

const log = createLogger('monday-webhook');

type NewLeadCallback = (phone: string, name: string, interest: string) => void | Promise<void>;
let onNewLeadCallback: NewLeadCallback | null = null;

/**
 * Set a callback to be called when a new lead is created from Monday.com.
 * Used by the conversation layer to trigger the first WhatsApp message.
 */
export function setOnNewLeadCallback(fn: NewLeadCallback): void {
  onNewLeadCallback = fn;
}

/**
 * Clean Israeli phone number to normalized format (972XXXXXXXXX).
 */
function cleanPhone(raw: string): string {
  let phone = raw.replace(/[\s\-()]/g, '');
  // Remove leading + if present
  if (phone.startsWith('+')) {
    phone = phone.slice(1);
  }
  // Convert leading 0 to 972
  if (phone.startsWith('0')) {
    phone = '972' + phone.slice(1);
  }
  // If it doesn't start with 972, assume Israeli and prepend
  if (!phone.startsWith('972')) {
    phone = '972' + phone;
  }
  return phone;
}

export const mondayWebhookRouter = Router();

mondayWebhookRouter.post('/monday', (req, res) => {
  const payload = req.body as MondayWebhookPayload;

  // Challenge verification for Monday.com webhook setup
  if (payload.challenge) {
    log.info('Monday.com webhook challenge received');
    res.json({ challenge: payload.challenge });
    return;
  }

  const event = payload.event;
  if (!event) {
    log.warn('Webhook received with no event and no challenge');
    res.status(400).json({ error: 'No event payload' });
    return;
  }

  // Respond 200 immediately — process asynchronously
  res.status(200).json({ ok: true });

  // Async processing
  processWebhookEvent(event.pulseId, event.boardId).catch((err) => {
    log.error({ err, pulseId: event.pulseId }, 'Failed to process webhook event');
  });
});

async function processWebhookEvent(
  pulseId: number,
  boardId: number,
): Promise<void> {
  log.info({ pulseId, boardId }, 'Processing Monday.com webhook event');

  const item = await fetchMondayItem(pulseId);
  if (!item.phone) {
    log.warn({ pulseId }, 'Monday.com item has no phone number, skipping');
    return;
  }

  const phone = cleanPhone(item.phone);

  // Skip admin/test numbers — never treat as lead
  if (isAdminPhone(phone)) {
    log.info({ phone, pulseId }, 'Admin phone detected, skipping lead processing');
    return;
  }

  const db = getDb();

  // Check if lead already exists by phone
  const existing = db
    .prepare('SELECT id, created_at FROM leads WHERE phone = ?')
    .get(phone) as { id: number; created_at: string } | undefined;

  if (existing) {
    // Check for recent messages (race condition with lead-initiated contact)
    const recentMsg = db
      .prepare(
        "SELECT id FROM messages WHERE phone = ? AND created_at > datetime('now', '-5 minutes')",
      )
      .get(phone);

    // Update existing lead with Monday.com data
    db.prepare(
      `UPDATE leads SET monday_item_id = ?, monday_board_id = ?, interest = ?, name = COALESCE(?, name), source_detail = COALESCE(NULLIF(?, ''), source_detail), updated_at = datetime('now') WHERE phone = ?`,
    ).run(pulseId, boardId, item.interest, item.name, item.source, phone);

    if (recentMsg) {
      log.info({ phone, pulseId }, 'Lead has recent messages, skipping auto-intro');
      return;
    }

    log.info({ phone, pulseId }, 'Updated existing lead with Monday.com data');
  } else {
    // Create new lead
    db.prepare(
      `INSERT INTO leads (phone, name, source, status, monday_item_id, monday_board_id, interest, source_detail) VALUES (?, ?, 'monday', 'new', ?, ?, ?, ?)`,
    ).run(phone, item.name, pulseId, boardId, item.interest, item.source);

    log.info({ phone, pulseId }, 'Created new lead from Monday.com');
  }

  // Trigger callback for new lead handling
  if (onNewLeadCallback) {
    try {
      await onNewLeadCallback(phone, item.name, item.interest);
    } catch (err) {
      log.error({ err, phone }, 'onNewLead callback failed');
    }
  }
}
