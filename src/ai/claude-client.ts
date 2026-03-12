import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('claude-client');

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1024;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return client;
}

/** Extract only text blocks from a Claude response content array. */
function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
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
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      system: systemPrompt,
      messages,
    });

    const text = extractText(response.content);

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

/**
 * Generate a response with web search enabled (boss mode only).
 * Claude can search the internet to answer questions with real-time data.
 * Returns only the text content — server_tool_use/web_search_tool_result blocks
 * are stripped so they don't pollute conversation history.
 */
export async function generateWithSearch(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
): Promise<{ text: string; searchUsed: boolean }> {
  try {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
      system: systemPrompt,
      messages,
      tools: [
        { type: 'web_search_20250305' as any, name: 'web_search', max_uses: 3 } as any,
      ],
    });

    const text = extractText(response.content);
    const searchUsed = response.content.some((b) => b.type === 'server_tool_use');

    log.info(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        searchUsed,
      },
      'Claude response with search generated',
    );

    return { text, searchUsed };
  } catch (err) {
    log.error({ err }, 'Claude API error (with search)');
    // Fallback to regular response without search
    log.info('falling back to regular generateResponse');
    const text = await generateResponse(messages, systemPrompt);
    return { text, searchUsed: false };
  }
}
