import { db } from '../utils/db.js';
import { LEAD_STATUS } from '../utils/lead-status.js';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('no-show');

const ALON_DEV_BOARD_ID = 5092777389;

/** Return current Israel time as ISO string for SQLite (handles DST automatically) */
function nowIsrael(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}

// ── No-Show Detection Settings ──
const NO_SHOW_BUFFER_MIN = 10;   // minutes after meeting end to wait before marking no-show
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const AUTO_NOSHOW_TIMEOUT_MIN = 120; // 2 hours — if Alon doesn't respond, auto-trigger no-show
const REMINDER_AFTER_MIN = 60; // send reminder after 1 hour if no button press

// ── Reschedule Messages ──
// Immediate + follow-up sequence at days 3, 6, 7, 12, 16, 17
const RESCHEDULE_MESSAGES = [
  {
    delay_min: 0, // immediately on no-show detection
    message: 'היי {name}! ראינו שלא הספקת להגיע לפגישה שקבענו 🙂 קורה לכולם! רוצה לקבוע מחדש? שלח/י מתי נוח ונסגור.',
  },
  {
    delay_min: 3 * 24 * 60, // day 3
    message: 'שלום {name}, רציתי לבדוק — נוח לך לקבוע את הפגישה שלנו ליום אחר? אני זמין השבוע 📅 שלח/י מתי נוח ונסגור!',
  },
  {
    delay_min: 6 * 24 * 60, // day 6
    message: 'היי {name}, רק רציתי לוודא שלא פספסת — הפגישה שלנו עדיין רלוונטית? 15 דקות, בלי התחייבות. שלח/י "כן" ונתאם 🎯',
  },
  {
    delay_min: 7 * 24 * 60, // day 7
    message: 'היי {name}, שבוע עבר מאז ששוחחנו 😊 עדיין מעוניין/ת? אני פה לכל שאלה. שלח/י הודעה ונקבע זמן חדש.',
  },
  {
    delay_min: 12 * 24 * 60, // day 12
    message: 'שלום {name}, חזרתי לבדוק 🙂 אם עדיין רלוונטי — 15 דקות שיחה יכולות לחסוך לך המון זמן וכסף. מתי נוח?',
  },
  {
    delay_min: 16 * 24 * 60, // day 16
    message: 'היי {name}! הזדמנות אחרונה 🚀 אני פותח כמה מקומות לשיחת ייעוץ חינמית השבוע. רוצה לתפוס מקום?',
  },
  {
    delay_min: 17 * 24 * 60, // day 17 — final
    message: 'שלום {name}, רק רציתי להגיד — אם בעתיד תרצה/י לדבר, אני תמיד פה 😊 בהצלחה!',
  },
];

