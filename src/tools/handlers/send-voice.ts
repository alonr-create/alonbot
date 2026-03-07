import type { ToolHandler } from '../types.js';
import { withRetry } from '../../utils/retry.js';

const handler: ToolHandler = {
  name: 'send_voice',
  definition: {
    name: 'send_voice',
    description: 'TTS voice message (Hebrew/English)',
    input_schema: {
      type: 'object' as const,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  async execute(input, ctx) {
    if (!ctx.config.elevenlabsApiKey) return 'Error: ELEVENLABS_API_KEY not configured.';
    try {
      // Detect language: Hebrew or English voice
      const isHebrew = /[\u0590-\u05FF]/.test(input.text);
      const voiceId = isHebrew ? ctx.config.elevenlabsVoiceId : 'nPczCjzI2devNBz1zQrb';
      const res = await withRetry(() => fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ctx.config.elevenlabsApiKey,
          },
          body: JSON.stringify({
            text: input.text,
            model_id: 'eleven_v3',
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
          }),
        },
      ));
      if (!res.ok) return `Error: ElevenLabs returned ${res.status}`;
      const buf = Buffer.from(await res.arrayBuffer());
      ctx.addPendingMedia({ type: 'voice', data: buf });
      return 'Voice message generated and sent.';
    } catch (e: any) {
      return `Error: Voice generation failed.`;
    }
  },
};

export default handler;
