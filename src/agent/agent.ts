import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getHistory, saveMessage } from './memory.js';
import { toolDefinitions, executeTool } from './tools.js';
import type { UnifiedMessage, UnifiedReply } from '../channels/types.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export async function handleMessage(msg: UnifiedMessage): Promise<UnifiedReply> {
  // Save user message
  saveMessage(msg.channel, msg.senderId, msg.senderName, 'user', msg.text);

  // Build conversation
  const history = getHistory(msg.channel, msg.senderId);
  const messages: Anthropic.MessageParam[] = history.map(h => ({
    role: h.role as 'user' | 'assistant',
    content: h.content,
  }));

  const systemPrompt = buildSystemPrompt();

  // Agent loop — handle tool calls
  let response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: systemPrompt,
    tools: toolDefinitions,
    messages,
  });

  // Process tool calls in a loop
  while (response.stop_reason === 'tool_use') {
    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = toolBlocks.map(block => ({
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: executeTool(block.name, block.input as Record<string, string>),
    }));

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      tools: toolDefinitions,
      messages,
    });
  }

  // Extract text response
  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === 'text'
  );
  const replyText = textBlocks.map(b => b.text).join('\n') || 'לא הצלחתי לעבד את ההודעה.';

  // Save assistant response
  saveMessage(msg.channel, msg.senderId, msg.senderName, 'assistant', replyText);

  return { text: replyText };
}
