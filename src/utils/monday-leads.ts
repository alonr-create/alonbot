import { config } from './config.js';
import { db } from './db.js';
import { LEAD_STATUS } from './lead-status.js';
import { withRetry } from './retry.js';
import { createLogger } from './logger.js';

const log = createLogger('monday-leads');

function nowIsrael(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}

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

  // Check if lead already exists in local DB
  try {
    const existing = db.prepare('SELECT monday_item_id FROM leads WHERE phone = ?').get(phone) as any;
    if (existing?.monday_item_id) {
      log.debug({ phone }, 'lead already exists in Monday.com');
      return existing.monday_item_id;
    }
  } catch { /* continue */ }

  // Check if lead already exists in Monday.com board (created by campaign etc.)
  try {
    const searchQuery = `query { boards(ids: ${ALON_DEV_BOARD_ID}) { items_page(limit: 5, query_params: { rules: [{ column_id: "phone_mm16hqz2", compare_value: ["${phone}"], operator: contains_text }] }) { items { id name } } } }`;
    const searchRes = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
      body: JSON.stringify({ query: searchQuery }),
    });
    const searchData = await searchRes.json() as any;
    const existingItem = searchData.data?.boards?.[0]?.items_page?.items?.[0];
    if (existingItem?.id) {
      // Found in Monday but not in local DB — link it
      const now = nowIsrael();
      db.prepare(`
        INSERT INTO leads (phone, name, source, monday_item_id, lead_status, created_at, updated_at)
        VALUES (?, ?, 'campaign', ?, 'active', ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
          monday_item_id = excluded.monday_item_id,
          updated_at = ?
      `).run(phone, name !== phone ? name : null, existingItem.id, now, now, now);
      log.info({ phone, itemId: existingItem.id }, 'existing Monday.com lead linked to local DB');
      return existingItem.id;
    }
  } catch (e: any) {
    log.debug({ err: e.message, phone }, 'Monday.com search failed, will create new');
  }

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
    const now2 = nowIsrael();
    db.prepare(`
      INSERT INTO leads (phone, name, source, monday_item_id, lead_status, created_at, updated_at)
      VALUES (?, ?, 'alon_dev', ?, '${LEAD_STATUS.NEW}', ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        monday_item_id = excluded.monday_item_id,
        updated_at = ?
    `).run(phone, name !== phone ? name : null, itemId, now2, now2, now2);

    log.info({ phone, name, itemId }, 'lead auto-created in Monday.com + SQLite');
    return itemId;
  } catch (e: any) {
    log.error({ err: e.message, phone }, 'failed to create Monday.com lead');
    return null;
  }
}

/**
 * Sync a WhatsApp conversation exchange to Monday.com as an item update.
 * Fire-and-forget — never throws.
 */
export async function syncChatToMonday(
  phone: string,
  userMessage: string,
  botResponse: string,
): Promise<void> {
  if (!config.mondayApiKey) return;

  try {
    const lead = db.prepare('SELECT monday_item_id, name FROM leads WHERE phone = ?')
      .get(phone) as { monday_item_id: string | null; name: string | null } | undefined;

    if (!lead?.monday_item_id) {
      // Lead exists in Monday (created by campaign) but not in local DB — try to auto-create
      const itemId = await createMondayLead(phone, phone, userMessage);
      if (!itemId) return;
      // Re-fetch after creation
      const freshLead = db.prepare('SELECT monday_item_id, name FROM leads WHERE phone = ?')
        .get(phone) as { monday_item_id: string | null; name: string | null } | undefined;
      if (!freshLead?.monday_item_id) return;
      Object.assign(lead ?? {}, freshLead);
    }

    const finalLead = lead as { monday_item_id: string; name: string | null };
    const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
    const name = finalLead.name || 'לקוח';
    const body = `💬 שיחת WhatsApp (${timestamp})\n\n📩 ${name}:\n${userMessage}\n\n🤖 יעל:\n${botResponse}`;

    const escaped = body.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const mutation = `mutation { create_update(item_id: ${finalLead.monday_item_id}, body: "${escaped}") { id } }`;

    await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
      body: JSON.stringify({ query: mutation }),
    });
    log.debug({ phone }, 'chat synced to Monday.com');
  } catch (e: any) {
    log.error({ err: e.message, phone }, 'failed to sync chat to Monday.com');
  }
}

/**
 * Update Monday.com item name (e.g. when we learn the lead's real name).
 */
