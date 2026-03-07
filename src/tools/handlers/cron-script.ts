import { z } from 'zod';
import { addCronJob } from '../../cron/scheduler.js';
import type { ToolHandler } from '../types.js';

const cronScriptSchema = z.object({
  name: z.string().min(1).max(200),
  cron_expr: z.string().regex(/^[\d*,\/-\s]+$/).max(100),
  script: z.string().min(1).max(10000),
  notify: z.boolean().optional(),
});

const handler: ToolHandler = {
  name: 'cron_script',
  definition: {
    name: 'cron_script',
    description: 'Schedule a script to run periodically in the cloud. The script runs as a shell command on cron schedule.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Script name' },
        cron_expr: { type: 'string', description: 'Cron expression (e.g. "0 */6 * * *" = every 6 hours)' },
        script: { type: 'string', description: 'Shell command or script to run' },
        notify: { type: 'boolean', description: 'Send output to Telegram? (default: true)' },
      },
      required: ['name', 'cron_expr', 'script'],
    },
  },
  schema: cronScriptSchema,
  async execute(input, ctx) {
    try {
      // Store the script as a cron job — reuse cron_jobs table with script type
      const notify = input.notify !== false;
      const targetId = ctx.config.allowedTelegram[0] || '';
      const message = JSON.stringify({ type: 'script', script: input.script, notify });
      const id = addCronJob(input.name, input.cron_expr, 'telegram', targetId, message);
      return `Cron script #${id} created: "${input.name}" — ${input.cron_expr}\nScript: ${input.script}\nNotify: ${notify ? 'yes' : 'no'}`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
};

export default handler;
