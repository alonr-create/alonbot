/**
 * Image analysis via Claude Vision.
 * Analyzes images sent by leads and returns a sales-oriented response.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../utils/logger.js';

const log = createLogger('image-analysis');

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const SUPPORTED_TYPES: string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * Analyze an image using Claude Vision and return a sales-oriented response.
 */
export async function analyzeImage(
  imageBase64: string,
  mimeType: string,
  leadContext: string,
): Promise<string> {
  // Normalize mime type
  const normalizedType = mimeType.split(';')[0].trim();
  const mediaType: ImageMediaType = SUPPORTED_TYPES.includes(normalizedType)
    ? (normalizedType as ImageMediaType)
    : 'image/jpeg';

  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      temperature: 0.7,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: `אתה נציג מכירות של Alon.dev. הלקוח שלח תמונה. תנתח אותה ותגיב בהתאם. אם זה צילום מסך של אתר — תן חוות דעת ותציע לבנות משהו טוב יותר. אם זה לוגו — תציע שירותי מיתוג. אם זה משהו אחר — תגיב בטבעיות.\n\nהקשר על הליד: ${leadContext}\n\nענה בעברית, קצר וממוקד (2-4 משפטים). תמיד סיים עם שאלה או הצעה לפעולה.`,
            },
          ],
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    log.info(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      'Image analysis completed',
    );

    return text;
  } catch (err) {
    log.error({ err }, 'Image analysis failed');
    return 'קיבלתי את התמונה! אשמח לדבר על זה — ספר לי מה אתה מחפש?';
  }
}
