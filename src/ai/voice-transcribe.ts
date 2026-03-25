/**
 * Transcribe WhatsApp voice messages.
 * Primary: Groq Whisper (free, fast).
 * Fallback: OpenAI Whisper.
 */
import { createLogger } from '../utils/logger.js';

const log = createLogger('voice-transcribe');

/**
 * Transcribe audio buffer to text.
 * Tries Groq first (free), falls back to OpenAI Whisper.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType?: string,
): Promise<string | null> {
  // Try Groq Whisper first (free tier)
  const groqResult = await transcribeWithGroq(audioBuffer, mimeType);
  if (groqResult) return groqResult;

  // Fallback to OpenAI Whisper
  const whisperResult = await transcribeWithWhisper(audioBuffer, mimeType);
  if (whisperResult) return whisperResult;

  return null;
}

/**
 * Transcribe with Groq Whisper API (free, fast).
 */
async function transcribeWithGroq(
  audioBuffer: Buffer,
  mimeType?: string,
): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    log.debug('GROQ_API_KEY not configured, skipping Groq');
    return null;
  }

  try {
    const ext = mimeType?.includes('ogg') ? 'ogg' : 'mp3';
    const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType || 'audio/ogg' });

    const formData = new FormData();
    formData.append('file', blob, `voice.${ext}`);
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'he');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errText = await response.text();
      log.error({ status: response.status, body: errText.slice(0, 200) }, 'Groq Whisper API error');
      return null;
    }

    const data = await response.json() as { text?: string };
    const text = data.text?.trim();

    if (!text) {
      log.warn('Groq returned empty transcription');
      return null;
    }

    log.info({ textLength: text.length, preview: text.slice(0, 60) }, 'voice transcribed via Groq');
    return text;
  } catch (err) {
    log.error({ err }, 'Groq transcription failed');
    return null;
  }
}

/**
 * Fallback: transcribe with OpenAI Whisper.
 */
async function transcribeWithWhisper(
  audioBuffer: Buffer,
  mimeType?: string,
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey });

    const ext = mimeType?.includes('ogg') ? 'ogg' : 'mp3';
    const file = new File([audioBuffer as unknown as BlobPart], `voice.${ext}`, {
      type: mimeType || 'audio/ogg',
    });

    const response = await client.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      language: 'he',
    });

    const text = response.text?.trim();
    if (!text) return null;

    log.info({ textLength: text.length, preview: text.slice(0, 60) }, 'voice transcribed via Whisper');
    return text;
  } catch (err) {
    log.error({ err }, 'Whisper transcription failed');
    return null;
  }
}
