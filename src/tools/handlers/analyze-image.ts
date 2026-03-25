import { isUrlAllowed } from '../../utils/security.js';
import type { ToolHandler } from '../types.js';
import { withRetry } from '../../utils/retry.js';

const handler: ToolHandler = {
  name: 'analyze_image',
  definition: {
    name: 'analyze_image',
    description: 'Analyze image from URL (OCR, describe, Hebrew)',
    input_schema: {
      type: 'object' as const,
      properties: {
        image_url: { type: 'string' },
        question: { type: 'string' },
      },
      required: ['image_url'],
    },
  },
  async execute(input, ctx) {
    if (!ctx.config.geminiApiKey) return 'Error: GEMINI_API_KEY not configured.';
    if (!isUrlAllowed(input.image_url)) return 'Error: URL not allowed.';
    try {
      // Download image
      const imgRes = await fetch(input.image_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AlonBot/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      if (!imgRes.ok) return `Error: Could not download image (${imgRes.status}).`;
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const imgBuf = Buffer.from(await imgRes.arrayBuffer());
      const base64 = imgBuf.toString('base64');
      const question = input.question || 'Describe this image in detail. If there is text, extract it (OCR). Answer in Hebrew.';

      const res = await withRetry(() => fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${ctx.config.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: contentType, data: base64 } },
                { text: question },
              ],
            }],
          }),
        },
      ));
      if (!res.ok) {
        const errText = await res.text();
        return `Error: Gemini Vision returned ${res.status}: ${errText.slice(0, 200)}`;
      }
      const data = await res.json() as any;
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return parts.map((p: any) => p.text || '').join('\n').trim() || 'Could not analyze image.';
    } catch (e: any) {
      return `Error: Image analysis failed.`;
    }
  },
};

export default handler;