// ── Record a Meeting ──
export function recordMeeting(opts: {
  phone: string;
  leadName?: string;
  meetingTime: string; // ISO datetime
  durationMin?: number;
  meetingLink?: string;
  calendarEventId?: string;
}): number {
  const existing = db.prepare(
    `SELECT id FROM meetings WHERE phone = ? AND meeting_time = ? AND status = 'scheduled'`
  ).get(opts.phone, opts.meetingTime) as any;

  if (existing) {
    log.debug({ phone: opts.phone }, 'meeting already recorded');
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO meetings (phone, lead_name, meeting_time, duration_min, meeting_link, calendar_event_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.phone,
    opts.leadName || null,
    opts.meetingTime,
    opts.durationMin || 15,
    opts.meetingLink || null,
    opts.calendarEventId || null
  );

  log.info({ phone: opts.phone, meetingTime: opts.meetingTime }, 'meeting recorded');
  return result.lastInsertRowid as number;
}

// ── Mark Meeting as Completed ──
export function markMeetingCompleted(phone: string) {
  db.prepare(`
    UPDATE meetings SET status = 'completed', updated_at = ?
    WHERE phone = ? AND status = 'scheduled'
    ORDER BY meeting_time DESC LIMIT 1
  `).run(nowIsrael(), phone);
}

// ── Check for No-Shows ──
async function checkNoShows() {
  // Find meetings that ended more than NO_SHOW_BUFFER_MIN minutes ago and are still 'scheduled'
  const overdueMeetings = db.prepare(`
    SELECT m.*, l.monday_item_id, l.source, l.lead_status
    FROM meetings m
    LEFT JOIN leads l ON l.phone = m.phone
    WHERE m.status = 'scheduled'
      AND m.no_show_handled = 0
      AND datetime(m.meeting_time, '+' || m.duration_min || ' minutes', '+${NO_SHOW_BUFFER_MIN} minutes') < ?
  `).all(nowIsrael()) as any[];

  if (!overdueMeetings.length) return;

  log.info({ count: overdueMeetings.length }, 'checking overdue meetings');

  for (const meeting of overdueMeetings) {
    try {
      // Mark as handled and record when we asked — for auto-timeout
      const now = nowIsrael();
      db.prepare(`UPDATE meetings SET no_show_handled = 1, asked_at = ?, updated_at = ? WHERE id = ?`).run(now, now, meeting.id);

      // Ask Alon via Telegram with inline buttons
      await askAlonAboutMeeting(meeting);
    } catch (e: any) {
      log.error({ phone: meeting.phone, err: e.message }, 'meeting check failed');
    }
  }

  // ── Auto-timeout: meetings where Alon never pressed a button ──
  // After REMINDER_AFTER_MIN, send a reminder
  const needsReminder = db.prepare(`
    SELECT m.*, l.monday_item_id, l.source, l.lead_status
    FROM meetings m
    LEFT JOIN leads l ON l.phone = m.phone
    WHERE m.status = 'scheduled'
      AND m.no_show_handled = 1
      AND m.asked_at IS NOT NULL
      AND datetime(m.asked_at, '+${REMINDER_AFTER_MIN} minutes') < ?
      AND datetime(m.asked_at, '+${AUTO_NOSHOW_TIMEOUT_MIN} minutes') > ?
  `).all(nowIsrael(), nowIsrael()) as any[];

  for (const meeting of needsReminder) {
    // Check if we already sent a reminder (avoid spam)
    const alreadyReminded = db.prepare(
      `SELECT 1 FROM scheduled_messages WHERE label = ? AND sent = 1`
    ).get(`reminder-ask-${meeting.id}`);
    if (alreadyReminded) continue;

    // Mark reminder as sent
    db.prepare(
      `INSERT OR IGNORE INTO scheduled_messages (label, message, send_at, channel, target_id, sent) VALUES (?, '', ?, 'internal', ?, 1)`
    ).run(`reminder-ask-${meeting.id}`, nowIsrael(), meeting.phone);

    await askAlonAboutMeeting(meeting, true); // isReminder = true
    log.info({ meetingId: meeting.id, phone: meeting.phone }, 'sent reminder — Alon hasn\'t responded');
  }

  // After AUTO_NOSHOW_TIMEOUT_MIN, auto-trigger no-show flow
  const timedOut = db.prepare(`
    SELECT m.*, l.monday_item_id, l.source, l.lead_status
    FROM meetings m
    LEFT JOIN leads l ON l.phone = m.phone
    WHERE m.status = 'scheduled'
      AND m.no_show_handled = 1
      AND m.asked_at IS NOT NULL
      AND datetime(m.asked_at, '+${AUTO_NOSHOW_TIMEOUT_MIN} minutes') < ?
  `).all(nowIsrael()) as any[];

  for (const meeting of timedOut) {
    log.warn({ meetingId: meeting.id, phone: meeting.phone }, 'auto-triggering no-show — Alon never responded after 2h');
    await handleNoShow(meeting);

    // Notify Alon that it was auto-handled
    try {
      const botToken = config.telegramBotToken;
      if (botToken) {
        const name = meeting.lead_name || meeting.phone;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: '546585625',
            text: `⏰ *אוטומטי* — לא לחצת תוך שעתיים, אז סימנתי את *${name}* כלא הופיע והפעלתי סדרת פולואפ.`,
            parse_mode: 'Markdown',
          }),
        });
      }
    } catch { /* not critical */ }
  }
}

