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
  const escalationCheck = isAdminPhone(phone) ? { escalate: false, reason: null } : shouldEscalate(phone, batchedText);
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
      await sendWithTyping(sock, jid, `מעולה! הפגישה נקבעה ל-${date} בשעה ${time}. ${getOwnerName()} יתקשר אליך`);
      newStatus = 'meeting-scheduled';
      cancelFollowUps(phone);
    } else {
      await sendWithTyping(
        sock, jid,
        `סליחה, הייתה בעיה עם קביעת הפגישה. ${getOwnerName()} יחזור אליך עם זמנים מעודכנים.`,
      );
    }

    storeMessages(insertMsg, batchedMessages, phone, leadId, cleanResponse);
    updateLeadTimestamp(db, phone, lead, newStatus);
    log.info({ phone, date, time, success: result.success }, 'booking flow completed');
    return;
  }

  // ── Parse [ESCALATE] marker (never escalate admin) ──
  if (response.includes('[ESCALATE]') && !isAdminPhone(phone)) {
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

  // ── Process boss-mode markers (only for admin) ──
  const isBoss = isAdminPhone(phone);
  let finalResponse = response;

  if (isBoss) {
    finalResponse = await processBossMarkers(finalResponse, sock, jid);
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

  // Update lead score
  if (lead) {
    const { score } = calculateLeadScore(phone);
    db.prepare('UPDATE leads SET score = ? WHERE phone = ?').run(score, phone);
  }

  // Schedule follow-up (skip for admin)
  if (!isAdminPhone(phone)) {
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
              'INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)',
            );
            const quoteRecord = `[שלחתי הצעת מחיר PDF ל${quoteName.trim()} — ${quoteService.trim()} — ₪${quotePrice.trim()}]`;
            insertQuoteMsg.run(targetLead.phone, null, 'out', quoteRecord);
            // Also store confirmation in boss conversation
            const bossPhone = jid.split('@')[0];
            insertQuoteMsg.run(bossPhone, null, 'out', confirmMsg);
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
      setTimeout(async () => {
        try {
          await sendWithTyping(sock, jid, `❌ לא מצאתי ליד בשם "${quoteName.trim()}" במערכת`);
        } catch (err) {
          log.error({ err }, 'Failed to send quote error');
        }
      }, 1000);
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

    (async () => {
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

        await sendWithTyping(sock, jid, lines.join('\n'));
      } catch (err) {
        log.error({ err, dateRange }, 'Failed to get Facebook report');
        await sendWithTyping(sock, jid, '❌ שגיאה בשליפת נתוני פייסבוק. בדוק שה-Access Token תקין.');
      }
    })();
  }

  // ── [FB_PAUSE:campaign_id] — Pause a Facebook campaign ──
  const fbPauseMatch = cleaned.match(/\[FB_PAUSE:([^\]]+)\]/);
  if (fbPauseMatch) {
    const campaignId = fbPauseMatch[1];
    cleaned = cleaned.replace(/\[FB_PAUSE:[^\]]+\]/, '').trim();

    (async () => {
      try {
        await pauseCampaign(campaignId);
        await sendWithTyping(sock, jid, `⏸️ קמפיין ${campaignId} הושהה בהצלחה.`);
      } catch (err) {
        log.error({ err, campaignId }, 'Failed to pause campaign');
        await sendWithTyping(sock, jid, `❌ שגיאה בהשהיית קמפיין ${campaignId}.`);
      }
    })();
  }

  // ── [FB_RESUME:campaign_id] — Resume a Facebook campaign ──
  const fbResumeMatch = cleaned.match(/\[FB_RESUME:([^\]]+)\]/);
  if (fbResumeMatch) {
    const campaignId = fbResumeMatch[1];
    cleaned = cleaned.replace(/\[FB_RESUME:[^\]]+\]/, '').trim();

    (async () => {
      try {
        await resumeCampaign(campaignId);
        await sendWithTyping(sock, jid, `▶️ קמפיין ${campaignId} הופעל מחדש בהצלחה.`);
      } catch (err) {
        log.error({ err, campaignId }, 'Failed to resume campaign');
        await sendWithTyping(sock, jid, `❌ שגיאה בהפעלת קמפיין ${campaignId}.`);
      }
    })();
  }

  // ── [FB_BUDGET:campaign_id:amount] — Update daily budget (amount in shekels) ──
  const fbBudgetMatch = cleaned.match(/\[FB_BUDGET:([^:]+):([^\]]+)\]/);
  if (fbBudgetMatch) {
    const campaignId = fbBudgetMatch[1];
    const amountShekels = parseFloat(fbBudgetMatch[2]);
    cleaned = cleaned.replace(/\[FB_BUDGET:[^\]]+\]/, '').trim();

    const budgetInAgorot = Math.round(amountShekels * 100);

    (async () => {
      try {
        await updateDailyBudget(campaignId, budgetInAgorot);
        await sendWithTyping(sock, jid, `💰 תקציב קמפיין ${campaignId} עודכן ל-₪${amountShekels}/יום.`);
      } catch (err) {
        log.error({ err, campaignId, budgetInAgorot }, 'Failed to update budget');
        await sendWithTyping(sock, jid, `❌ שגיאה בעדכון תקציב קמפיין ${campaignId}.`);
      }
    })();
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
      setTimeout(async () => {
        try { await sendWithTyping(sock, jid, '📋 אין כללים שמורים עדיין. תלמד אותי!'); }
        catch (err) { log.error({ err }, 'Failed to send rules list'); }
      }, 1500);
    } else {
      const rulesList = rules.map((r) => `  ${r.id}. ${r.rule}`).join('\n');
      setTimeout(async () => {
        try { await sendWithTyping(sock, jid, `📋 כללים שלמדתי (${rules.length}):\n\n${rulesList}\n\nלמחיקה: "תמחק כלל [מספר]"`); }
        catch (err) { log.error({ err }, 'Failed to send rules list'); }
      }, 1500);
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

  if (!isAdminPhone(phone)) {
    const followUpTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    scheduleFollowUp(phone, 1, followUpTime);
  }

  log.info({ phone, name, interest }, 'first message sent');
}