export async function updateMondayItemName(
  phone: string,
  newName: string,
): Promise<void> {
  if (!config.mondayApiKey) return;

  try {
    const lead = db.prepare('SELECT monday_item_id FROM leads WHERE phone = ?')
      .get(phone) as { monday_item_id: string | null } | undefined;

    if (!lead?.monday_item_id) return;

    const safeName = newName.replace(/[\\"{}\[\]()]/g, '').slice(0, 100);
    const mutation = `mutation {
      change_simple_column_value(
        item_id: ${lead.monday_item_id},
        board_id: ${ALON_DEV_BOARD_ID},
        column_id: "name",
        value: "${safeName} — ${phone}"
      ) { id }
    }`;

    await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
      body: JSON.stringify({ query: mutation }),
    });

    // Update local DB too
    db.prepare('UPDATE leads SET name = ?, updated_at = datetime(\'now\') WHERE phone = ?')
      .run(newName, phone);

    log.info({ phone, name: newName }, 'lead name updated in Monday.com + SQLite');
  } catch (e: any) {
    log.error({ err: e.message, phone }, 'failed to update Monday.com item name');
  }
}

/**
 * Extract a lead's name from their message text.
 * Looks for common Hebrew/English patterns.
 */
export function extractLeadName(text: string): string | null {
  const patterns = [
    /(?:שמי|אני|קוראים לי|השם שלי)\s+([א-ת]{2,}(?:\s+[א-ת]{2,})?)/,
    /(?:my name is|i'm|i am)\s+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)/i,
  ];
  const ignore = ['מעוניין', 'רוצה', 'צריך', 'מחפש', 'בעל', 'עובד', 'גר', 'פה', 'כאן', 'בא'];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const name = match[1].trim();
      if (!ignore.includes(name)) return name;
    }
  }
  return null;
}

/**
 * Status label → WhatsApp message mapping.
 * When boss changes status on Monday.com, send appropriate message to lead.
 */
const STATUS_MESSAGES: Record<string, string | null> = {
  'הצעת מחיר נשלחה': 'היי! רציתי לוודא שקיבלת את הצעת המחיר שלנו. יש שאלות? אשמח לעזור 😊',
  'סגור-זכייה': 'מעולה! שמחים שהחלטת להתקדם איתנו 🎉 ניצור קשר בקרוב עם כל הפרטים.',
  'ממתין לתשובה': 'היי, רק רציתי לבדוק — ראית את ההודעה האחרונה שלי? אשמח לעזור אם יש שאלות 🙏',
};

/**
 * Handle a new item created on Monday.com board.
 * Sends a WhatsApp welcome message ONLY if the lead came from the website or Facebook.
 */
