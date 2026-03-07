import { z } from 'zod';
import type { ToolHandler } from '../types.js';

const mondayApiSchema = z.object({
  query: z.string().min(1).max(10000),
});

const handler: ToolHandler = {
  name: 'monday_api',
  definition: {
    name: 'monday_api',
    description: 'Monday.com GraphQL query',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  schema: mondayApiSchema,
  async execute(input, ctx) {
    if (!ctx.config.mondayApiKey) return 'Error: MONDAY_API_KEY not configured.';
    try {
      const res = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': ctx.config.mondayApiKey,
        },
        body: JSON.stringify({ query: input.query }),
      });
      const data = await res.json();
      return JSON.stringify(data, null, 2).slice(0, 8000);
    } catch (e: any) {
      return `Error: Monday.com API call failed.`;
    }
  },
};

export default handler;
