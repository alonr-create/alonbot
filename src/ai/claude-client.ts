import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('claude-client');

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

/**
 * Generate a response from Claude given a conversation history and system prompt.
 * Returns the text response, or a Hebrew fallback message on error.
 */
export async function generateResponse(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
): Promise<string> {
  try {
    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      temperature: 0.7,
      system: systemPrompt,
      messages,
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    log.info(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      'Claude response generated',
    );

    return text;
  } catch (err) {
    log.error({ err }, 'Claude API error');
    return 'מצטער, נתקלתי בבעיה טכנית. אלון יחזור אליך בקרוב!';
  }
}
