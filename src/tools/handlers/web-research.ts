import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'web_research',
  definition: {
    name: 'web_research',
    description: 'Deep research via Gemini+Google Search with sources. Best for complex/Hebrew queries.',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  async execute(input, ctx) {
    if (!ctx.config.geminiApiKey) return 'Error: GEMINI_API_KEY not configured.';
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${ctx.config.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: input.query }] }],
            tools: [{ google_search: {} }],
          }),
        },
      );
      if (!res.ok) {
        const errText = await res.text();
        return `Error: Gemini Search returned ${res.status}: ${errText.slice(0, 200)}`;
      }
      const data = await res.json() as any;
      const parts = data?.candidates?.[0]?.content?.parts || [];
      let answer = parts.map((p: any) => p.text || '').join('\n').trim();
      // Extract grounding sources if available
      const grounding = data?.candidates?.[0]?.groundingMetadata;
      if (grounding?.groundingChunks?.length) {
        const sources = grounding.groundingChunks
          .filter((c: any) => c.web?.uri)
          .slice(0, 5)
          .map((c: any, i: number) => `${i + 1}. ${c.web.title || ''} — ${c.web.uri}`)
          .join('\n');
        if (sources) answer += `\n\nSources:\n${sources}`;
      }
      return answer || 'No results found.';
    } catch (e: any) {
      return `Error: Web research failed.`;
    }
  },
};

export default handler;
