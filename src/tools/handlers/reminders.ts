import { z } from 'zod';
import { addCronJob } from '../../cron/scheduler.js';
import type { ToolHandler } from '../types.js';

const setReminderSchema = z.object({
  name: z.string().min(1).max(200),
  cron_expr: z.string().regex(/^[\d*,\/-\s]+$/).max(100),
  message: z.string().min(1).max(5000),
});

const handlers: ToolHandler[] = [
  {
    name: 'set_reminder',
    definition: {
      name: 'set_reminder',
      description: 'Set cron reminder',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' },
          cron_expr: { type: 'string', description: 'e.g. "0 18 * * *"' },
          message: { type: 'string' },
        },
        required: ['name', 'cron_expr', 'message'],
      },
    },
    schema: setReminderSchema,
    async execute(input, ctx) {
      try {
        const id = addCronJob(input.name, input.cron_expr, 'telegram', ctx.config.allowedTelegram[0] || '', input.message);
        return `Reminder set: "${input.name}" (ID: ${id}) — ${input.cron_expr}`;
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    },
  },
  {
    name: 'list_reminders',
    definition: {
      name: 'list_reminders',
      description: 'List reminders',
      input_schema: { type: 'object' as const, properties: {} },
    },
    async execute(input, ctx) {
      const jobs = ctx.db.prepare('SELECT id, name, cron_expr, message, enabled FROM cron_jobs ORDER BY id').all() as any[];
      if (jobs.length === 0) return 'No reminders set.';
      return jobs.map(j => `#${j.id} ${j.enabled ? '✓' : '✗'} "${j.name}" — ${j.cron_expr} — ${j.message}`).join('\n');
    },
  },
  {
    name: 'delete_reminder',
    definition: {
      name: 'delete_reminder',
      description: 'Delete reminder',
      input_schema: {
        type: 'object' as const,
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
    async execute(input, ctx) {
      const result = ctx.db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(input.id);
      return result.changes > 0 ? `Reminder #${input.id} deleted.` : `Reminder #${input.id} not found.`;
    },
  },
];

export default handlers;