// ── Ask Alon via Telegram ──
async function askAlonAboutMeeting(meeting: any, isReminder = false) {
  const botToken = config.telegramBotToken;
  if (!botToken) return;

  const telegramChatId = '546585625'; // Alon's Telegram chat ID
  const name = meeting.lead_name || meeting.phone;
  const timeStr = new Date(meeting.meeting_time).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });

  const text = isReminder
    ? `🔔 *תזכורת* — עדיין לא עניתי על הפגישה עם *${name}* (${timeStr}).\nאם לא תלחץ תוך שעה, אסמן אוטומטית כלא הופיע ואפעיל פולואפ.`
    : `📅 הפגישה עם *${name}* (${timeStr}) נגמרה — הגיע?`;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ הגיע', callback_data: `meeting_show:${meeting.id}` },
            { text: '❌ לא הגיע', callback_data: `meeting_noshow:${meeting.id}` },
          ]],
        },
      }),
    });
    log.info({ phone: meeting.phone, meetingId: meeting.id, isReminder }, 'asked Alon about meeting attendance');
  } catch (e: any) {
    log.warn({ err: e.message }, 'failed to send meeting attendance question');
  }
}

// ── Handle Telegram Callback (button press) ──
export async function handleMeetingCallback(callbackData: string, callbackQueryId: string) {
  const botToken = config.telegramBotToken;

  const [action, idStr] = callbackData.split(':');

  // ── Exhausted reschedule callbacks ──
  if (action === 'noshow_call' || action === 'noshow_close') {
    const phone = idStr;
    if (action === 'noshow_close') {
      db.prepare(`UPDATE leads SET lead_status = '${LEAD_STATUS.NOT_RELEVANT}', next_followup = NULL, bot_paused = 1, updated_at = ? WHERE phone = ?`).run(nowIsrael(), phone);
      log.info({ phone }, 'no-show lead marked as not relevant');
    }
    if (botToken) {
      const text = action === 'noshow_call' ? '📞 תתקשר ידנית!' : '🗑️ סומן כלא רלוונטי';
      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
    }
    return;
  }

  // ── Meeting attendance callbacks ──
  const meetingId = parseInt(idStr, 10);
  if (isNaN(meetingId)) return;

  const meeting = db.prepare(`
    SELECT m.*, l.monday_item_id, l.source, l.lead_status
    FROM meetings m
    LEFT JOIN leads l ON l.phone = m.phone
    WHERE m.id = ?
  `).get(meetingId) as any;

  if (!meeting) return;

  if (action === 'meeting_show') {
    // Lead showed up — mark completed
    const now = nowIsrael();
    db.prepare(`UPDATE meetings SET status = 'completed', updated_at = ? WHERE id = ?`).run(now, meetingId);
    db.prepare(`UPDATE leads SET lead_status = 'interested', updated_at = ? WHERE phone = ?`).run(now, meeting.phone);

    // Cancel any pending reschedule messages (in case auto-timeout already started the flow)
    cancelRescheduleMessages(meeting.phone);

    // Answer callback
    if (botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text: '✅ מצוין! סומן כהגיע' }),
      });
    }
    log.info({ phone: meeting.phone }, 'meeting marked as completed (attended)');

  } else if (action === 'meeting_noshow') {
    // Lead didn't show — trigger no-show flow
    await handleNoShow(meeting);

    // Answer callback
    if (botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text: '❌ סדרת פולואפ לקביעה מחדש הופעלה' }),
      });
    }
  }
}

