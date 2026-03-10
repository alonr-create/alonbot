import type { BotAdapter } from '../whatsapp/connection.js';
import { getDb } from '../db/index.js';
import { generateResponse } from './claude-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import { updateMondayStatus } from '../monday/api.js';
import { bookMeeting } from '../calendar/api.js';
import {
  shouldEscalate,
  triggerEscalation,
  resetEscalationCount,
  incrementEscalationCount,
} from '../escalation/handler.js';
import { scheduleFollowUp, cancelFollowUps } from '../follow-up/follow-up-db.js';
import { config } from '../config.js';
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
 * stores all messages, updates lead status + Monday.com.
 * Detects [BOOK:...] and [ESCALATE] markers in Claude responses.
 */
export async function handleConversation(
  phone: string,
  batchedMessages: string[],
  sock: BotAdapter,
): Promise<void> {
  const db = getDb();

  // Look up lead
  const lead = db
    .prepare('SELECT * FROM leads WHERE phone = ?')
    .get(phone) as LeadRow | undefined;

  const leadName = lead?.name || 'לקוח';
  const leadInterest = lead?.interest || '';

  // Combine batched messages for escalation check
  const batchedText = batchedMessages.join('\n');

  // Check escalation BEFORE calling Claude
  const escalationCheck = shouldEscalate(phone, batchedText);
  if (escalationCheck.escalate) {
    // Fetch history for escalation summary
    const historyRows = db
      .prepare(
        'SELECT direction, content FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 20',
      )
      .all(phone) as MessageRow[];
    historyRows.reverse();
    const messages = historyRows.map((row) => ({
      role: row.direction === 'in' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    }));
    messages.push({ role: 'user', content: batchedText });

    // Store incoming messages before escalation
    const insertMsg = db.prepare(
      'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)',
    );
    const leadId = lead?.id || null;
    for (const text of batchedMessages) {
      insertMsg.run(phone, leadId, 'in', text);
    }

    log.info(
      { phone, reason: escalationCheck.reason },
      'escalation triggered before Claude call',
    );
    await triggerEscalation(
      phone,
      leadName,
      messages,
      sock,
      lead?.monday_item_id ?? undefined,
      lead?.monday_board_id ?? undefined,
    );
    cancelFollowUps(phone); // No follow-ups for escalated leads
    return;
  }

  // Escalation count management: short messages from in-conversation leads
  if (lead && lead.status === 'in-conversation') {
    if (batchedText.length < 5) {
      incrementEscalationCount(phone);
    } else {
      resetEscalationCount(phone);
    }
  }

  // Build system prompt (async — fetches calendar slots)
  const systemPrompt = await buildSystemPrompt(leadName, leadInterest);

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
  messages.push({ role: 'user', content: batchedText });

  // Call Claude
  const response = await generateResponse(messages, systemPrompt);

  const jid = phone + '@s.whatsapp.net';
  const insertMsg = db.prepare(
    'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)',
  );
  const leadId = lead?.id || null;

  // Track status change
  let newStatus: LeadStatus | null = null;

  // Parse [BOOK:...] marker from Claude response
  const bookMatch = response.match(/\[BOOK:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})\]/);
  if (bookMatch) {
    const [, date, time] = bookMatch;
    const cleanResponse = response.replace(/\[BOOK:[^\]]+\]/, '').trim();

    // Send the clean response first
    await sendWithTyping(sock, jid, cleanResponse);

    // Book the meeting
    const result = await bookMeeting(date, time, leadName, phone, leadInterest, 'Discovery call');
    if (result.success) {
      await sendWithTyping(sock, jid, `מעולה! הפגישה נקבעה ל-${date} בשעה ${time}. אלון יתקשר אליך`);
      newStatus = 'meeting-scheduled';
      cancelFollowUps(phone); // No follow-ups for booked leads
    } else {
      await sendWithTyping(
        sock,
        jid,
        'סליחה, הייתה בעיה עם קביעת הפגישה. אלון יחזור אליך עם זמנים מעודכנים.',
      );
    }

    // Store incoming messages
    for (const text of batchedMessages) {
      insertMsg.run(phone, leadId, 'in', text);
    }
    // Store outgoing response (clean version)
    insertMsg.run(phone, leadId, 'out', cleanResponse);

    // Update lead
    if (lead) {
      db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE phone = ?").run(phone);
      if (newStatus) {
        db.prepare('UPDATE leads SET status = ? WHERE phone = ?').run(newStatus, phone);
        if (lead.monday_item_id && lead.monday_board_id) {
          updateMondayStatus(lead.monday_item_id, lead.monday_board_id, newStatus).catch((err) => {
            log.error({ err, phone }, 'Monday.com status sync failed');
          });
        }
      }
    }

    log.info(
      { phone, date, time, success: result.success },
      'booking flow completed',
    );
    return;
  }

  // Parse [ESCALATE] marker from Claude response
  if (response.includes('[ESCALATE]')) {
    const cleanResponse = response.replace('[ESCALATE]', '').trim();
    await sendWithTyping(sock, jid, cleanResponse);

    // Store incoming messages
    for (const text of batchedMessages) {
      insertMsg.run(phone, leadId, 'in', text);
    }
    // Store outgoing response (clean version)
    insertMsg.run(phone, leadId, 'out', cleanResponse);

    // Update lead timestamp
    if (lead) {
      db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE phone = ?").run(phone);
    }

    await triggerEscalation(
      phone,
      leadName,
      messages,
      sock,
      lead?.monday_item_id ?? undefined,
      lead?.monday_board_id ?? undefined,
    );

    cancelFollowUps(phone); // No follow-ups for escalated leads
    log.info({ phone }, 'escalation triggered from Claude marker');
    return;
  }

  // Normal flow: send response via WhatsApp
  await sendWithTyping(sock, jid, response);

  // Store incoming messages individually
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

  // Schedule follow-up #1 for 24 hours later (FU-01)
  // Cancel any existing follow-ups first (resets the timer on each exchange)
  if (phone !== config.alonPhone) {
    cancelFollowUps(phone);
    const followUpTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    scheduleFollowUp(phone, 1, followUpTime);
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
  sock: BotAdapter,
): Promise<void> {
  const db = getDb();

  const systemPrompt = await buildSystemPrompt(name, interest);

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

  // Schedule first follow-up for new leads (24 hours)
  if (phone !== config.alonPhone) {
    const followUpTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    scheduleFollowUp(phone, 1, followUpTime);
  }

  log.info({ phone, name, interest }, 'first message sent');
}
