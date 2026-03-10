import type { BotAdapter } from '../whatsapp/connection.js';
import { getDb } from '../db/index.js';
import { generateResponse } from './claude-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import {
  updateMondayStatus,
  addItemUpdate,
  createBoardItem,
  getBoardStats,
} from '../monday/api.js';
import { bookMeeting } from '../calendar/api.js';
import {
  shouldEscalate,
  triggerEscalation,
  resetEscalationCount,
  incrementEscalationCount,
} from '../escalation/handler.js';
import { scheduleFollowUp, cancelFollowUps } from '../follow-up/follow-up-db.js';
import { searchLeadContext, getLeadConversation } from './boss-context.js';
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
 * Detects [BOOK:...], [ESCALATE], and boss-mode markers in Claude responses.
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
    cancelFollowUps(phone);
    return;
  }

  // Escalation count management
  if (lead && lead.status === 'in-conversation') {
    if (batchedText.length < 5) {
      incrementEscalationCount(phone);
    } else {
      resetEscalationCount(phone);
    }
  }

  // Build system prompt (async — fetches calendar slots + boss context)
  const systemPrompt = await buildSystemPrompt(leadName, leadInterest, phone);

  // Fetch last 20 messages for context
  const historyRows = db
    .prepare(
      'SELECT direction, content FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 20',
    )
    .all(phone) as MessageRow[];

  historyRows.reverse();

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> =
    historyRows.map((row) => ({
      role: row.direction === 'in' ? ('user' as const) : ('assistant' as const),
      content: row.content,
    }));

  messages.push({ role: 'user', content: batchedText });

  // Call Claude
  const response = await generateResponse(messages, systemPrompt);

  const jid = phone + '@s.whatsapp.net';
  const insertMsg = db.prepare(
    'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)',
  );
  const leadId = lead?.id || null;

  let newStatus: LeadStatus | null = null;

  // ── Parse [BOOK:...] marker ──
  const bookMatch = response.match(/\[BOOK:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})\]/);
  if (bookMatch) {
    const [, date, time] = bookMatch;
    const cleanResponse = response.replace(/\[BOOK:[^\]]+\]/, '').trim();

    await sendWithTyping(sock, jid, cleanResponse);

    const result = await bookMeeting(date, time, leadName, phone, leadInterest, 'Discovery call');
    if (result.success) {
      await sendWithTyping(sock, jid, `מעולה! הפגישה נקבעה ל-${date} בשעה ${time}. אלון יתקשר אליך`);
      newStatus = 'meeting-scheduled';
      cancelFollowUps(phone);
    } else {
      await sendWithTyping(
        sock, jid,
        'סליחה, הייתה בעיה עם קביעת הפגישה. אלון יחזור אליך עם זמנים מעודכנים.',
      );
    }

    storeMessages(insertMsg, batchedMessages, phone, leadId, cleanResponse);
    updateLeadTimestamp(db, phone, lead, newStatus);
    log.info({ phone, date, time, success: result.success }, 'booking flow completed');
    return;
  }

  // ── Parse [ESCALATE] marker ──
  if (response.includes('[ESCALATE]')) {
    const cleanResponse = response.replace('[ESCALATE]', '').trim();
    await sendWithTyping(sock, jid, cleanResponse);

    storeMessages(insertMsg, batchedMessages, phone, leadId, cleanResponse);
    updateLeadTimestamp(db, phone, lead, null);

    await triggerEscalation(
      phone, leadName, messages, sock,
      lead?.monday_item_id ?? undefined,
      lead?.monday_board_id ?? undefined,
    );
    cancelFollowUps(phone);
    log.info({ phone }, 'escalation triggered from Claude marker');
    return;
  }

  // ── Process boss-mode markers (only for Alon) ──
  const isBoss = phone.endsWith('546300783');
  let finalResponse = response;

  if (isBoss) {
    finalResponse = await processBossMarkers(finalResponse, sock, jid);
  }

  // Normal flow: send response
  await sendWithTyping(sock, jid, finalResponse);

  storeMessages(insertMsg, batchedMessages, phone, leadId, finalResponse);

  // Update lead timestamp
  if (lead) {
    db.prepare("UPDATE leads SET updated_at = datetime('now') WHERE phone = ?").run(phone);
  }

  // Status progression
  if (lead) {
    if (lead.status === 'new') {
      newStatus = 'contacted';
    } else if (lead.status === 'contacted') {
      newStatus = 'in-conversation';
    }

    if (
      lead.status !== 'quote-sent' &&
      lead.status !== 'meeting-scheduled' &&
      lead.status !== 'escalated' &&
      /₪[\d,]+/.test(finalResponse)
    ) {
      newStatus = 'quote-sent';
    }

    if (newStatus) {
      db.prepare('UPDATE leads SET status = ? WHERE phone = ?').run(newStatus, phone);
      if (lead.monday_item_id && lead.monday_board_id) {
        updateMondayStatus(lead.monday_item_id, lead.monday_board_id, newStatus).catch(
          (err) => { log.error({ err, phone }, 'Monday.com status sync failed'); },
        );
      }
    }
  }

  // Schedule follow-up (skip for Alon)
  if (phone !== config.alonPhone) {
    cancelFollowUps(phone);
    const followUpTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    scheduleFollowUp(phone, 1, followUpTime);
  }

  log.info(
    { phone, batchSize: batchedMessages.length, responseLength: finalResponse.length },
    'conversation handled',
  );
}

