import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'schedule_message',
  definition: {
    name: 'schedule_message',
    description: 'Schedule a one-time reminder/message at a specific Israel time ("YYYY-MM-DD HH:mm"). Use for "remind me in X minutes/hours" or "remind me at HH:mm". Calculate the target time based on current Israel time.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Message to send' },
        send_at: { type: 'string', description: 'Israel time to send (e.g. "2026-03-07 09:00")' },
        label: { type: 'string', description: 'Short label for this scheduled message' },
      },
      required: ['message', 'send_at'],
    },
  },
  async execute(input, ctx) {
    try {
      const sendAt = input.send_at;
      const targetId = ctx.config.allowedTelegram[0] || '';
      const result = ctx.db.prepare(
        'INSERT INTO scheduled_messages (label, message, send_at, channel, target_id) VALUES (?, ?, ?, ?, ?)'
      ).run(input.label || null, input.message, sendAt, 'telegram', targetId);
      return `Scheduled message #${result.lastInsertRowid} for ${sendAt}: "${(input.label || input.message).slice(0, 50)}"`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
};

export default handler;
