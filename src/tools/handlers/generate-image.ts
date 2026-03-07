import type { ToolHandler } from '../types.js';
import { withRetry } from '../../utils/retry.js';

const handler: ToolHandler = {
  name: 'generate_image',
  definition: {
    name: 'generate_image',
    description: 'Generate image from prompt',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'English prompt' },
      },
      required: ['prompt'],
    },
  },
  async execute(input, ctx) {
    if (!ctx.config.geminiApiKey) return 'Error: GEMINI_API_KEY not configured.';
    try {
      const res = await withRetry(() => fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${ctx.config.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: input.prompt }] }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
          }),
        },
      ));
      if (!res.ok) {
        const errText = await res.text();
        return `Error: Gemini API returned ${res.status}: ${errText.slice(0, 200)}`;
      }
      const data = await res.json() as any;
      const parts = data?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          const buf = Buffer.from(part.inlineData.data, 'base64');
          ctx.addPendingMedia({ type: 'image', data: buf });
          return 'Image generated and sent.';
        }
      }
      return 'Image generation failed — no image in response.';
    } catch (e: any) {
      return `Error: Image generation failed.`;
    }
  },
};

export default handler;
