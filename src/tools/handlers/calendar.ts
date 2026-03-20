import type { ToolHandler } from '../types.js';
import { withRetry } from '../../utils/retry.js';

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
        return data.success ? `אירוע נוצר: "${input.title}" ב-${input.date}${input.time ? ' ' + input.time : ''}` : `Error: ${data.error || 'Unknown'}`;
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
