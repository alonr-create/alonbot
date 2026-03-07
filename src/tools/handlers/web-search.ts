import type { ToolHandler } from '../types.js';
import { withRetry } from '../../utils/retry.js';

const handler: ToolHandler = {
  name: 'web_search',
  definition: {
    name: 'web_search',
    description: 'DuckDuckGo search',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  async execute(input) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
      const res = await withRetry(() => fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      }));
      const html = await res.text();
      const results: string[] = [];
      const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.+?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>(.+?)<\/a>/g;
      let match;
      let count = 0;
      while ((match = regex.exec(html)) && count < 8) {
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        const href = match[1];
        results.push(`${count + 1}. ${title}\n   ${snippet}\n   ${href}`);
        count++;
      }
      return results.length > 0 ? results.join('\n\n') : 'No results found.';
    } catch (e: any) {
      return `Error: Search failed.`;
    }
  },
};

export default handler;