/**
 * Process boss-mode markers in Claude's response.
 * Executes the requested action and cleans the marker from the response.
 */
async function processBossMarkers(
  response: string,
  sock: BotAdapter,
  jid: string,
): Promise<string> {
  let cleaned = response;
  const db = getDb();

  // ── [SEARCH:query] ──
  const searchMatch = cleaned.match(/\[SEARCH:([^\]]+)\]/);
  if (searchMatch) {
    const query = searchMatch[1];
    cleaned = cleaned.replace(/\[SEARCH:[^\]]+\]/, '').trim();
    const result = searchLeadContext(query);
    setTimeout(async () => {
      try { await sendWithTyping(sock, jid, `🔍 תוצאות חיפוש "${query}":\n\n${result}`); }
      catch (err) { log.error({ err }, 'Failed to send search results'); }
    }, 2000);
  }

  // ── [PREP:phone] ──
  const prepMatch = cleaned.match(/\[PREP:([^\]]+)\]/);
  if (prepMatch) {
    const targetPhone = prepMatch[1];
    cleaned = cleaned.replace(/\[PREP:[^\]]+\]/, '').trim();
    const result = getLeadConversation(targetPhone);
    setTimeout(async () => {
      try { await sendWithTyping(sock, jid, `📋 הכנה לפגישה:\n\n${result}`); }
      catch (err) { log.error({ err }, 'Failed to send prep data'); }
    }, 2000);
  }

  // ── [NOTE:phone:content] ──
  const noteMatch = cleaned.match(/\[NOTE:([^:]+):([^\]]+)\]/);
  if (noteMatch) {
    const [, targetPhone, noteContent] = noteMatch;
    cleaned = cleaned.replace(/\[NOTE:[^\]]+\]/, '').trim();
    const lead = db
      .prepare('SELECT monday_item_id FROM leads WHERE phone = ?')
      .get(targetPhone) as { monday_item_id: number | null } | undefined;

    if (lead?.monday_item_id) {
      addItemUpdate(lead.monday_item_id, noteContent).catch((err) => {
        log.error({ err }, 'Failed to add note to Monday.com');
      });
    }
  }

  // ── [CREATE_LEAD:name:phone:interest] ──
  const createMatch = cleaned.match(/\[CREATE_LEAD:([^:]+):([^:]+):([^\]]*)\]/);
  if (createMatch) {
    const [, newName, newPhone, newInterest] = createMatch;
    cleaned = cleaned.replace(/\[CREATE_LEAD:[^\]]+\]/, '').trim();

    try {
      db.prepare(
        `INSERT OR IGNORE INTO leads (phone, name, source, status, interest)
         VALUES (?, ?, 'manual', 'new', ?)`,
      ).run(newPhone, newName, newInterest || null);
    } catch (err) {
      log.error({ err }, 'Failed to create lead in DB');
    }

    createBoardItem(newName, {
      [config.mondayStatusColumnId]: 'new',
    }).catch((err) => {
      log.error({ err }, 'Failed to create lead in Monday.com');
    });
  }

  // ── [MONDAY_STATS] ──
  if (cleaned.includes('[MONDAY_STATS]')) {
    cleaned = cleaned.replace(/\[MONDAY_STATS\]/, '').trim();
    try {
      const stats = await getBoardStats();
      const statusLines = Object.entries(stats.byStatus)
        .map(([s, c]) => `  • ${s}: ${c}`)
        .join('\n');
      const groupLines = Object.entries(stats.byGroup)
        .map(([g, c]) => `  • ${g}: ${c}`)
        .join('\n');
      const recentLines = stats.recentItems
        .map((i) => `  • ${i.name} — ${i.status}`)
        .join('\n');

      const statsMsg = [
        `📊 סטטיסטיקות Monday.com (${stats.total} פריטים):`,
        '', 'לפי סטטוס:', statusLines,
        '', 'לפי קבוצה:', groupLines,
        '', 'עודכנו לאחרונה:', recentLines,
      ].join('\n');

      setTimeout(async () => {
        try { await sendWithTyping(sock, jid, statsMsg); }
        catch (err) { log.error({ err }, 'Failed to send stats'); }
      }, 2000);
    } catch (err) {
      log.error({ err }, 'Failed to get Monday stats');
    }
  }

  // ── [CLOSE:phone:won|lost] ──
  const closeMatch = cleaned.match(/\[CLOSE:([^:]+):(won|lost)\]/);
  if (closeMatch) {
    const [, targetPhone, outcome] = closeMatch;
    cleaned = cleaned.replace(/\[CLOSE:[^\]]+\]/, '').trim();
    const closeStatus = (outcome === 'won' ? 'closed-won' : 'closed-lost') as LeadStatus;

    db.prepare('UPDATE leads SET status = ? WHERE phone = ?').run(closeStatus, targetPhone);
    cancelFollowUps(targetPhone);

    const targetLead = db
      .prepare('SELECT monday_item_id, monday_board_id FROM leads WHERE phone = ?')
      .get(targetPhone) as { monday_item_id: number | null; monday_board_id: number | null } | undefined;

    if (targetLead?.monday_item_id && targetLead?.monday_board_id) {
      updateMondayStatus(targetLead.monday_item_id, targetLead.monday_board_id, closeStatus).catch(
        (err) => { log.error({ err }, 'Failed to update Monday.com close status'); },
      );
    }
  }

  return cleaned;
}

