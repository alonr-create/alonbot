import type { BotAdapter } from '../whatsapp/connection.js';
import { getDb } from '../db/index.js';
import { generateResponse, generateWithSearch } from './claude-client.js';
import { buildSystemPrompt } from './system-prompt.js';
import { sendWithTyping } from '../whatsapp/rate-limiter.js';
import type { TenantRow } from '../db/tenants.js';
import {
  updateMondayStatus,
  addItemUpdate,
  createBoardItem,
  syncChatToMonday,
  updateItemName,
} from '../monday/api.js';
import { bookMeeting } from '../calendar/api.js';
import {
  shouldEscalate,
  triggerEscalation,
  resetEscalationCount,
  incrementEscalationCount,
} from '../escalation/handler.js';
import { scheduleFollowUp, cancelFollowUps } from '../follow-up/follow-up-db.js';
import { scheduleReminder } from '../schedulers/reminders.js';
import { searchLeadContext, getLeadConversation } from './boss-context.js';
import { calculateLeadScore } from './lead-scoring.js';
import { addRule, getActiveRules, removeRule } from './bot-rules.js';
import { synthesizeSpeech } from './voice-synthesize.js';
import { generateQuotePDF } from '../quotes/generate-quote.js';
import {
  getActiveCampaigns,
  getAccountInsights,
  getAllAdAccountIds,
  pauseCampaign,
  resumeCampaign,
  updateDailyBudget,
} from '../facebook/api.js';
import type { DatePreset } from '../facebook/types.js';
import { config } from '../config.js';
import { isAdminPhone, getAdminPhone, getOwnerName, getBusinessName, getTimezone } from '../db/tenant-config.js';
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
  tenant?: TenantRow,
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

  // Check escalation BEFORE calling Claude (skip for admin — never escalate the boss)
  const escalationCheck = isAdminPhone(phone, tenant) ? { escalate: false, reason: null } : shouldEscalate(phone, batchedText);
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
      'INSERT INTO messages (phone, lead_id, direction, content, tenant_id) VALUES (?, ?, ?, ?, ?)',
    );
    const leadId = lead?.id || null;
    for (const text of batchedMessages) {
      insertMsg.run(phone, leadId, 'in', text, tenant?.id ?? null);
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
  const systemPrompt = await buildSystemPrompt(leadName, leadInterest, phone, undefined, tenant);

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

  // Call Claude — boss gets web search, leads get regular response
  let response: string;
  if (isAdminPhone(phone, tenant)) {
    const result = await generateWithSearch(messages, systemPrompt);
    response = result.text;
    if (result.searchUsed) {
      log.info({ phone }, 'web search was used for boss response');
    }
  } else {
    response = await generateResponse(messages, systemPrompt);
  }

  const jid = phone + '@s.whatsapp.net';
  const insertMsg = db.prepare(
    'INSERT INTO messages (phone, lead_id, direction, content, tenant_id) VALUES (?, ?, ?, ?, ?)',
  );
  const leadId = lead?.id || null;

  let newStatus: LeadStatus | null = null;

  // ── Parse [BOOK:...] marker ──
  const bookMatch = response.match(/\[BOOK:(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})\]/);
  if (bookMatch) {
    const [, date, time] = bookMatch;
    const cleanResponse = response.replace(/\[BOOK:[^\]]+\]/, '').trim();

    await sendWithTyping(sock, jid, cleanResponse);

    // Use tenant to determine booking strategy — falls back to legacy source_detail check
    const useVoiceAgent = tenant
      ? tenant.name === 'דקל' && !!config.voiceAgentUrl
      : (() => {
          const leadSource = lead
            ? (db.prepare('SELECT source_detail FROM leads WHERE phone = ?').get(phone) as { source_detail: string | null } | undefined)?.source_detail
            : null;
          return (leadSource === 'dekel' || leadSource === 'dekel-voice-agent') && !!config.voiceAgentUrl;
        })();

    const ownerName = tenant ? tenant.owner_name : getOwnerName();
    const tenantMondayBoardId = tenant ? tenant.monday_board_id : null;

    let bookResult: { success: boolean };
    if (useVoiceAgent) {
      // Book via Voice Agent (has Zoom + Google Calendar of Dekel)
      try {
        const vaRes = await fetch(`${config.voiceAgentUrl}/tools/book-meeting`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            args: { date, time, name: leadName, phone, meeting_type: 'הכרות' },
          }),
          signal: AbortSignal.timeout(15000),
        });
        const vaData = await vaRes.text();
        bookResult = { success: !vaData.includes('Cannot') && !vaData.includes('Error') && !vaData.includes('error') };
        log.info({ phone, date, time, result: vaData, tenant: tenant?.name }, 'Voice Agent booking');
      } catch (err) {
        log.error({ err }, 'Voice Agent booking failed');
        bookResult = { success: false };
      }
    } else {
      // Regular booking via AalonBot calendar
      bookResult = await bookMeeting(date, time, leadName, phone, leadInterest, 'Discovery call');
    }

    if (bookResult.success) {
      const meetingMsg = useVoiceAgent
        ? `מעולה! הפגישה נקבעה ל-${date} בשעה ${time}. ${ownerName} יתקשר אליך ✅`
        : `מעולה! שיחת הזום נקבעה ל-${date} בשעה ${time} 🎥 ${ownerName} ישלח לך לינק לפני הפגישה ✅`;
      await sendWithTyping(sock, jid, meetingMsg);
      newStatus = 'meeting-scheduled';
      cancelFollowUps(phone);

      // Update Monday.com — use tenant board if available, fall back to stored board
      const mondayBoardId = tenantMondayBoardId
        ? tenantMondayBoardId
        : (lead?.monday_board_id ? lead.monday_board_id : (config.mondayBoardIdDprisha ? parseInt(config.mondayBoardIdDprisha) : null));
      if (mondayBoardId && lead?.monday_item_id) {
        updateMondayStatus(lead.monday_item_id, mondayBoardId, 'meeting-scheduled').catch(
          (err) => { log.error({ err, phone }, 'Monday status sync failed after booking'); },
        );
      }
    } else {
      await sendWithTyping(
        sock, jid,
        `סליחה, הייתה בעיה עם קביעת הפגישה. ניצור איתך קשר עם זמנים מעודכנים.`,
      );
    }

    storeMessages(insertMsg, batchedMessages, phone, leadId, cleanResponse, tenant?.id ?? null);
    updateLeadTimestamp(db, phone, lead, newStatus);
    log.info({ phone, date, time, success: bookResult.success, tenant: tenant?.name }, 'booking flow completed');
    return;
  }

  // ── Parse [ESCALATE] marker (never escalate admin) ──
  if (response.includes('[ESCALATE]') && !isAdminPhone(phone, tenant)) {
    const cleanResponse = response.replace('[ESCALATE]', '').trim();
    await sendWithTyping(sock, jid, cleanResponse);

    storeMessages(insertMsg, batchedMessages, phone, leadId, cleanResponse, tenant?.id ?? null);
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

  // ── Process boss-mode markers (only for admin) ──
  const isBoss = isAdminPhone(phone, tenant);
  let finalResponse = response;

  if (isBoss) {
    finalResponse = await processBossMarkers(finalResponse, sock, jid, tenant);
  }

  // ── Parse [VOICE] marker — send voice note alongside text ──
  const wantsVoice = finalResponse.includes('[VOICE]');
  if (wantsVoice) {
    finalResponse = finalResponse.replace(/\[VOICE\]/g, '').trim();
  }

  // Normal flow: send text response
  await sendWithTyping(sock, jid, finalResponse);

  // Send voice message if requested (fire-and-forget, don't block)
  if (wantsVoice) {
    synthesizeSpeech(finalResponse).then(async (audio) => {
      if (audio) {
        try {
          await sock.sendAudio(jid, audio);
          log.info({ phone }, 'voice message sent');
        } catch (err) {
          log.error({ err, phone }, 'failed to send voice message');
        }
      }
    }).catch((err) => {
      log.error({ err, phone }, 'voice synthesis failed');
    });
  }

  storeMessages(insertMsg, batchedMessages, phone, leadId, finalResponse, tenant?.id ?? null);

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

  // Auto-detect lead name from conversation and update DB + Monday.com
  if (lead && !lead.name) {
    const nameFromMsg = extractLeadName(batchedText);
    if (nameFromMsg) {
      db.prepare('UPDATE leads SET name = ? WHERE phone = ?').run(nameFromMsg, phone);
      log.info({ phone, name: nameFromMsg }, 'Auto-detected lead name');
      if (lead.monday_item_id && lead.monday_board_id) {
        updateItemName(lead.monday_board_id, lead.monday_item_id, nameFromMsg).catch(
          (err) => { log.error({ err, phone }, 'Failed to update Monday.com item name'); },
        );
      }
    }
  }

  // Update lead score
  if (lead) {
    const { score } = calculateLeadScore(phone);
    db.prepare('UPDATE leads SET score = ? WHERE phone = ?').run(score, phone);
  }

  // Schedule follow-up (skip for admin)
  if (!isAdminPhone(phone, tenant)) {
    cancelFollowUps(phone);
    const followUpTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    scheduleFollowUp(phone, 1, followUpTime, tenant?.id);
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
  tenant?: TenantRow,
): Promise<string> {
  let cleaned = response;
  const db = getDb();

  // ── [SEARCH:query] ──
  const searchMatch = cleaned.match(/\[SEARCH:([^\]]+)\]/);
  if (searchMatch) {
    const query = searchMatch[1];
    cleaned = cleaned.replace(/\[SEARCH:[^\]]+\]/, '').trim();
    const result = searchLeadContext(query);
    cleaned += `\n\n🔍 תוצאות חיפוש "${query}":\n\n${result}`;
  }

  // ── [PREP:phone] ──
  const prepMatch = cleaned.match(/\[PREP:([^\]]+)\]/);
  if (prepMatch) {
    const targetPhone = prepMatch[1];
    cleaned = cleaned.replace(/\[PREP:[^\]]+\]/, '').trim();
    const result = getLeadConversation(targetPhone);
    cleaned += `\n\n📋 הכנה לפגישה:\n\n${result}`;
  }

  // ── [NOTE:identifier:content] — save note to DB + Monday.com ──
  const noteMatch = cleaned.match(/\[NOTE:([^:]+):([^\]]+)\]/);
  if (noteMatch) {
    const [, identifier, noteContent] = noteMatch;
    cleaned = cleaned.replace(/\[NOTE:[^\]]+\]/, '').trim();

    // Find lead by phone OR name
    const lead = db
      .prepare('SELECT phone, monday_item_id, notes FROM leads WHERE phone = ? OR name LIKE ?')
      .get(identifier, `%${identifier}%`) as { phone: string; monday_item_id: number | null; notes: string | null } | undefined;

    if (lead) {
      // Append to local notes field (persistent memory)
      const timestamp = new Date().toISOString().slice(0, 16);
      const existingNotes = lead.notes || '';
      const newNotes = existingNotes
        ? `${existingNotes}\n[${timestamp}] ${noteContent}`
        : `[${timestamp}] ${noteContent}`;
      db.prepare('UPDATE leads SET notes = ? WHERE phone = ?').run(newNotes, lead.phone);
      log.info({ phone: lead.phone, note: noteContent }, 'Note saved to lead');

      // Also push to Monday.com if connected
      if (lead.monday_item_id) {
        addItemUpdate(lead.monday_item_id, noteContent).catch((err) => {
          log.error({ err }, 'Failed to add note to Monday.com');
        });
      }
    } else {
      log.warn({ identifier }, 'NOTE: lead not found');
    }
  }

  // ── [CREATE_LEAD:name:phone:interest] ──
  const createMatch = cleaned.match(/\[CREATE_LEAD:([^:]+):([^:]+):([^\]]*)\]/);
  if (createMatch) {
    const [, newName, newPhone, newInterest] = createMatch;
    cleaned = cleaned.replace(/\[CREATE_LEAD:[^\]]+\]/, '').trim();

    try {
      db.prepare(
        `INSERT OR IGNORE INTO leads (phone, name, source, status, interest, tenant_id)
         VALUES (?, ?, 'manual', 'new', ?, ?)`,
      ).run(newPhone, newName, newInterest || null, tenant?.id ?? null);
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
      const { getAllBoardsStats, getAllBoardIds } = await import('../monday/api.js');
      const boards = getAllBoardIds();
      const allStats = await getAllBoardsStats();

      const statsParts: string[] = [];
      for (const [boardName, stats] of Object.entries(allStats)) {
        const statusLines = Object.entries(stats.byStatus)
          .map(([s, c]) => `  • ${s}: ${c}`)
          .join('\n');
        const groupLines = Object.entries(stats.byGroup)
          .map(([g, c]) => `  • ${g}: ${c}`)
          .join('\n');
        const recentLines = stats.recentItems
          .map((i) => `  • ${i.name} — ${i.status}`)
          .join('\n');

        statsParts.push([
          `━━━ ${boardName} (${stats.total} פריטים) ━━━`,
          'לפי סטטוס:', statusLines,
          '', 'לפי קבוצה:', groupLines,
          '', 'עודכנו לאחרונה:', recentLines,
        ].join('\n'));
      }

      cleaned += `\n\n📊 סטטיסטיקות Monday.com:\n\n${statsParts.join('\n\n')}`;
    } catch (err) {
      log.error({ err }, 'Failed to get Monday stats');
    }
  }

  // ── [REMINDER:HH:mm:message] — schedule a reminder for the boss ──
  const reminderMatch = cleaned.match(/\[REMINDER:(\d{2}:\d{2}):([^\]]+)\]/);
  if (reminderMatch) {
    const [, timeStr, reminderMessage] = reminderMatch;
    cleaned = cleaned.replace(/\[REMINDER:[^\]]+\]/, '').trim();

    // Parse time in tenant timezone
    const tz = getTimezone();
    const [hours, minutes] = timeStr.split(':').map(Number);
    const nowLocal = new Date(
      new Date().toLocaleString('en-US', { timeZone: tz }),
    );

    // Build scheduled date in tenant timezone for today
    const scheduledLocal = new Date(nowLocal);
    scheduledLocal.setHours(hours, minutes, 0, 0);

    // If the time already passed today, schedule for tomorrow
    if (scheduledLocal <= nowLocal) {
      scheduledLocal.setDate(scheduledLocal.getDate() + 1);
    }

    // Convert local time back to UTC for storage
    const utcNow = new Date();
    const israelNow = new Date(
      utcNow.toLocaleString('en-US', { timeZone: tz }),
    );
    const offsetMs = utcNow.getTime() - israelNow.getTime();
    const scheduledUtc = new Date(scheduledLocal.getTime() + offsetMs);

    // Extract boss phone from jid
    const bossPhone = jid.split('@')[0];
    scheduleReminder(bossPhone, reminderMessage, scheduledUtc);

    log.info(
      { time: timeStr, message: reminderMessage, scheduledUtc: scheduledUtc.toISOString() },
      'reminder scheduled via boss marker',
    );
  }

  // ── [QUOTE:name:service:price] or [QUOTE:name:service:price:url] — generate and send PDF quote ──
  const quoteMatch = cleaned.match(/\[QUOTE:([^:]+):([^:]+):([^:\]]+)(?::([^\]]+))?\]/);
  if (quoteMatch) {
    const [, quoteName, quoteService, quotePrice, quoteUrl] = quoteMatch;
    cleaned = cleaned.replace(/\[QUOTE:[^\]]+\]/, '').trim();

    // Find lead by name to get their phone
    const targetLead = db
      .prepare('SELECT phone FROM leads WHERE name LIKE ?')
      .get(`%${quoteName.trim()}%`) as { phone: string } | undefined;

    if (targetLead) {
      const targetJid = targetLead.phone + '@s.whatsapp.net';
      if (quoteUrl) {
        // Notify boss that we're scraping the website first
        sendWithTyping(sock, jid, `🔍 סורק את ${quoteUrl.trim()} למיתוג...`).catch(() => {});
      }
      generateQuotePDF(quoteName.trim(), targetLead.phone, quoteService.trim(), quotePrice.trim(), undefined, quoteUrl?.trim())
        .then(async (pdfBuffer) => {
          try {
            await sock.sendDocument(
              targetJid,
              pdfBuffer,
              `quote-${Date.now()}.pdf`,
              `הצעת מחיר מ-${getBusinessName()} — ${quoteService.trim()}`,
            );
            const confirmMsg = `✅ הצעת מחיר נשלחה ל${quoteName.trim()}!`;
            await sendWithTyping(sock, jid, confirmMsg);
            // Store quote send in conversation history so the bot remembers it
            const insertQuoteMsg = db.prepare(
              'INSERT INTO messages (phone, lead_id, direction, content, tenant_id) VALUES (?, ?, ?, ?, ?)',
            );
            const quoteRecord = `[שלחתי הצעת מחיר PDF ל${quoteName.trim()} — ${quoteService.trim()} — ₪${quotePrice.trim()}]`;
            insertQuoteMsg.run(targetLead.phone, null, 'out', quoteRecord, null);
            // Also store confirmation in boss conversation
            const bossPhone = jid.split('@')[0];
            insertQuoteMsg.run(bossPhone, null, 'out', confirmMsg, null);
            log.info({ name: quoteName, service: quoteService, price: quotePrice }, 'Quote sent');
          } catch (err) {
            log.error({ err, targetPhone: targetLead.phone }, 'Failed to send quote PDF to lead — trying to send to boss');
            // Fallback: send PDF to the boss instead
            try {
              await sock.sendDocument(
                jid,
                pdfBuffer,
                `quote-${Date.now()}.pdf`,
                `הצעת מחיר ל${quoteName.trim()} — ${quoteService.trim()} (שליחה ללקוח נכשלה, שולח לך)`,
              );
            } catch (err2) {
              log.error({ err: err2 }, 'Failed to send quote PDF to boss too');
              await sendWithTyping(sock, jid, `❌ שגיאה בשליחת הצעת המחיר — הקובץ נוצר אבל לא הצלחתי לשלוח`);
            }
          }
        })
        .catch((err) => {
          log.error({ err }, 'Failed to generate quote PDF');
        });
    } else {
      cleaned += `\n\n❌ לא מצאתי ליד בשם "${quoteName.trim()}" במערכת`;
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

  // ── [FB_REPORT:date_range] — Facebook Ads performance report ──
  const fbReportMatch = cleaned.match(/\[FB_REPORT:([^\]]+)\]/);
  if (fbReportMatch) {
    const dateRange = fbReportMatch[1] as DatePreset;
    cleaned = cleaned.replace(/\[FB_REPORT:[^\]]+\]/, '').trim();

    const dateLabels: Record<string, string> = {
      today: 'היום',
      yesterday: 'אתמול',
      last_7d: '7 ימים אחרונים',
      last_30d: '30 ימים אחרונים',
    };
    const label = dateLabels[dateRange] || dateRange;

    try {
      const accounts = getAllAdAccountIds();
      const [allInsights, campaigns, ...perAccountInsights] = await Promise.all([
        getAccountInsights(dateRange),
        getActiveCampaigns(),
        ...accounts.map((a) => getAccountInsights(dateRange, a.id)),
      ]);

      const lines: string[] = [
        `📊 דוח פרסום פייסבוק — ${label}:`,
      ];

      // Per-account breakdown
      for (let i = 0; i < accounts.length; i++) {
        const acct = accounts[i];
        const ins = perAccountInsights[i];
        const acctCampaigns = campaigns.filter((c: any) => c.accountName === acct.name);
        lines.push(
          '',
          `━━━ ${acct.name} ━━━`,
          `💰 הוצאה: ₪${ins.spend.toLocaleString('he-IL', { minimumFractionDigits: 2 })}`,
          `👁️ חשיפות: ${ins.impressions.toLocaleString('he-IL')}`,
          `👆 קליקים: ${ins.clicks.toLocaleString('he-IL')}`,
          `🎯 לידים: ${ins.leads}`,
          `💵 עלות לקליק: ${ins.clicks > 0 ? '₪' + ins.cpc.toFixed(2) : '—'}`,
          `📈 עלות לליד: ${ins.leads > 0 ? '₪' + ins.cpl.toFixed(2) : '—'}`,
        );
        if (acctCampaigns.length > 0) {
          lines.push(`🎯 קמפיינים (${acctCampaigns.length}):`);
          for (const c of acctCampaigns) {
            const budget = c.daily_budget
              ? `₪${(parseInt(c.daily_budget, 10) / 100).toFixed(0)}/יום`
              : 'ללא תקציב יומי';
            lines.push(`  • ${c.name} — ${budget}`);
          }
        }
      }

      // Total summary
      lines.push(
        '',
        `━━━ סה״כ כל החשבונות ━━━`,
        `💰 הוצאה כוללת: ₪${allInsights.spend.toLocaleString('he-IL', { minimumFractionDigits: 2 })}`,
        `🎯 לידים: ${allInsights.leads} | 👆 קליקים: ${allInsights.clicks.toLocaleString('he-IL')}`,
        `💵 CPC: ${allInsights.clicks > 0 ? '₪' + allInsights.cpc.toFixed(2) : '—'} | 📈 CPL: ${allInsights.leads > 0 ? '₪' + allInsights.cpl.toFixed(2) : '—'}`,
      );

      cleaned += `\n\n${lines.join('\n')}`;
    } catch (err) {
      log.error({ err, dateRange }, 'Failed to get Facebook report');
      cleaned += '\n\n❌ שגיאה בשליפת נתוני פייסבוק. בדוק שה-Access Token תקין.';
    }
  }

  // ── [FB_PAUSE:campaign_id] — Pause a Facebook campaign ──
  const fbPauseMatch = cleaned.match(/\[FB_PAUSE:([^\]]+)\]/);
  if (fbPauseMatch) {
    const campaignId = fbPauseMatch[1];
    cleaned = cleaned.replace(/\[FB_PAUSE:[^\]]+\]/, '').trim();

    try {
      await pauseCampaign(campaignId);
      cleaned += `\n\n⏸️ קמפיין ${campaignId} הושהה בהצלחה.`;
    } catch (err) {
      log.error({ err, campaignId }, 'Failed to pause campaign');
      cleaned += `\n\n❌ שגיאה בהשהיית קמפיין ${campaignId}.`;
    }
  }

  // ── [FB_RESUME:campaign_id] — Resume a Facebook campaign ──
  const fbResumeMatch = cleaned.match(/\[FB_RESUME:([^\]]+)\]/);
  if (fbResumeMatch) {
    const campaignId = fbResumeMatch[1];
    cleaned = cleaned.replace(/\[FB_RESUME:[^\]]+\]/, '').trim();

    try {
      await resumeCampaign(campaignId);
      cleaned += `\n\n▶️ קמפיין ${campaignId} הופעל מחדש בהצלחה.`;
    } catch (err) {
      log.error({ err, campaignId }, 'Failed to resume campaign');
      cleaned += `\n\n❌ שגיאה בהפעלת קמפיין ${campaignId}.`;
    }
  }

  // ── [FB_BUDGET:campaign_id:amount] — Update daily budget (amount in shekels) ──
  const fbBudgetMatch = cleaned.match(/\[FB_BUDGET:([^:]+):([^\]]+)\]/);
  if (fbBudgetMatch) {
    const campaignId = fbBudgetMatch[1];
    const amountShekels = parseFloat(fbBudgetMatch[2]);
    cleaned = cleaned.replace(/\[FB_BUDGET:[^\]]+\]/, '').trim();

    const budgetInAgorot = Math.round(amountShekels * 100);

    try {
      await updateDailyBudget(campaignId, budgetInAgorot);
      cleaned += `\n\n💰 תקציב קמפיין ${campaignId} עודכן ל-₪${amountShekels}/יום.`;
    } catch (err) {
      log.error({ err, campaignId, budgetInAgorot }, 'Failed to update budget');
      cleaned += `\n\n❌ שגיאה בעדכון תקציב קמפיין ${campaignId}.`;
    }
  }

  // ── [CALL:name:topic] — trigger Voice Agent outbound call to a lead ──
  const callMatch = cleaned.match(/\[CALL:([^:]+):([^\]]+)\]/);
  if (callMatch) {
    const [, targetName, topic] = callMatch;
    cleaned = cleaned.replace(/\[CALL:[^\]]+\]/, '').trim();

    // Find lead by name
    const targetLead = db
      .prepare('SELECT phone, name, monday_item_id FROM leads WHERE name LIKE ?')
      .get(`%${targetName.trim()}%`) as { phone: string; name: string; monday_item_id: number | null } | undefined;

    if (targetLead && config.voiceAgentUrl) {
      try {
        const callRes = await fetch(`${config.voiceAgentUrl}/api/outbound-call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            itemId: targetLead.monday_item_id,
            name: targetLead.name,
            phone: targetLead.phone,
            callMode: topic.trim(),
          }),
          signal: AbortSignal.timeout(15000),
        });
        const callData = await callRes.json() as { callId?: string; call_id?: string; error?: string };
        if (callData.callId || callData.call_id) {
          cleaned += `\n\n📞 מתקשרת ל${targetLead.name} (${targetLead.phone}) עכשיו! נושא: ${topic.trim()}`;
          log.info({ name: targetLead.name, phone: targetLead.phone, topic: topic.trim() }, 'Voice Agent call initiated by boss');
        } else {
          cleaned += `\n\n❌ לא הצלחתי להתקשר ל${targetLead.name}: ${callData.error || 'שגיאה לא ידועה'}`;
          log.warn({ name: targetLead.name, error: callData.error }, 'Voice Agent call failed');
        }
      } catch (err) {
        log.error({ err, name: targetLead.name }, 'Voice Agent call request failed');
        cleaned += `\n\n❌ שגיאה בחיבור ל-Voice Agent`;
      }
    } else if (!targetLead) {
      cleaned += `\n\n❌ לא מצאתי ליד בשם "${targetName.trim()}" במערכת. אפשר לחפש בשם אחר?`;
    } else {
      cleaned += `\n\n❌ Voice Agent לא מוגדר — לא ניתן להתקשר`;
    }
  }

  // ── [BROWSE:task] — computer use agent (browse + screenshot + analyze) ──
  const browseMatch = cleaned.match(/\[BROWSE:([^\]]+)\]/);
  if (browseMatch) {
    const task = browseMatch[1].trim();
    cleaned = cleaned.replace(/\[BROWSE:[^\]]+\]/, '').trim();

    // Detect "screenshot desktop/screen" requests (no URL = capture local screen)
    const isDesktopScreenshot = !task.match(/https?:\/\//) &&
      /screenshot|screen.?capture|desktop|צלם|מסך/i.test(task);

    if (isDesktopScreenshot) {
      // macOS screencapture — take a real screenshot of the desktop
      import('child_process').then(({ execSync }) => {
        try {
          const tmpPath = `/tmp/screenshot-${Date.now()}.png`;
          execSync(`screencapture -x ${tmpPath}`, { timeout: 5000 });
          import('fs').then(({ readFileSync, unlinkSync }) => {
            const screenshotBuf = readFileSync(tmpPath);
            try { unlinkSync(tmpPath); } catch {}
            sock.sendImage(jid, screenshotBuf, '🖥️ צילום מסך').then(() => {
              log.info('desktop screenshot sent');
            }).catch((err: any) => {
              log.error({ err }, 'failed to send desktop screenshot');
            });
          });
        } catch (err) {
          log.error({ err }, 'screencapture failed');
          sendWithTyping(sock, jid, '❌ לא הצלחתי לצלם מסך — ייתכן שחסרות הרשאות').catch(() => {});
        }
      });
    } else {
    // Extract URL from task if present
    const urlMatch = task.match(/https?:\/\/[^\s]+/);
    const startUrl = urlMatch ? urlMatch[0] : undefined;

    // Fire-and-forget: acknowledge immediately, run in background
    import('../browser/computer-use.js').then(({ runComputerUse }) => {
      sendWithTyping(sock, jid, '🖥️ מתחיל לגלוש...').catch(() => {});

      runComputerUse({
        task,
        startUrl,
        maxSteps: 10,
        timeoutMs: 90_000,
        onScreenshot: async (screenshot, desc) => {
          try {
            await sock.sendImage(jid, screenshot, `🖥️ ${desc}`);
          } catch (err) {
            log.error({ err }, 'failed to send progress screenshot');
          }
        },
      }).then(async (result) => {
        const summaryMsg = `✅ סיימתי (${result.steps} צעדים):\n\n${result.summary}`;
        await sendWithTyping(sock, jid, summaryMsg);

        // Send final screenshots (last 2)
        for (const screenshot of result.screenshots.slice(-2)) {
          try {
            await sock.sendImage(jid, screenshot);
          } catch (err) {
            log.error({ err }, 'failed to send final screenshot');
          }
        }

        // Store in conversation history
        const bossPhone = jid.split('@')[0];
        const insertBrowse = db.prepare(
          'INSERT INTO messages (phone, lead_id, direction, content, tenant_id) VALUES (?, ?, ?, ?, ?)',
        );
        insertBrowse.run(bossPhone, null, 'out', `[BROWSE completed: ${task}]\n${result.summary}`, null);

        log.info({ task, steps: result.steps, tokens: result.tokensUsed }, 'browse task completed');
      }).catch(async (err) => {
        log.error({ err, task }, 'browse task failed');
        await sendWithTyping(sock, jid, `❌ הגלישה נכשלה: ${err.message}`);
      });
    });
    } // end else (not desktop screenshot)
  }

  // ── [RULE:content] — boss teaches the bot a new rule ──
  const ruleMatch = cleaned.match(/\[RULE:([^\]]+)\]/);
  if (ruleMatch) {
    const ruleText = ruleMatch[1].trim();
    cleaned = cleaned.replace(/\[RULE:[^\]]+\]/, '').trim();
    addRule(ruleText);
    log.info({ rule: ruleText }, 'boss added new rule');
  }

  // ── [REMOVE_RULE:id] — boss removes a rule ──
  const removeRuleMatch = cleaned.match(/\[REMOVE_RULE:(\d+)\]/);
  if (removeRuleMatch) {
    const ruleId = parseInt(removeRuleMatch[1], 10);
    cleaned = cleaned.replace(/\[REMOVE_RULE:\d+\]/, '').trim();
    removeRule(ruleId);
    log.info({ ruleId }, 'boss removed rule');
  }

  // ── [LIST_RULES] — boss wants to see all rules ──
  if (cleaned.includes('[LIST_RULES]')) {
    cleaned = cleaned.replace(/\[LIST_RULES\]/, '').trim();
    const rules = getActiveRules();
    if (rules.length === 0) {
      cleaned += '\n\n📋 אין כללים שמורים עדיין. תלמד אותי!';
    } else {
      const rulesList = rules.map((r) => `  ${r.id}. ${r.rule}`).join('\n');
      cleaned += `\n\n📋 כללים שלמדתי (${rules.length}):\n\n${rulesList}\n\nלמחיקה: "תמחק כלל [מספר]"`;
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
  tenantId: number | null = null,
): void {
  for (const text of batchedMessages) {
    insertMsg.run(phone, leadId, 'in', text, tenantId);
  }
  insertMsg.run(phone, leadId, 'out', outResponse, tenantId);

  // Sync chat to Monday.com (fire-and-forget, non-blocking)
  if (!isAdminPhone(phone)) {
    const db = getDb();
    const lead = db
      .prepare('SELECT monday_item_id, name FROM leads WHERE phone = ?')
      .get(phone) as { monday_item_id: number | null; name: string | null } | undefined;
    if (lead?.monday_item_id) {
      syncChatToMonday(lead.monday_item_id, batchedMessages, outResponse, lead.name || undefined).catch(
        (err) => { log.error({ err, phone }, 'Monday chat sync failed'); },
      );
    }
  }
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
 * Try to extract a lead's name from their message text.
 * Looks for common Hebrew/English patterns like "שמי X", "אני X", "קוראים לי X".
 */
function extractLeadName(text: string): string | null {
  const patterns = [
    /(?:שמי|אני|קוראים לי|השם שלי)\s+([א-ת]{2,}(?:\s+[א-ת]{2,})?)/,
    /(?:my name is|i'm|i am)\s+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const name = match[1].trim();
      // Filter out common non-name words
      const ignore = ['מעוניין', 'רוצה', 'צריך', 'מחפש', 'בעל', 'עובד', 'גר', 'פה', 'כאן', 'בא'];
      if (!ignore.includes(name)) return name;
    }
  }
  return null;
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

  // Check if lead has source info (campaign tracking)
  const leadRow = db
    .prepare('SELECT source_detail FROM leads WHERE phone = ?')
    .get(phone) as { source_detail: string | null } | undefined;
  const sourceDetail = leadRow?.source_detail || '';

  // Build a tailored intro prompt based on context
  let introPrompt: string;
  if (interest && sourceDetail) {
    introPrompt = `הליד ${name} הגיע מ: ${sourceDetail} ומתעניין ב: ${interest}. שלח הודעה ראשונה חמה וקצרה — הכר בעניין שלו, הצג את עצמך בקצרה, ותן ערך מיידי (טיפ קטן או תובנה רלוונטית). סיים עם שאלה שמקדמת את השיחה.`;
  } else if (interest) {
    introPrompt = `הליד ${name} מתעניין ב: ${interest}. שלח הודעה ראשונה חמה וקצרה — הצג את עצמך, תן ערך מיידי, ושאל שאלה ממוקדת כדי להבין מה בדיוק הוא צריך.`;
  } else {
    introPrompt = `הליד ${name} נרשם ורוצה לשמוע עוד. שלח הודעה ראשונה חמה וקצרה — הצג את עצמך ושאל במה הוא מתעניין ומה הוא מחפש.`;
  }

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
    'INSERT INTO messages (phone, lead_id, direction, content, tenant_id) VALUES (?, ?, ?, ?, ?)',
  ).run(phone, lead?.id || null, 'out', response, null);

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

  if (!isAdminPhone(phone)) {
    const followUpTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    scheduleFollowUp(phone, 1, followUpTime);
  }

  log.info({ phone, name, interest }, 'first message sent');
}
