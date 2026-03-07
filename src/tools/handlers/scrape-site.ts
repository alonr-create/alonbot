import { isUrlAllowed } from '../../utils/security.js';
import { stripHtml } from '../../utils/html.js';
import { sanitizeWebContent } from '../../utils/sanitize.js';
import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'scrape_site',
  definition: {
    name: 'scrape_site',
    description: 'Crawl an entire website (up to 20 pages). Returns text content from all pages. Great for competitor research.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Starting URL to crawl' },
        max_pages: { type: 'number', description: 'Max pages to crawl (default 10, max 20)' },
      },
      required: ['url'],
    },
  },
  async execute(input) {
    if (!isUrlAllowed(input.url)) return 'Error: URL not allowed.';
    const maxPages = Math.min(input.max_pages || 10, 20);
    const visited = new Set<string>();
    const results: string[] = [];

    try {
      const baseUrl = new URL(input.url);
      const queue = [input.url];

      while (queue.length > 0 && visited.size < maxPages) {
        const currentUrl = queue.shift()!;
        if (visited.has(currentUrl)) continue;
        visited.add(currentUrl);

        try {
          const res = await fetch(currentUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlonBot/1.0)' },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) continue;
          const html = await res.text();

          // Extract text
          const text = stripHtml(html).slice(0, 3000);

          results.push(`=== ${currentUrl} ===\n${text}`);

          // Extract same-domain links
          const linkRegex = /href="([^"]+)"/gi;
          let linkMatch;
          while ((linkMatch = linkRegex.exec(html)) && queue.length < maxPages * 2) {
            try {
              const href = new URL(linkMatch[1], currentUrl);
              if (href.hostname === baseUrl.hostname && !visited.has(href.toString()) && !href.hash) {
                queue.push(href.toString());
              }
            } catch {}
          }
        } catch {
          // Skip failed pages
        }
      }

      if (results.length === 0) return 'Error: Could not fetch any pages.';
      return sanitizeWebContent(`Scraped ${results.length} pages from ${baseUrl.hostname}:\n\n${results.join('\n\n').slice(0, 15000)}`);
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
};

export default handler;
