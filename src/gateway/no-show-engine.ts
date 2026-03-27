import { db } from '../utils/db.js';
import { LEAD_STATUS } from '../utils/lead-status.js';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('no-show');

const ALON_DEV_BOARD_ID = 5092777389;

// ── No-Show Detection Settings ──
const NO_SHOW_BUFFER_MIN = 10;   // minutes after meeting end to wait before marking no-show
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

// ── Reschedule Messages ──
const RESCHEDULE_MESSAGES = [
  {
    delay_min: 0, // immediately on no-show detection
    message: 'היי {name}! ראינו שלא הספקת להגיע לפגישה שקבענו 🙂 קורה לכולם! רוצה לקבוע מחדש? תבחר/י זמן ואני אסדר הכל.',
  },
  {
    delay_min: 180, // 3 hours later
    message: 'שלום {name}, רציתי לבדוק — נוח לך לקבוע את הפגישה שלנו ליום אחר? אני זמין השבוע, שלח/י מתי נוח ונסגור 📅',
  },
  {
    delay_min: 24 * 60, // next day
    message: 'היי {name}, רק רציתי לוודא שלא פספסת — הפגישה שלנו עדיין רלוונטית? 15 דקות בזום, בלי התחייבות. שלח/י "כן" ונתאם 🎯',
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
    UPDATE meetings SET status = 'completed', updated_at = datetime('now')
    WHERE phone = ? AND status = 'scheduled'
    ORDER BY meeting_time DESC LIMIT 1
  `).run(phone);
}

// ── Check for No-Shows ──
async function checkNoShows() {
  // Find meetings that ended more than NO_SHOW_BUFFER_MIN minutes ago and are still 'scheduled'
  const overdueMeetings = db.prepare(`
    SELECT m.*, l.monday_item_id, l.source
    FROM meetings m
    LEFT JOIN leads l ON l.phone = m.phone
    WHERE m.status = 'scheduled'
      AND m.no_show_handled = 0
      AND datetime(m.meeting_time, '+' || m.duration_min || ' minutes', '+${NO_SHOW_BUFFER_MIN} minutes') < datetime('now')
  `).all() as any[];

  if (!overdueMeetings.length) return;

  log.info({ count: overdueMeetings.length }, 'checking overdue meetings for no-shows');

  for (const meeting of overdueMeetings) {
    try {
      // Check if lead had any WhatsApp activity during/after meeting time
      const meetingStart = meeting.meeting_time;
      const recentActivity = db.prepare(`
        SELECT COUNT(*) as c FROM messages
        WHERE sender_id = ? AND role = 'user'
          AND channel IN ('whatsapp', 'whatsapp-inbound')
          AND created_at > ?
      `).get(meeting.phone, meetingStart) as any;

      if (recentActivity.c > 0) {
        // Lead was active — might have attended or at least communicated
        log.info({ phone: meeting.phone }, 'lead had activity — skipping no-show');
        db.prepare(`UPDATE meetings SET status = 'completed', updated_at = datetime('now') WHERE id = ?`).run(meeting.id);
        continue;
      }

      // ── NO-SHOW DETECTED ──
      await handleNoShow(meeting);
    } catch (e: any) {
      log.error({ phone: meeting.phone, err: e.message }, 'no-show check failed');
    }
  }
}

// ── Handle No-Show Flow ──
async function handleNoShow(meeting: any) {
  const phone = meeting.phone;
  const name = meeting.lead_name || 'שלום';

  log.info({ phone, name, meetingTime: meeting.meeting_time }, 'NO-SHOW detected — starting reschedule flow');

  // 1. Update meeting status
  db.prepare(`UPDATE meetings SET status = 'no_show', no_show_handled = 1, updated_at = datetime('now') WHERE id = ?`).run(meeting.id);

  // 2. Update lead status in local DB
  db.prepare(`UPDATE leads SET lead_status = '${LEAD_STATUS.NO_SHOW}', updated_at = datetime('now') WHERE phone = ?`).run(phone);

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
    WHERE sent = 0 AND send_at <= datetime('now')
    ORDER BY send_at ASC
    LIMIT 10
  `).all() as any[];

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

  // Log to DB
  db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, datetime('now'))").run(phone, text);
  db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-inbound', ?, 'assistant', ?, datetime('now'))").run(phone, text);
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