// ── Handle No-Show Flow ──
async function handleNoShow(meeting: any) {
  const phone = meeting.phone;
  const name = meeting.lead_name || 'שלום';

  log.info({ phone, name, meetingTime: meeting.meeting_time }, 'NO-SHOW detected — starting reschedule flow');

  const now = nowIsrael();

  // 1. Update meeting status
  db.prepare(`UPDATE meetings SET status = 'no_show', no_show_handled = 1, updated_at = ? WHERE id = ?`).run(now, meeting.id);

  // 2. Update lead status + CLEAR follow-up scheduling (prevent follow-up engine from interfering)
  db.prepare(`UPDATE leads SET lead_status = '${LEAD_STATUS.NO_SHOW}', next_followup = NULL, updated_at = ? WHERE phone = ?`).run(now, phone);

  // 3. Record status change
  db.prepare(`INSERT INTO status_history (phone, old_status, new_status) VALUES (?, ?, ?)`).run(
    phone, meeting.lead_status || 'booked', LEAD_STATUS.NO_SHOW
  );

  // 4. Update Monday.com status
  if (meeting.monday_item_id && config.mondayApiKey) {
    try {
      // Change status column to "לא הופיע - לקבוע מחדש"
      const mutation = `mutation {
        change_simple_column_value(
          item_id: ${meeting.monday_item_id},
          board_id: ${ALON_DEV_BOARD_ID},
          column_id: "status",
          value: "לא הופיע - לקבוע מחדש"
        ) { id }
      }`;

      const resp = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
        body: JSON.stringify({ query: mutation }),
      });

      if (resp.ok) {
        const data = await resp.json() as any;
        if (data.errors) {
          // Try with column value JSON format instead
          const mutation2 = `mutation {
            change_column_value(
              item_id: ${meeting.monday_item_id},
              board_id: ${ALON_DEV_BOARD_ID},
              column_id: "status",
              value: "${JSON.stringify({ label: 'לא הופיע - לקבוע מחדש' }).replace(/"/g, '\\"')}"
            ) { id }
          }`;
          await fetch('https://api.monday.com/v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
            body: JSON.stringify({ query: mutation2 }),
          });
        }
        log.info({ phone, mondayItemId: meeting.monday_item_id }, 'Monday.com status updated to no-show');
      }

      // Also add an update/comment
      const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
      const updateBody = `⚠️ לא הופיע לפגישה (${timestamp})\\nמתחילים סדרת פולואפ לקביעה מחדש`;
      await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
        body: JSON.stringify({
          query: `mutation { create_update(item_id: ${meeting.monday_item_id}, body: "${updateBody}") { id } }`,
        }),
      });
    } catch (e: any) {
      log.warn({ phone, err: e.message }, 'Monday.com no-show update failed');
    }
  }

  // 5. Send first reschedule message immediately
  const firstMsg = RESCHEDULE_MESSAGES[0].message.replace(/\{name\}/g, name);
  try {
    await sendWhatsAppText(phone, firstMsg);
    log.info({ phone }, 'reschedule message #1 sent');
  } catch (e: any) {
    log.error({ phone, err: e.message }, 'reschedule message #1 failed');
  }

  // 6. Schedule follow-up reschedule messages
  for (let i = 1; i < RESCHEDULE_MESSAGES.length; i++) {
    const tmpl = RESCHEDULE_MESSAGES[i];
    const msg = tmpl.message.replace(/\{name\}/g, name);
    const sendAt = new Date(Date.now() + tmpl.delay_min * 60 * 1000).toISOString();

    db.prepare(`
      INSERT INTO scheduled_messages (label, message, send_at, channel, target_id)
      VALUES (?, ?, ?, 'whatsapp', ?)
    `).run(`reschedule-${phone}-${i + 1}`, msg, sendAt, phone);

    log.info({ phone, messageNum: i + 1, sendAt }, 'reschedule message scheduled');
  }

  // 7. Notify Alon via Telegram
  try {
    const { sendPushNotification } = await import('./server.js');
    sendPushNotification({
      title: `⚠️ לא הופיע: ${name}`,
      body: `${name} לא הגיע לפגישה. סדרת פולואפ לקביעה מחדש הופעלה.`,
      tag: 'no-show',
    });
  } catch { /* push not available */ }

  // Also send Telegram notification
  try {
    const telegramChatId = '546585625'; // Alon's Telegram chat ID
    const botToken = config.telegramBotToken;
    if (botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: `⚠️ *לא הופיע לפגישה*\n\n👤 ${name}\n📞 ${phone}\n🕐 ${meeting.meeting_time}\n\n✅ סטטוס Monday עודכן\n📨 סדרת פולואפ לקביעה מחדש הופעלה (3 הודעות)`,
          parse_mode: 'Markdown',
        }),
      });
    }
  } catch { /* Telegram notification not critical */ }
}

