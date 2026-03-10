/**
 * Transcribe WhatsApp voice messages using OpenAI Whisper API.
 * Supports Hebrew, English, and auto-detection.
 */
import OpenAI from 'openai';
import { createLogger } from '../utils/logger.js';

const log = createLogger('voice-transcribe');

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Transcribe audio buffer to text using Whisper.
 * @param audioBuffer - Raw audio data (ogg/opus from WhatsApp)
 * @param mimeType - MIME type of the audio (e.g. 'audio/ogg; codecs=opus')
 * @returns Transcribed text, or null on failure
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType?: string,
): Promise<string | null> {
  try {
    const client = getClient();

    // WhatsApp voice messages are typically ogg/opus
    const ext = mimeType?.includes('ogg') ? 'ogg' : 'mp3';
    const file = new File([audioBuffer as unknown as BlobPart], `voice.${ext}`, {
      type: mimeType || 'audio/ogg',
    });

    const response = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      language: 'he', // Default to Hebrew; Whisper handles mixed languages well
    });

    const text = response.text?.trim();
    if (!text) {
      log.warn('Whisper returned empty transcription');
      return null;
    }

    log.info({ textLength: text.length, preview: text.slice(0, 60) }, 'voice transcribed');
    return text;
  } catch (err) {
    log.error({ err }, 'voice transcription failed');
    return null;
  }
}
