import { z } from 'zod';
import { createTransport } from 'nodemailer';
import { isEmailAllowed } from '../../utils/security.js';
import type { ToolHandler } from '../types.js';

const sendEmailSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(50000),
});

const handler: ToolHandler = {
  name: 'send_email',
  definition: {
    name: 'send_email',
    description: 'Send Gmail to whitelisted address',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  schema: sendEmailSchema,
  async execute(input, ctx) {
    if (!ctx.config.gmailUser || !ctx.config.gmailAppPassword) return 'Error: Gmail credentials not configured.';
    if (!isEmailAllowed(input.to)) {
      return `Error: Recipient not allowed. Can only send to known addresses.`;
    }
    try {
      const transport = createTransport({
        service: 'gmail',
        auth: { user: ctx.config.gmailUser, pass: ctx.config.gmailAppPassword },
      });
      await transport.sendMail({
        from: ctx.config.gmailUser,
        to: input.to,
        subject: input.subject,
        html: input.body,
      });
      transport.close();
      return `Email sent to ${input.to}`;
    } catch (e: any) {
      return `Error: Email sending failed.`;
    }
  },
};

export default handler;
