import type { ToolHandler } from '../types.js';
import { withRetry } from '../../utils/retry.js';
import { db } from '../../utils/db.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('calendar');

const handlers: ToolHandler[] = [
  {
    name: 'calendar_list',
    definition: {
      name: 'calendar_list',
      description: 'List upcoming calendar events (next 7 days)',
      input_schema: {
        type: 'object' as const,
        properties: {
          days: { type: 'number', description: 'Number of days to look ahead (default 7)' },
        },
      },
    },
    async execute(input, ctx) {
      if (!ctx.config.googleCalendarScriptUrl) return 'Error: Google Calendar not configured. Set GOOGLE_CALENDAR_SCRIPT_URL env var.';
      try {
        const days = input.days || 7;
        const res = await withRetry(() => fetch(`${ctx.config.googleCalendarScriptUrl}?action=list&days=${days}`, {
          signal: AbortSignal.timeout(10000),
        }));
        if (!res.ok) return `Error: Calendar API returned ${res.status}`;
        const data = await res.json() as any;
        if (!data.events || data.events.length === 0) return `אין אירועים בקלנדר ב-${days} הימים הקרובים.`;

        // If in lead/sales context, redact event details — show only busy/free slots
        const isLeadContext = ctx.isLeadConversation === true;

        return data.events.map((e: any, i: number) => {
          if (isLeadContext) {
            // Lead mode: only show date/time as "busy" — no names, titles, or details
            const timeStr = e.time || 'כל היום';
            return `${i + 1}. ${e.date} ${timeStr} — תפוס`;
          }
          const cal = e.calendar ? ` [${e.calendar}]` : '';
          const loc = e.location ? ` | ${e.location}` : '';
          // Strip HTML from description and truncate
          const desc = e.description ? e.description.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) : '';
          // eventId on a separate labeled line so the model can easily extract it for update/delete
          const eid = e.id ? `\n   eventId: ${e.id}` : '';
          return `${i + 1}. ${e.title}${cal} — ${e.date}${e.time ? ' ' + e.time : ''}${e.allDay ? ' (כל היום)' : ''}${loc}${desc ? ' | ' + desc : ''}${eid}`;
        }).join('\n');
      } catch (e: any) {
        return `Error: Calendar request failed.`;
      }
    },
  },
  {
    name: 'calendar_add',
    definition: {
      name: 'calendar_add',
      description: 'Add a new event to Google Calendar',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          time: { type: 'string', description: 'HH:mm (24h format)' },
          duration_minutes: { type: 'number', description: 'Duration in minutes (default 60)' },
          description: { type: 'string' },
        },
        required: ['title', 'date'],
      },
    },
    async execute(input, ctx) {
      if (!ctx.config.googleCalendarScriptUrl) return 'Error: Google Calendar not configured. Set GOOGLE_CALENDAR_SCRIPT_URL env var.';
      try {
        const res = await withRetry(() => fetch(ctx.config.googleCalendarScriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'add',
            title: input.title,
            date: input.date,
            time: input.time || null,
            duration_minutes: input.duration_minutes || 60,
            description: input.description || '',
          }),
          signal: AbortSignal.timeout(10000),
        }));
        if (!res.ok) return `Error: Calendar API returned ${res.status}`;
        const data = await res.json() as any;
        if (!data.success) return `Error: ${data.error || 'Unknown'}`;

        // Auto-schedule 15-minute reminders for Alon + customer (if meeting has time)
        if (input.time && input.date) {
          try {
            const [hours, minutes] = input.time.split(':').map(Number);
            const meetingDate = new Date(`${input.date}T${input.time}:00+03:00`); // Israel time
            const reminderDate = new Date(meetingDate.getTime() - 15 * 60 * 1000);
            const reminderStr = `${reminderDate.getFullYear()}-${String(reminderDate.getMonth() + 1).padStart(2, '0')}-${String(reminderDate.getDate()).padStart(2, '0')} ${String(reminderDate.getHours()).padStart(2, '0')}:${String(reminderDate.getMinutes()).padStart(2, '0')}`;

            // Only schedule if the meeting is in the future
            if (reminderDate.getTime() > Date.now()) {
              // Reminder for Alon (Telegram)
              const alonTarget = ctx.config.allowedTelegram?.[0] || '';
              if (alonTarget) {
                db.prepare('INSERT INTO scheduled_messages (label, message, send_at, channel, target_id) VALUES (?, ?, ?, ?, ?)')
                  .run(`תזכורת: ${input.title}`, `⏰ תזכורת — בעוד 15 דקות:\n\n📅 *${input.title}*\n🕐 ${input.time}\n📆 ${input.date}`, reminderStr, 'telegram', alonTarget);
              }

              // Reminder for customer via WhatsApp
              // Use ctx.senderId (the lead's phone) directly, or fallback to extracting from description
              const descText = input.description || '';
              let customerPhone = '';
              let customerName = ctx.senderName || '';

              if (ctx.senderId && ctx.isLeadConversation) {
                // Direct: we're in a lead conversation, senderId IS the customer phone
                customerPhone = ctx.senderId;
              } else {
                // Fallback: extract from event description
                const phoneMatch = descText.match(/(?:טלפון|phone)[:\s]*(\+?972[\d\-\s]+|0\d[\d\-\s]{7,})/i);
                if (phoneMatch) {
                  customerPhone = phoneMatch[1].replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
                }
              }

              if (!customerName) {
                const nameMatch = descText.match(/(?:ליד|שם)[:\s]*([^\n]+)/i);
                if (nameMatch) customerName = nameMatch[1].trim();
              }

              if (customerPhone) {
                db.prepare('INSERT INTO scheduled_messages (label, message, send_at, channel, target_id) VALUES (?, ?, ?, ?, ?)')
                  .run(`תזכורת ללקוח: ${input.title}`, `היי${customerName ? ' ' + customerName : ''} 👋\n\nתזכורת — יש לנו פגישה בעוד 15 דקות! ⏰\n🕐 ${input.time}\n\nנתראה בזום 🎥`, reminderStr, 'whatsapp', customerPhone);
              }

              log.info({ title: input.title, reminderAt: reminderStr }, 'scheduled 15min meeting reminders');
            }
          } catch (e: any) {
            log.warn({ err: e.message }, 'failed to schedule meeting reminders');
          }
        }

        // ── Auto-update lead as booked + sync Monday.com ──
        if (ctx.isLeadConversation && ctx.senderId) {
          const phone = ctx.senderId;
          try {
            // 1. Mark was_booked in DB
            db.prepare('UPDATE leads SET was_booked = 1, lead_status = ?, updated_at = datetime(\'now\') WHERE phone = ?').run('דובר', phone);
            log.info({ phone, title: input.title }, 'lead marked as booked');

            // 2. Bump lead score to max
            db.prepare('UPDATE leads SET lead_score = MAX(COALESCE(lead_score, 0), 3) WHERE phone = ?').run(phone);

            // 3. Sync to Monday.com — update or create item
            const lead = db.prepare('SELECT monday_item_id, name, source FROM leads WHERE phone = ?').get(phone) as any;
            const mondayKey = ctx.config.mondayApiKey;
            if (mondayKey) {
              const boardId = 5092777389; // לידים אלון
              const leadName = lead?.name || ctx.senderName || 'ליד';
              const localPhone = phone.replace(/^972/, '0');

              if (lead?.monday_item_id) {
                // Update existing Monday item — set date + move to "נוצר קשר"
                await fetch('https://api.monday.com/v2', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: mondayKey },
                  body: JSON.stringify({
                    query: `mutation { change_multiple_column_values(board_id: ${boardId}, item_id: ${lead.monday_item_id}, column_values: "{\\"date4\\":{\\"date\\":\\"${input.date}\\"},\\"status\\":{\\"label\\":\\"Working on it\\"}}") { id } }`,
                  }),
                }).catch(() => {});
                // Move to "נוצר קשר" group
                await fetch('https://api.monday.com/v2', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: mondayKey },
                  body: JSON.stringify({
                    query: `mutation { move_item_to_group(item_id: ${lead.monday_item_id}, group_id: "group_mm1s9vs5") { id } }`,
                  }),
                }).catch(() => {});
                log.info({ phone, mondayItemId: lead.monday_item_id }, 'Monday.com item updated with meeting date');
              } else {
                // Create new Monday item
                const colVals = JSON.stringify({
                  phone_mm16hqz2: localPhone,
                  text_mm16pfzp: lead?.source || 'alon_dev',
                  date4: { date: input.date },
                  status: { label: 'Working on it' },
                  long_text_mm16k6vr: `פגישת זום ${input.date} ${input.time || ''}\n${input.description || ''}`,
                }).replace(/"/g, '\\"');
                const createResp = await fetch('https://api.monday.com/v2', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: mondayKey },
                  body: JSON.stringify({
                    query: `mutation { create_item(board_id: ${boardId}, group_id: "group_mm1s9vs5", item_name: "${leadName.replace(/"/g, '\\"')}", column_values: "${colVals}") { id } }`,
                  }),
                });
                if (createResp.ok) {
                  const createData = await createResp.json() as any;
                  const newItemId = createData?.data?.create_item?.id;
                  if (newItemId) {
                    db.prepare('UPDATE leads SET monday_item_id = ? WHERE phone = ?').run(String(newItemId), phone);
                    log.info({ phone, mondayItemId: newItemId }, 'Monday.com item created for booked lead');
                  }
                }
              }
            }
          } catch (e: any) {
            log.warn({ phone, err: e.message }, 'failed to auto-update lead booking status');
          }
        }

        return `אירוע נוצר: "${input.title}" ב-${input.date}${input.time ? ' ' + input.time : ''}\n📢 תזכורת 15 דקות לפני נקבעה אוטומטית`;
      } catch (e: any) {
        return `Error: Calendar request failed.`;
      }
    },
  },
  {
    name: 'calendar_update',
    definition: {
      name: 'calendar_update',
      description: 'Update an existing Google Calendar event (move to new date/time, change title, etc.)',
      input_schema: {
        type: 'object' as const,
        properties: {
          eventId: { type: 'string', description: 'The event ID from calendar_list' },
          title: { type: 'string', description: 'New title (optional)' },
          date: { type: 'string', description: 'New date YYYY-MM-DD (optional)' },
          time: { type: 'string', description: 'New time HH:mm 24h format (optional)' },
          duration_minutes: { type: 'number', description: 'New duration in minutes (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
        },
        required: ['eventId'],
      },
    },
    async execute(input, ctx) {
      if (!ctx.config.googleCalendarScriptUrl) return 'Error: Google Calendar not configured. Set GOOGLE_CALENDAR_SCRIPT_URL env var.';
      try {
        const res = await withRetry(() => fetch(ctx.config.googleCalendarScriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'update',
            eventId: input.eventId,
            ...(input.title && { title: input.title }),
            ...(input.date && { date: input.date }),
            ...(input.time && { time: input.time }),
            ...(input.duration_minutes && { duration_minutes: input.duration_minutes }),
            ...(input.description !== undefined && { description: input.description }),
          }),
          signal: AbortSignal.timeout(10000),
        }));
        if (!res.ok) return `Error: Calendar API returned ${res.status}`;
        const data = await res.json() as any;
        return data.success ? `אירוע עודכן בהצלחה: ${input.date ? input.date : ''}${input.time ? ' ' + input.time : ''}${input.title ? ' "' + input.title + '"' : ''}` : `Error: ${data.error || 'Unknown'}`;
      } catch (e: any) {
        return `Error: Calendar update request failed.`;
      }
    },
  },
  {
    name: 'calendar_delete',
    definition: {
      name: 'calendar_delete',
      description: 'Delete a Google Calendar event',
      input_schema: {
        type: 'object' as const,
        properties: {
          eventId: { type: 'string', description: 'The event ID from calendar_list' },
        },
        required: ['eventId'],
      },
    },
    async execute(input, ctx) {
      if (!ctx.config.googleCalendarScriptUrl) return 'Error: Google Calendar not configured. Set GOOGLE_CALENDAR_SCRIPT_URL env var.';
      try {
        const res = await withRetry(() => fetch(ctx.config.googleCalendarScriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'delete',
            eventId: input.eventId,
          }),
          signal: AbortSignal.timeout(10000),
        }));
        if (!res.ok) return `Error: Calendar API returned ${res.status}`;
        const data = await res.json() as any;
        return data.success ? `אירוע נמחק בהצלחה.` : `Error: ${data.error || 'Unknown'}`;
      } catch (e: any) {
        return `Error: Calendar delete request failed.`;
      }
    },
  },
];

export default handlers;
