import type { WASocket } from '@whiskeysockets/baileys';
import { getDb } from '../db/index.js';
import { generateResponse } from './claude-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import { updateMondayStatus } from '../monday/api.js';
import { createLogger } from '../utils/logger.js';
import type { LeadStatus } from '../monday/types.js';

const log = createLogger('conversation');

interface LeadRow {
  id: number;
  phone: string;
  name: string | null;
  interest: string | null;
  status: string;
  monday_item_id: number | null;
  monday_board_id: number | null;
}

interface MessageRow {
  direction: string;
  content: string;
}

/**
 * Handle a batch of incoming messages for a phone number.
 * Builds conversation history from DB, calls Claude, sends response,
 * stores all messages, and updates lead status + Monday.com.
 */
export async function handleConversation(
  phone: string,
  batchedMessages: string[],
  sock: WASocket,
): Promise<void> {
  const db = getDb();

  // Look up lead
  const lead = db
    .prepare('SELECT * FROM leads WHERE phone = ?')
    .get(phone) as LeadRow | undefined;

  const leadName = lead?.name || 'לקוח';
  const leadInterest = lead?.interest || '';

  // Build system prompt
  const systemPrompt = buildSystemPrompt(leadName, leadInterest);

  // Fetch last 20 messages for context
  const historyRows = db
    .prepare(
      'SELECT direction, content FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 20',
    )
    .all(phone) as MessageRow[];

  // Reverse to chronological order
  historyRows.reverse();

  // Map to Claude format
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> =
    historyRows.map((row) => ({
      role: row.direction === 'in' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    }));

  // Add batched messages as final user message
  const batchedText = batchedMessages.join('\n');
  messages.push({ role: 'user', content: batchedText });

  // Call Claude
  const response = await generateResponse(messages, systemPrompt);

  // Send response via WhatsApp
  const jid = phone + '@s.whatsapp.net';
  await sendWithTyping(sock, jid, response);

  // Store incoming messages individually
  const insertMsg = db.prepare(
    'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)',
  );
  const leadId = lead?.id || null;
  for (const text of batchedMessages) {
    insertMsg.run(phone, leadId, 'in', text);
  }

  // Store outgoing response
  insertMsg.run(phone, leadId, 'out', response);

  // Update lead timestamp
  if (lead) {
    db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE phone = ?").run(
      phone,
    );
  }

  // Status progression
  if (lead) {
    let newStatus: LeadStatus | null = null;

    if (lead.status === 'new') {
      newStatus = 'contacted';
    } else if (lead.status === 'contacted') {
      newStatus = 'in-conversation';
    }

    // Quote detection: shekel sign followed by digits
    if (
      lead.status !== 'quote-sent' &&
      lead.status !== 'meeting-scheduled' &&
      lead.status !== 'escalated' &&
      /₪[\d,]+/.test(response)
    ) {
      newStatus = 'quote-sent';
    }

    if (newStatus) {
      db.prepare('UPDATE leads SET status = ? WHERE phone = ?').run(
        newStatus,
        phone,
      );

      // Sync to Monday.com (fire-and-forget)
      if (lead.monday_item_id && lead.monday_board_id) {
        updateMondayStatus(lead.monday_item_id, lead.monday_board_id, newStatus).catch(
          (err) => {
            log.error({ err, phone }, 'Monday.com status sync failed');
          },
        );
      }
    }
  }

  log.info(
    { phone, batchSize: batchedMessages.length, responseLength: response.length },
    'conversation handled',
  );
}

/**
 * Send a personalized first message to a new lead from Monday.com.
 * Uses Claude to generate an intro referencing their stated interest.
 */
export async function sendFirstMessage(
  phone: string,
  name: string,
  interest: string,
  sock: WASocket,
): Promise<void> {
  const db = getDb();

  const systemPrompt = buildSystemPrompt(name, interest);

  // Generate personalized intro
  const introPrompt = interest
    ? `היי ${name}! ראיתי שאתה מעוניין ב${interest}. תציג את עצמך בקצרה ותשאל איך אתה יכול לעזור.`
    : `היי ${name}! תציג את עצמך בקצרה ותשאל במה הלקוח מעוניין.`;

  const response = await generateResponse(
    [{ role: 'user', content: introPrompt }],
    systemPrompt,
  );

  const jid = phone + '@s.whatsapp.net';
  await sendWithTyping(sock, jid, response);

  // Store outgoing message
  const lead = db
    .prepare('SELECT id FROM leads WHERE phone = ?')
    .get(phone) as { id: number } | undefined;

  db.prepare(
    'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)',
  ).run(phone, lead?.id || null, 'out', response);

  // Update status to contacted
  db.prepare(
    "UPDATE leads SET status = 'contacted', updated_at = datetime('now') WHERE phone = ?",
  ).run(phone);

  // Sync to Monday.com
  const fullLead = db
    .prepare('SELECT monday_item_id, monday_board_id FROM leads WHERE phone = ?')
    .get(phone) as { monday_item_id: number | null; monday_board_id: number | null } | undefined;

  if (fullLead?.monday_item_id && fullLead?.monday_board_id) {
    updateMondayStatus(
      fullLead.monday_item_id,
      fullLead.monday_board_id,
      'contacted',
    ).catch((err) => {
      log.error({ err, phone }, 'Monday.com status sync failed on first message');
    });
  }

  log.info({ phone, name, interest }, 'first message sent');
}
