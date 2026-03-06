import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getHistory, saveMessage, shouldSummarize, getUnsummarizedMessages, saveSummary } from './memory.js';
import { toolDefinitions, executeTool, collectMedia } from './tools.js';
import type { UnifiedMessage, UnifiedReply } from '../channels/types.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Gemini fallback for when Claude rate-limits (429)
// Tries Gemini 2.5 Pro first (stronger), then 2.0 Flash (faster, higher rate limit)
async function callGemini(model: string, systemPrompt: string, contents: any[]): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${model} failed: ${res.status}`);
  const data = await res.json() as any;
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGeminiFallback(systemPrompt: string, messages: Anthropic.MessageParam[]): Promise<{ text: string; model: string }> {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : (m.content as any[]).filter((b: any) => b.type === 'text' || b.type === 'tool_result').map((b: any) => b.text || b.content || '').join('\n') }],
  }));

  // Try Gemini 2.5 Pro first (stronger), fall back to 2.0 Flash
  try {
    const text = await callGemini('gemini-2.5-pro-preview-06-05', systemPrompt, contents);
    if (text) return { text, model: 'Gemini 2.5 Pro' };
  } catch (e: any) {
    console.warn(`[Agent] Gemini 2.5 Pro failed: ${e.message}, trying 2.0 Flash...`);
  }

  const text = await callGemini('gemini-2.0-flash', systemPrompt, contents);
  return { text: text || 'לא הצלחתי לעבד (fallback).', model: 'Gemini 2.0 Flash' };
}

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

  // If user sent a PDF document, add it to the last message
  if (msg.document) {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: msg.document } },
        { type: 'text', text: msg.text || 'נתח את המסמך הזה' },
      ];
    }
  }

  const systemPrompt = await buildSystemPrompt(msg.text, msg.channel, msg.senderId);

  // Agent loop — handle tool calls, with Gemini fallback on rate limit
  let replyText: string;
  let modelUsed = 'Claude Sonnet 4';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    let response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools: toolDefinitions,
      messages,
    });
    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

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
      totalInputTokens += response.usage?.input_tokens || 0;
      totalOutputTokens += response.usage?.output_tokens || 0;
    }

    // Extract text response
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );
    replyText = textBlocks.map(b => b.text).join('\n');
    if (!replyText && toolIteration >= MAX_TOOL_ITERATIONS) {
      replyText = 'ביצעתי פעולות אבל הגעתי למגבלת הכלים. נסה לנסח את הבקשה מחדש.';
    } else if (!replyText) {
      replyText = 'קיבלתי את ההודעה אבל לא הצלחתי לייצר תשובה. נסה שוב.';
    }
  } catch (err: any) {
    // Fallback to Gemini on rate limit (429) or overload (529)
    if (err?.status === 429 || err?.status === 529) {
      console.warn(`[Agent] Claude ${err.status} — falling back to Gemini`);
      try {
        const fallback = await callGeminiFallback(systemPrompt, messages);
        replyText = fallback.text;
        modelUsed = `${fallback.model} (fallback)`;
      } catch (geminiErr: any) {
        console.error('[Agent] Gemini fallback also failed:', geminiErr.message);
        throw err;
      }
    } else {
      throw err;
    }
  }

  // Append model/usage footer
  const env = config.mode === 'cloud' ? '☁️ ענן' : '🖥️ מחשב';
  const costInput = (totalInputTokens / 1_000_000) * 3;   // $3/M input tokens
  const costOutput = (totalOutputTokens / 1_000_000) * 15; // $15/M output tokens
  const totalCost = costInput + costOutput;
  const costStr = modelUsed.includes('Gemini') ? 'חינם' : `$${totalCost.toFixed(4)}`;
  replyText += `\n\n_${env} | ${modelUsed} | ${totalInputTokens.toLocaleString()}↓ ${totalOutputTokens.toLocaleString()}↑ | ${costStr}_`;

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