async function handleNewItem(event: any): Promise<void> {
  const pulseId = event.pulseId;
  const boardId = event.boardId;
  if (!pulseId) return;

  log.info({ pulseId, boardId }, 'New item webhook received');

  if (!config.mondayApiKey) return;

  // Fetch item from Monday API to get phone + source
  const query = `query { items(ids: [${pulseId}]) { name column_values { id text } } }`;
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
    body: JSON.stringify({ query }),
  });
  const data = await res.json() as any;
  const item = data.data?.items?.[0];
  if (!item) { log.warn({ pulseId }, 'Item not found'); return; }

  const columns = item.column_values || [];
  const phoneCol = columns.find((c: any) => c.id === 'phone_mm16hqz2');
  const sourceCol = columns.find((c: any) => c.id === 'text_mm16pfzp');
  const phone = (phoneCol?.text || '').replace(/[\s\-()]/g, '');
  const source = (sourceCol?.text || '').toLowerCase();

  if (!phone || phone.length < 9) {
    log.warn({ pulseId }, 'No valid phone');
    return;
  }

  // Only send WA for website/Facebook leads — NOT bulk imports
  const allowedSources = ['alon-dev-website', 'facebook', 'fb', 'instagram', 'meta'];
  const isAllowedSource = allowedSources.some(s => source.includes(s));
  if (!isAllowedSource) {
    log.info({ pulseId, source, phone }, 'Source not allowed for auto-WA — skipping');
    return;
  }

  // Normalize phone
  let normalizedPhone = phone;
  if (normalizedPhone.startsWith('+')) normalizedPhone = normalizedPhone.slice(1);
  if (normalizedPhone.startsWith('0')) normalizedPhone = '972' + normalizedPhone.slice(1);
  if (!normalizedPhone.startsWith('972')) normalizedPhone = '972' + normalizedPhone;

  // Don't message Alon
  if (config.allowedWhatsApp.includes(normalizedPhone)) return;

  // Save to local DB
  const now = nowIsrael();
  db.prepare(`INSERT INTO leads (phone, name, source, monday_item_id, lead_status, created_at, updated_at)
    VALUES (?, ?, 'alon_dev', ?, '${LEAD_STATUS.NEW}', ?, ?)
    ON CONFLICT(phone) DO UPDATE SET monday_item_id = excluded.monday_item_id, updated_at = ?
  `).run(normalizedPhone, item.name, String(pulseId), now, now, now);

  // Send welcome WhatsApp
  try {
    const { getAdapter } = await import('../gateway/router.js');
    const whatsapp = getAdapter('whatsapp');
    if (!whatsapp) { log.warn('No WhatsApp adapter'); return; }

    const leadName = item.name.split('—')[0]?.trim() || '';
    const greeting = leadName ? `היי ${leadName}!` : 'היי!';
    const welcomeMessage = `${greeting} קיבלתי את הפנייה שלך באתר Alon.dev 🙏\nאשמח לשמוע יותר על העסק שלך ואיך אוכל לעזור.\nמה השירות שמעניין אותך?`;

    const fakeMsg = {
      id: 'monday-new-item',
      channel: 'whatsapp' as const,
      senderId: normalizedPhone,
      senderName: leadName,
      text: '',
      timestamp: Date.now(),
      raw: null,
    };
    await whatsapp.sendReply(fakeMsg, { text: welcomeMessage });
    log.info({ phone: normalizedPhone, source }, 'New lead welcome WhatsApp sent');

    db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-inbound', ?, 'assistant', ?, ?)`)
      .run(normalizedPhone, welcomeMessage, nowIsrael());
  } catch (e: any) {
    log.error({ err: e.message, phone: normalizedPhone }, 'Failed to send welcome message');
  }
}

/**
 * Handle Monday.com webhook for column value changes + new item creation.
 * Returns the Express route handler.
 */
export function mondayWebhookHandler() {
  return async (req: any, res: any) => {
    const payload = req.body;

    // Challenge verification
    if (payload.challenge) {
      log.info('Monday.com webhook challenge received');
      return res.json({ challenge: payload.challenge });
    }

    const event = payload.event;
    if (!event) return res.status(400).json({ error: 'No event' });

    // Respond 200 immediately
    res.status(200).json({ ok: true });

    // Handle new item creation — send welcome WA to website/FB leads only
    if (event.type === 'create_item') {
      handleNewItem(event).catch((e: any) =>
        log.error({ err: e.message, pulseId: event.pulseId }, 'Failed to handle new item'),
      );
      return;
    }

    // Only handle status column changes
    if (event.type !== 'update_column_value') return;

    const newStatus = event.value?.label?.text;
    if (!newStatus) return;

    const message = STATUS_MESSAGES[newStatus];
    if (!message) return;

    // Find lead by Monday item ID
    const lead = db.prepare('SELECT phone, name FROM leads WHERE monday_item_id = ?')
      .get(String(event.pulseId)) as { phone: string; name: string | null } | undefined;

    if (!lead) {
      log.warn({ pulseId: event.pulseId }, 'No local lead for Monday item');
      return;
    }

    // Don't message Alon
    if (config.allowedWhatsApp.includes(lead.phone)) return;

    // Send WhatsApp message via the adapter
    try {
      const { getAdapter } = await import('../gateway/router.js');
      const whatsapp = getAdapter('whatsapp');
      if (!whatsapp) {
        log.warn('No WhatsApp adapter — cannot send status message');
        return;
      }

      const fakeMsg = {
        id: 'monday-webhook',
        channel: 'whatsapp' as const,
        senderId: lead.phone,
        senderName: lead.name || '',
        text: '',
        timestamp: Date.now(),
        raw: null,
      };

      await whatsapp.sendReply(fakeMsg, { text: message });
      log.info({ phone: lead.phone, newStatus }, 'Monday status → WhatsApp message sent');

      // Store in messages DB
      db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-inbound', ?, 'assistant', ?, ?)`)
        .run(lead.phone, message, nowIsrael());
    } catch (e: any) {
      log.error({ err: e.message, phone: lead.phone }, 'Failed to send status change message');
    }
  };
}
