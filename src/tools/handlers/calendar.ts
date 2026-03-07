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
        return data.events.map((e: any, i: number) =>
          `${i + 1}. ${e.title} — ${e.date}${e.time ? ' ' + e.time : ''} ${e.description ? '(' + e.description + ')' : ''}`
        ).join('\n');
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
];

export default handlers;
