import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'translate',
  definition: {
    name: 'translate',
    description: 'Translate text between languages using Google Translate free API',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to translate' },
        from: {
          type: 'string',
          description: 'Source language code (e.g., "en", "he", "auto"). Defaults to "auto".',
        },
        to: {
          type: 'string',
          description: 'Target language code (e.g., "en", "he", "es")',
        },
      },
      required: ['text', 'to'],
    },
  },
  async execute(input) {
    try {
      const from = input.from || 'auto';
      const to = input.to as string;
      const text = input.text as string;

      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return `Error: Google Translate returned ${res.status}`;
      }

      const data = (await res.json()) as any[][];

      // data[0] is an array of translation segments: [[translated, original, ...], ...]
      const translated = data[0]
        .map((segment: any[]) => segment[0])
        .join('');

      const detectedLang = data[2] as unknown as string;

      return `Translation (${detectedLang || from} → ${to}):\n${translated}`;
    } catch (e: any) {
      return `Error translating: ${e.message}`;
    }
  },
};

export default handler;