// ── Helpers ──

function storeMessages(
  insertMsg: any,
  batchedMessages: string[],
  phone: string,
  leadId: number | null,
  outResponse: string,
): void {
  for (const text of batchedMessages) {
    insertMsg.run(phone, leadId, 'in', text);
  }
  insertMsg.run(phone, leadId, 'out', outResponse);
}

function updateLeadTimestamp(
  db: any,
  phone: string,
  lead: LeadRow | undefined,
  newStatus: LeadStatus | null,
): void {
  if (!lead) return;
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

/**
 * Send a personalized first message to a new lead from Monday.com.
 */
export async function sendFirstMessage(
  phone: string,
  name: string,
  interest: string,
  sock: BotAdapter,
): Promise<void> {
  const db = getDb();

  const systemPrompt = await buildSystemPrompt(name, interest, phone);

  const introPrompt = interest
    ? `היי ${name}! ראיתי שאתה מעוניין ב${interest}. תציג את עצמך בקצרה ותשאל איך אתה יכול לעזור.`
    : `היי ${name}! תציג את עצמך בקצרה ותשאל במה הלקוח מעוניין.`;

  const response = await generateResponse(
    [{ role: 'user', content: introPrompt }],
    systemPrompt,
  );

  const jid = phone + '@s.whatsapp.net';
  await sendWithTyping(sock, jid, response);

  const lead = db
    .prepare('SELECT id FROM leads WHERE phone = ?')
    .get(phone) as { id: number } | undefined;

  db.prepare(
    'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)',
  ).run(phone, lead?.id || null, 'out', response);

  db.prepare(
    "UPDATE leads SET status = 'contacted', updated_at = datetime('now') WHERE phone = ?",
  ).run(phone);

  const fullLead = db
    .prepare('SELECT monday_item_id, monday_board_id FROM leads WHERE phone = ?')
    .get(phone) as { monday_item_id: number | null; monday_board_id: number | null } | undefined;

  if (fullLead?.monday_item_id && fullLead?.monday_board_id) {
    updateMondayStatus(fullLead.monday_item_id, fullLead.monday_board_id, 'contacted').catch(
      (err) => { log.error({ err, phone }, 'Monday.com status sync failed on first message'); },
    );
  }

  if (phone !== config.alonPhone) {
    const followUpTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    scheduleFollowUp(phone, 1, followUpTime);
  }

  log.info({ phone, name, interest }, 'first message sent');
}