// ── Scheduled Messages Processor ──
// Process pending scheduled_messages (used for delayed reschedule messages)
async function processScheduledMessages() {
  const pending = db.prepare(`
    SELECT * FROM scheduled_messages
    WHERE sent = 0 AND send_at <= ?
    ORDER BY send_at ASC
    LIMIT 10
  `).all(nowIsrael()) as any[];

  for (const msg of pending) {
    try {
      if (msg.channel === 'whatsapp') {
        // Check if lead replied since we scheduled this — if so, skip
        const recentReply = db.prepare(`
          SELECT COUNT(*) as c FROM messages
          WHERE sender_id = ? AND role = 'user'
            AND channel IN ('whatsapp', 'whatsapp-inbound')
            AND created_at > ?
        `).get(msg.target_id, msg.created_at) as any;

        if (recentReply.c > 0) {
          log.info({ phone: msg.target_id, label: msg.label }, 'lead replied — skipping scheduled reschedule');
          db.prepare('UPDATE scheduled_messages SET sent = 1 WHERE id = ?').run(msg.id);
          continue;
        }

        await sendWhatsAppText(msg.target_id, msg.message);
      }

      db.prepare('UPDATE scheduled_messages SET sent = 1 WHERE id = ?').run(msg.id);
      log.info({ label: msg.label, target: msg.target_id }, 'scheduled message sent');

      // Check if this was the LAST reschedule message — alert Alon
      if (msg.label?.startsWith('reschedule-') && msg.label.endsWith('-7')) {
        const lead = db.prepare('SELECT name FROM leads WHERE phone = ?').get(msg.target_id) as any;
        const leadName = lead?.name || msg.target_id;
        log.warn({ phone: msg.target_id }, 'all reschedule attempts exhausted — no response');

        try {
          const botToken = config.telegramBotToken;
          if (botToken) {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: '546585625',
                text: `🚨 *מיצינו את כל הניסיונות* עם *${leadName}* (${msg.target_id})\n\n7 הודעות reschedule נשלחו בלי תגובה.\nהליד נשאר בסטטוס no\\_show.\n\nמה לעשות?`,
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [[
                    { text: '📞 להתקשר ידנית', callback_data: `noshow_call:${msg.target_id}` },
                    { text: '🗑️ לא רלוונטי', callback_data: `noshow_close:${msg.target_id}` },
                  ]],
                },
              }),
            });
          }
        } catch { /* not critical */ }
      }
    } catch (e: any) {
      log.error({ id: msg.id, err: e.message }, 'scheduled message send failed');
    }
  }
}

// ── WhatsApp Send Helper ──
async function sendWhatsAppText(phone: string, text: string) {
  const token = config.waCloudToken;
  const phoneId = config.waCloudPhoneId;
  if (!token || !phoneId) throw new Error('Cloud API not configured');

  const to = phone.replace(/\D/g, '');
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`WhatsApp API error: ${resp.status} ${err}`);
  }

  // Log to DB (Israel time)
  db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)").run(phone, text, nowIsrael());
}

// ── Cancel Reschedule Messages ──
// Called when a lead replies (to stop further reschedule messages)
export function cancelRescheduleMessages(phone: string) {
  const cancelled = db.prepare(`
    UPDATE scheduled_messages SET sent = 1
    WHERE target_id = ? AND sent = 0 AND label LIKE 'reschedule-%'
  `).run(phone);

  if (cancelled.changes > 0) {
    log.info({ phone, count: cancelled.changes }, 'cancelled pending reschedule messages — lead replied');
  }
}

// ── Start No-Show Cron ──
export function startNoShowEngine() {
  // Run check immediately then every 5 minutes
  setTimeout(() => {
    checkNoShows().catch(e => log.error({ err: e.message }, 'no-show check failed'));
    processScheduledMessages().catch(e => log.error({ err: e.message }, 'scheduled messages check failed'));
  }, 10000); // 10 sec after startup

  setInterval(async () => {
    try {
      await checkNoShows();
      await processScheduledMessages();
    } catch (e: any) {
      log.error({ err: e.message }, 'no-show engine cycle failed');
    }
  }, CHECK_INTERVAL_MS);

  log.info({ intervalMin: CHECK_INTERVAL_MS / 60000, bufferMin: NO_SHOW_BUFFER_MIN }, 'no-show engine started');
}
