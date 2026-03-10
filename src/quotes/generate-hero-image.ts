/**
 * Generate a custom hero image for quotes using Gemini image generation.
 * Falls back gracefully if no API key or generation fails.
 */
import { createLogger } from '../utils/logger.js';

const log = createLogger('hero-image');

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';

/**
 * Generate a hero banner image for a quote using Gemini.
 * Returns base64 JPEG or null if unavailable.
 */
export async function generateHeroImage(
  service: string,
  clientName: string,
  colors: string[],
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.debug('no GEMINI_API_KEY — skipping hero image generation');
    return null;
  }

  const primaryColor = colors[0] || '#7C3AED';
  const secondaryColor = colors[1] || '#06B6D4';

  const prompt = `Create a professional, modern business banner image (1200x400px, landscape).
Theme: ${service} for "${clientName}".
Style: Clean corporate design with gradient from ${primaryColor} to ${secondaryColor}.
Include abstract tech elements (circuit lines, nodes, subtle geometric shapes).
No text, no words, no letters — only visual design elements.
Modern, minimal, professional. Dark background with glowing accent colors.`;

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }],
        }],
        generationConfig: {
          responseModalities: ['IMAGE', 'TEXT'],
          responseMimeType: 'image/jpeg',
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      log.warn({ status: response.status }, 'Gemini API error');
      return null;
    }

    const data = await response.json() as any;
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!parts) return null;

    for (const part of parts) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        log.info({ service, clientName }, 'hero image generated');
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }

    log.warn('no image in Gemini response');
    return null;
  } catch (err) {
    log.error({ err }, 'hero image generation failed');
    return null;
  }
}
