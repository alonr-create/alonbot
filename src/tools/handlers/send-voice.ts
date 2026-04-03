import type { ToolHandler } from '../types.js';
import { withRetry } from '../../utils/retry.js';

// Voice presets — ElevenLabs voice IDs
// The bot can change voice IDs and settings, but the model is locked to eleven_v3 in execute()
export const VOICE_PRESETS: Record<string, { id: string; name: string; settings: { stability: number; similarity_boost: number; style: number } }> = {
  alon:    { id: 'afovcnSM12xH5rD4hdwt', name: 'אלון (ברירת מחדל)', settings: { stability: 0.7, similarity_boost: 0.9, style: 0.4 } },
  robot:   { id: 'afovcnSM12xH5rD4hdwt', name: 'רובוט 🤖',           settings: { stability: 0.95, similarity_boost: 0.5, style: 0.0 } },
  monster: { id: 'YdE0xzlplwGVh5IqepPl', name: 'מפלצת 👹',           settings: { stability: 0.2, similarity_boost: 0.6, style: 1.0 } },
  wizard:  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'קוסם 🧙',            settings: { stability: 0.5, similarity_boost: 0.8, style: 0.6 } },
  santa:   { id: 'pqHfZKP75CvOlQylNhV4', name: 'סנטה 🎅',            settings: { stability: 0.65, similarity_boost: 0.8, style: 0.5 } },
  english: { id: 'nPczCjzI2devNBz1zQrb', name: 'Brian (English)',     settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 } },
  woman:   { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah (Woman)',        settings: { stability: 0.55, similarity_boost: 0.8, style: 0.4 } },
  yael:    { id: 'albaa6OioIhKtKdCEkQw', name: 'יעל (Laloosh)',       settings: { stability: 0.55, similarity_boost: 0.85, style: 0.35 } },
};

// LOCKED — do not let auto_improve change this. turbo/multilingual break Hebrew pronunciation.
const TTS_MODEL = 'eleven_v3';

const handler: ToolHandler = {
  name: 'send_voice',
  definition: {
    name: 'send_voice',
    description: 'TTS voice message. Available voices: alon (default), yael (יעל — for lead conversations), robot 🤖, monster 👹, wizard 🧙, santa 🎅, english. NOTE: model is locked to eleven_v3 — do NOT try to change it, turbo models break Hebrew.',
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
        preset = isHebrew ? VOICE_PRESETS.yael : VOICE_PRESETS.english;
      }

      const res = await withRetry(() => fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${preset.id}?output_format=opus_48000_128`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ctx.config.elevenlabsApiKey,
          },
          body: JSON.stringify({
            text: input.text,
            model_id: TTS_MODEL, // Always eleven_v3 — hardcoded, not from preset
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
