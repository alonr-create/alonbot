/**
 * Text-to-Speech using ElevenLabs API.
 * Generates voice messages for WhatsApp responses.
 */
import { createLogger } from '../utils/logger.js';

const log = createLogger('voice-synthesize');

const ELEVENLABS_API = 'https://api.elevenlabs.io/v1/text-to-speech';

/**
 * Convert text to speech audio buffer using ElevenLabs.
 * Returns an ogg/opus buffer suitable for WhatsApp voice messages,
 * or null on failure.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'jUBxo582xuRbgYNI6JJ2';

  if (!apiKey) {
    log.error('ELEVENLABS_API_KEY not configured');
    return null;
  }

  // Strip emojis and markdown for cleaner speech
  const cleanText = text
    .replace(/[\u{1F600}-\u{1F9FF}]/gu, '')
    .replace(/[*_~`]/g, '')
    .replace(/\[.*?\]/g, '')
    .trim();

  if (!cleanText) return null;

  try {
    const response = await fetch(`${ELEVENLABS_API}/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: cleanText,
        model_id: 'eleven_v3',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.3,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.error({ status: response.status, body: errText }, 'ElevenLabs API error');
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    log.info({ textLength: cleanText.length, audioSize: buffer.length }, 'speech synthesized');
    return buffer;
  } catch (err) {
    log.error({ err }, 'speech synthesis failed');
    return null;
  }
}
