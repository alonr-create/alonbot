import { z } from 'zod';
import { isUrlAllowed } from '../../utils/security.js';
import { stripHtml } from '../../utils/html.js';
import { sanitizeWebContent } from '../../utils/sanitize.js';
import type { ToolHandler } from '../types.js';

const browseUrlSchema = z.object({
  url: z.string().url().max(2000),
});

const handler: ToolHandler = {
  name: 'browse_url',
  definition: {
    name: 'browse_url',
    description: 'Fetch web page text',
    input_schema: {
      type: 'object' as const,
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  schema: browseUrlSchema,
  async execute(input) {
    if (!isUrlAllowed(input.url)) {
      return 'Error: URL not allowed. Only public http/https URLs permitted.';
    }
    try {
      const res = await fetch(input.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlonBot/1.0)' },
        signal: AbortSignal.timeout(10000),
      });
      const html = await res.text();
      const text = stripHtml(html).slice(0, 8000);
      return sanitizeWebContent(text) || 'Empty page.';
    } catch (e: any) {
      return `Error: Could not fetch URL.`;
    }
  },
};

export default handler;
