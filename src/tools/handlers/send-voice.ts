import type { ToolHandler } from '../types.js';
import { withRetry } from '../../utils/retry.js';

// Voice presets — ElevenLabs voice IDs
export const VOICE_PRESETS: Record<string, { id: string; name: string; model?: string; settings: { stability: number; similarity_boost: number; style: number } }> = {
  alon:    { id: 'afovcnSM12xH5rD4hdwt', name: 'אלון (ברירת מחדל)', model: 'eleven_turbo_v2_5', settings: { stability: 0.7, similarity_boost: 0.9, style: 0.4 } },
  robot:   { id: 'onwK4e9ZLuTAKqWW03F9', name: 'רובוט 🤖',           model: 'eleven_turbo_v2_5', settings: { stability: 0.85, similarity_boost: 0.75, style: 0.0 } },
  monster: { id: 'SOYHLrjzK2X1ezoPC6cr', name: 'מפלצת 👹',           model: 'eleven_turbo_v2_5', settings: { stability: 0.3, similarity_boost: 0.7, style: 0.8 } },
  wizard:  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'קוסם 🧙',            model: 'eleven_turbo_v2_5', settings: { stability: 0.5, similarity_boost: 0.8, style: 0.6 } },
  santa:   { id: 'pqHfZKP75CvOlQylNhV4', name: 'סנטה 🎅',            model: 'eleven_turbo_v2_5', settings: { stability: 0.65, similarity_boost: 0.8, style: 0.5 } },
  english: { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian (English)',     model: 'eleven_turbo_v2_5', settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 } },
};

const handler: ToolHandler = {
  name: 'send_voice',
  definition: {
    name: 'send_voice',
    description: 'TTS voice message. Available voices: alon (default), robot 🤖, monster 👹, wizard 🧙, santa 🎅, english',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string' },
        voice: { type: 'string', enum: Object.keys(VOICE_PRESETS), description: 'Voice preset to use. Default: alon' },
      },
      required: ['text'],
    },
  },
  async execute(input, ctx) {
    if (!ctx.config.elevenlabsApiKey) return 'Error: ELEVENLABS_API_KEY not configured.';
    try {
      // Pick voice preset (default: auto-detect language)
      let preset = VOICE_PRESETS[input.voice || ''];
      if (!preset) {
        const isHebrew = /[\u0590-\u05FF]/.test(input.text);
        preset = isHebrew ? VOICE_PRESETS.alon : VOICE_PRESETS.english;
      }

      const modelId = preset.model || 'eleven_turbo_v2_5';

      const res = await withRetry(() => fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${preset.id}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ctx.config.elevenlabsApiKey,
          },
          body: JSON.stringify({
            text: input.text,
            model_id: modelId,
            voice_settings: preset.settings,
          }),
        },
      ));
      if (!res.ok) return `Error: ElevenLabs returned ${res.status}`;
      const buf = Buffer.from(await res.arrayBuffer());
      ctx.addPendingMedia({ type: 'voice', data: buf });
      return `Voice message generated with voice "${preset.name}" and sent.`;
    } catch (e: any) {
      return `Error: Voice generation failed.`;
    }
  },
};

export default handler;
