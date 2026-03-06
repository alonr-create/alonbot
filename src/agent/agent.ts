import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getHistory, saveMessage, shouldSummarize, getUnsummarizedMessages, saveSummary } from './memory.js';
import { toolDefinitions, executeTool, collectMedia } from './tools.js';
import type { UnifiedMessage, UnifiedReply } from '../channels/types.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Rate limiting: max 10 messages per minute per user
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(userId) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT) return false;
  timestamps.push(now);
  rateLimitMap.set(userId, timestamps);
  return true;
}

export async function handleMessage(msg: UnifiedMessage): Promise<UnifiedReply> {
  // Rate limit check
  if (!checkRateLimit(msg.senderId)) {
    return { text: 'יותר מדי הודעות. נסה שוב בעוד דקה.' };
  }

  // Truncate excessively long messages
  if (msg.text.length > 4000) {
    msg.text = msg.text.slice(0, 4000) + '\n[ההודעה קוצרה — מקסימום 4000 תווים]';
  }

  // Save user message
  saveMessage(msg.channel, msg.senderId, msg.senderName, 'user', msg.text);

  // Build conversation
  const history = getHistory(msg.channel, msg.senderId);
  const messages: Anthropic.MessageParam[] = history.map(h => ({
    role: h.role as 'user' | 'assistant',
    content: h.content,
  }));

  // If user sent an image, add it to the last message as vision content
  if (msg.image) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.content = [
        { type: 'image', source: { type: 'base64', media_type: msg.imageMediaType || 'image/jpeg', data: msg.image } },
        { type: 'text', text: msg.text || 'מה יש בתמונה?' },
      ];
    }
  }

  const systemPrompt = await buildSystemPrompt(msg.text, msg.channel, msg.senderId);

  // Agent loop — handle tool calls
  let response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    tools: toolDefinitions,
    messages,
  });

  // Process tool calls in a loop (max 15 iterations to prevent runaway)
  const MAX_TOOL_ITERATIONS = 15;
  let toolIteration = 0;
  while (response.stop_reason === 'tool_use' && toolIteration < MAX_TOOL_ITERATIONS) {
    toolIteration++;
    const toolBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolBlocks) {
      console.log(`[Tool] ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
      const result = await executeTool(block.name, block.input as Record<string, any>);
      console.log(`[Tool] → ${result.slice(0, 100)}`);
      toolResults.push({
        type: 'tool_result' as const,
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
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

  // Auto-summarize old messages if threshold reached
  if (shouldSummarize(msg.channel, msg.senderId)) {
    summarizeInBackground(msg.channel, msg.senderId).catch(err =>
      console.error('[Summarize] Error:', err.message)
    );
  }

  // Collect any media from tool calls
  const media = collectMedia();
  const reply: UnifiedReply = { text: replyText };

  for (const m of media) {
    if (m.type === 'image') reply.image = m.data;
    if (m.type === 'voice') reply.voice = m.data;
  }

  return reply;
}

async function summarizeInBackground(channel: string, senderId: string) {
  const unsummarized = getUnsummarizedMessages(channel, senderId);
  if (unsummarized.length < 40) return;

  const conversationText = unsummarized
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: 'אתה מסכם שיחות. תן סיכום קצר (3-5 משפטים) של השיחה, וציין נושאים עיקריים כ-JSON array.',
    messages: [{
      role: 'user',
      content: `סכם את השיחה הבאה:\n\n${conversationText.slice(0, 8000)}\n\nהחזר בפורמט:\nסיכום: [הסיכום]\nנושאים: ["נושא1", "נושא2"]`,
    }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  const summaryMatch = text.match(/סיכום:\s*(.+?)(?:\n|$)/);
  const topicsMatch = text.match(/נושאים:\s*(\[.+?\])/);

  const summary = summaryMatch?.[1]?.trim() || text.slice(0, 500);
  let topics: string[] = [];
  try {
    topics = topicsMatch ? JSON.parse(topicsMatch[1]) : [];
  } catch { /* ok */ }

  const fromDate = unsummarized[0].created_at;
  const toDate = unsummarized[unsummarized.length - 1].created_at;

  saveSummary(channel, senderId, summary, topics, unsummarized.length, fromDate, toDate);
  console.log(`[Summarize] Saved summary for ${channel}/${senderId}: ${unsummarized.length} messages → "${summary.slice(0, 80)}..."`);
}
