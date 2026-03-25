import { config } from './config.js';
import { db } from './db.js';
import { withRetry } from './retry.js';
import { createLogger } from './logger.js';

const log = createLogger('monday-leads');

const ALON_DEV_BOARD_ID = 5092777389;

/**
 * Auto-create a lead in Monday.com "לידים אלון" board + SQLite.
 * Called when a new unknown WhatsApp contact sends their first message.
 * Returns the Monday.com item ID, or null on failure.
 */
export async function createMondayLead(
  phone: string,
  name: string,
  firstMessage: string,
): Promise<string | null> {
  if (!config.mondayApiKey) {
    log.warn('MONDAY_API_KEY not configured — skipping lead creation');
    return null;
  }

  // Check if lead already exists in Monday (by phone)
  try {
    const existing = db.prepare('SELECT monday_item_id FROM leads WHERE phone = ?').get(phone) as any;
    if (existing?.monday_item_id) {
      log.debug({ phone }, 'lead already exists in Monday.com');
      return existing.monday_item_id;
    }
  } catch { /* continue */ }

  const itemName = name !== phone ? `${name} — ${phone}` : phone;

  // Column values for Monday.com board 5092777389
  const columnValues = JSON.stringify({
    phone_mm16hqz2: { phone, countryShortName: 'IL' },
    text_mm16pfzp: 'WhatsApp בוט',
    long_text_mm16k6vr: { text: firstMessage.slice(0, 500) },
    status: { index: 0 }, // "Working on it"
  });

  const mutation = `mutation {
    create_item(
      board_id: ${ALON_DEV_BOARD_ID},
      group_id: "topics",
      item_name: ${JSON.stringify(itemName)},
      column_values: ${JSON.stringify(columnValues)}
    ) {
      id
    }
  }`;

  try {
    const res = await withRetry(() => fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: config.mondayApiKey,
      },
      body: JSON.stringify({ query: mutation }),
    }));

    const data = await res.json() as any;

    if (data.errors) {
      log.error({ errors: data.errors }, 'Monday.com mutation failed');
      return null;
    }

    const itemId = data.data?.create_item?.id;
    if (!itemId) {
      log.error({ data }, 'Monday.com returned no item ID');
      return null;
    }

    // Persist to SQLite
    db.prepare(`
      INSERT INTO leads (phone, name, source, monday_item_id, lead_status, created_at, updated_at)
      VALUES (?, ?, 'alon_dev', ?, 'new', datetime('now'), datetime('now'))
      ON CONFLICT(phone) DO UPDATE SET
        monday_item_id = excluded.monday_item_id,
        updated_at = datetime('now')
    `).run(phone, name !== phone ? name : null, itemId);

    log.info({ phone, name, itemId }, 'lead auto-created in Monday.com + SQLite');
    return itemId;
  } catch (e: any) {
    log.error({ err: e.message, phone }, 'failed to create Monday.com lead');
    return null;
  }
}
