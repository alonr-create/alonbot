import { Router } from 'express';
import { getDb } from '../db/index.js';
import { fetchMondayItem } from './api.js';
import { createLogger } from '../utils/logger.js';
import { isAdminPhone } from '../db/tenant-config.js';
import type { MondayWebhookPayload } from './types.js';
import type { BotAdapter } from '../whatsapp/connection.js';

const log = createLogger('monday-webhook');

type NewLeadCallback = (phone: string, name: string, interest: string) => void | Promise<void>;
let onNewLeadCallback: NewLeadCallback | null = null;

/** Registered bot adapter for sending WhatsApp messages from webhook events. */
let botAdapter: BotAdapter | null = null;

/**
 * Register the bot adapter so webhook events can send WhatsApp messages.
 */
export function setWebhookBotAdapter(adapter: BotAdapter): void {
  botAdapter = adapter;
}

/**
 * Status label → WhatsApp message mapping.
 * When boss changes status on Monday.com, send appropriate message to lead.
 * null means don't send a message for that status change.
 */
const STATUS_MESSAGES: Record<string, string | null> = {
  'הצעת מחיר נשלחה': 'היי! רציתי לוודא שקיבלת את הצעת המחיר שלנו. יש שאלות? אשמח לעזור 😊',
  'פגישה נקבעה': null, // handled by booking flow
  'סגור-זכייה': 'מעולה! שמחים שהחלטת להתקדם איתנו 🎉 ניצור קשר בקרוב עם כל הפרטים.',
  'חדש': null,
  'בטיפול': null,
  'ממתין לתשובה': 'היי, רק רציתי לבדוק — ראית את ההודעה האחרונה שלי? אשמח לעזור אם יש שאלות 🙏',
};

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

  // Webhook authentication — verify shared secret (before challenge)
  const webhookSecret = process.env.MONDAY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== webhookSecret) {
      log.warn('unauthorized Monday.com webhook attempt');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  } else {
    log.warn('MONDAY_WEBHOOK_SECRET not set — rejecting webhook');
    res.status(401).json({ error: 'Webhook secret not configured' });
    return;
  }

  // Challenge verification for Monday.com webhook setup (after auth)
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

  // Route by event type
  if (event.type === 'update_column_value' && event.columnId) {
    processColumnChangeEvent(event).catch((err) => {
      log.error({ err, pulseId: event.pulseId }, 'Failed to process column change event');
    });
  } else {
    // Default: create_item or other events
    processWebhookEvent(event.pulseId, event.boardId).catch((err) => {
      log.error({ err, pulseId: event.pulseId }, 'Failed to process webhook event');
    });
  }
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

  // Resolve tenant by Monday board ID so leads/messages get correct tenant_id
  const tenantRow = db.prepare('SELECT id FROM tenants WHERE monday_board_id = ?').get(boardId) as { id: number } | undefined;
  const tenantId = tenantRow?.id ?? null;

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

    // Update existing lead with Monday.com data (also fix tenant_id if missing)
    db.prepare(
      `UPDATE leads SET monday_item_id = ?, monday_board_id = ?, interest = ?, name = COALESCE(?, name), source_detail = COALESCE(NULLIF(?, ''), source_detail), tenant_id = COALESCE(tenant_id, ?), updated_at = datetime('now') WHERE phone = ?`,
    ).run(pulseId, boardId, item.interest, item.name, item.source, tenantId, phone);

    if (recentMsg) {
      log.info({ phone, pulseId }, 'Lead has recent messages, skipping auto-intro');
      return;
    }

    log.info({ phone, pulseId }, 'Updated existing lead with Monday.com data');
  } else {
    // Create new lead
    db.prepare(
      `INSERT INTO leads (phone, name, source, status, monday_item_id, monday_board_id, interest, source_detail, tenant_id) VALUES (?, ?, 'monday', 'new', ?, ?, ?, ?, ?)`,
    ).run(phone, item.name, pulseId, boardId, item.interest, item.source, tenantId);

    log.info({ phone, pulseId }, 'Created new lead from Monday.com');
  }

  // Trigger callback only for genuinely new leads (not existing ones)
  if (onNewLeadCallback && !existing) {
    try {
      await onNewLeadCallback(phone, item.name, item.interest);
    } catch (err) {
      log.error({ err, phone }, 'onNewLead callback failed');
    }
  }
}

/**
 * Process a column value change event from Monday.com.
 * When status column changes, send a WhatsApp message to the lead.
 */
async function processColumnChangeEvent(
  event: NonNullable<MondayWebhookPayload['event']>,
): Promise<void> {
  const { pulseId, boardId, columnId, value } = event;
  log.info({ pulseId, boardId, columnId, value }, 'Processing Monday.com column change');

  if (!botAdapter) {
    log.warn('No bot adapter registered — cannot send WhatsApp from webhook');
    return;
  }

  // Only handle status column changes
  const statusColumnId = (await import('../config.js')).config.mondayStatusColumnId;
  if (columnId !== statusColumnId && columnId !== 'status') {
    log.debug({ columnId }, 'Ignoring non-status column change');
    return;
  }

  // Extract new status label
  const newStatus = (value as any)?.label?.text;
  if (!newStatus) {
    log.debug({ value }, 'No status label in column change');
    return;
  }

  // Check if we have a message for this status
  const message = STATUS_MESSAGES[newStatus];
  if (!message) {
    log.debug({ newStatus }, 'No WhatsApp message configured for this status');
    return;
  }

  // Find the lead by monday_item_id
  const db = getDb();
  const lead = db
    .prepare('SELECT phone, name, id, tenant_id FROM leads WHERE monday_item_id = ?')
    .get(pulseId) as { phone: string; name: string | null; id: number; tenant_id: number | null } | undefined;

  if (!lead) {
    log.warn({ pulseId }, 'No local lead found for Monday item');
    return;
  }

  // Don't send status messages to admin
  if (isAdminPhone(lead.phone)) return;

  const jid = lead.phone + '@s.whatsapp.net';
  try {
    const { sendWithTyping } = await import('../whatsapp/rate-limiter.js');
    await sendWithTyping(botAdapter, jid, message);
    log.info({ phone: lead.phone, newStatus }, 'Status change WhatsApp message sent');

    // Store outgoing message with correct tenant_id
    db.prepare('INSERT INTO messages (phone, lead_id, direction, content, tenant_id) VALUES (?, ?, ?, ?, ?)')
      .run(lead.phone, lead.id, 'out', message, lead.tenant_id);
  } catch (err) {
    log.error({ err, phone: lead.phone, newStatus }, 'Failed to send status change message');
  }
}
