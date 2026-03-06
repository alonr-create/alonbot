import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getHistory, saveMessage, shouldSummarize, getUnsummarizedMessages, saveSummary } from './memory.js';
import { toolDefinitions, executeTool, collectMedia, setCurrentRequestId } from './tools.js';
import { searchKnowledge } from './knowledge.js';
import { db } from '../utils/db.js';
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

  // Try Gemini 2.5 Flash first (fast + capable), fall back to 2.0 Flash (higher rate limit)
  try {
    const text = await callGemini('gemini-2.5-flash', systemPrompt, contents);
    if (text) return { text, model: 'Gemini 2.5 Flash' };
  } catch (e: any) {
    console.warn(`[Agent] Gemini 2.5 Flash failed: ${e.message}, trying 2.0 Flash...`);
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

// Cleanup stale rate limit entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of rateLimitMap) {
    const active = timestamps.filter(t => now - t < RATE_WINDOW_MS);
    if (active.length === 0) rateLimitMap.delete(userId);
    else rateLimitMap.set(userId, active);
  }
}, 10 * 60_000);

export type StreamCallback = (text: string, toolName?: string) => void;

export async function handleMessage(msg: UnifiedMessage, onStream?: StreamCallback): Promise<UnifiedReply> {
  // Rate limit check
  if (!checkRateLimit(msg.senderId)) {
    return { text: 'יותר מדי הודעות. נסה שוב בעוד דקה.' };
  }

  // Per-request media isolation
  const requestId = `${msg.channel}-${msg.senderId}-${Date.now()}`;
  setCurrentRequestId(requestId);

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

  // Detect [OPUS] tag for on-demand model upgrade
  const useOpus = msg.text.startsWith('[OPUS] ');
  if (useOpus) {
    const cleanText = msg.text.slice(7);
    // Update saved message to strip prefix (already saved above with prefix)
    try { db.prepare("UPDATE messages SET content = ? WHERE channel = ? AND sender_id = ? ORDER BY id DESC LIMIT 1").run(cleanText, msg.channel, msg.senderId); } catch {}
    msg.text = cleanText;
    // Update the last message in history to strip prefix too
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.content = typeof lastMsg.content === 'string'
        ? lastMsg.content.replace(/^\[OPUS\] /, '')
        : lastMsg.content;
    }
  }

  const modelId = useOpus ? 'claude-opus-4-20250514' : 'claude-sonnet-4-20250514';
  const systemPrompt = await buildSystemPrompt(msg.text, msg.channel, msg.senderId);

  // Multi-turn caching: mark the second-to-last message for cache breakpoint
  // Claude will cache everything up to this point (system + history) across turns
  if (messages.length >= 3) {
    const cacheMsgIdx = messages.length - 2;
    const cacheMsg = messages[cacheMsgIdx];
    if (typeof cacheMsg.content === 'string') {
      messages[cacheMsgIdx] = { ...cacheMsg, content: [{ type: 'text', text: cacheMsg.content, cache_control: { type: 'ephemeral' } }] as any };
    }
  }

  // Detect complex queries for extended thinking
  const thinkingKeywords = ['נתח', 'השווה', 'תכנן', 'אסטרטגיה', 'הסבר לעומק', 'ניתוח', 'יתרונות וחסרונות', 'מה ההבדל', 'תחשוב'];
  const isComplex = useOpus || msg.text.length > 150 || thinkingKeywords.some(kw => msg.text.includes(kw));
  const useThinking = isComplex && !msg.image && !msg.document; // Thinking doesn't mix well with vision

  // Agent loop — handle tool calls, with Gemini fallback on rate limit
  let replyText: string;
  let modelUsed = useOpus ? 'Claude Opus 4' : 'Claude Sonnet 4';
  if (useThinking) modelUsed += ' 🧠';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    // Knowledge base: inject as document blocks for citation support
    let hasKnowledgeDocs = false;
    if (msg.text.length >= 5 && !msg.image && !msg.document) {
      try {
        const kResults = await searchKnowledge(msg.text, 3);
        if (kResults.length > 0) {
          hasKnowledgeDocs = true;
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.role === 'user') {
            const docBlocks: any[] = kResults.map(r => ({
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', data: r.content },
              title: r.title,
              citations: { enabled: true },
            }));
            const userContent = typeof lastMsg.content === 'string'
              ? [{ type: 'text', text: lastMsg.content }]
              : lastMsg.content;
            lastMsg.content = [...docBlocks, ...(userContent as any[])];
          }
        }
      } catch {}
    }

    const createParams: any = {
      model: modelId,
      max_tokens: useOpus ? 16000 : 8192,
      system: systemPrompt,
      tools: toolDefinitions,
      messages,
    };
    if (useThinking) {
      createParams.thinking = { type: 'enabled', budget_tokens: useOpus ? 10000 : 5000 };
    }
    if (hasKnowledgeDocs) {
      createParams.citations = { enabled: true };
    }

    // Token counting: log input size and auto-trim if near context limit
    try {
      const tokenCount = await client.messages.countTokens({
        model: modelId,
        system: systemPrompt,
        tools: toolDefinitions as any,
        messages,
      });
      const contextLimit = useOpus ? 200000 : 200000;
      console.log(`[Tokens] Input: ${tokenCount.input_tokens.toLocaleString()} / ${contextLimit.toLocaleString()}`);
      if (tokenCount.input_tokens > contextLimit * 0.85) {
        // Trim oldest messages to stay within budget
        const trimCount = Math.min(Math.ceil(messages.length / 3), messages.length - 2);
        messages.splice(0, trimCount);
        console.log(`[Tokens] Trimmed ${trimCount} old messages to fit context`);
      }
    } catch (e: any) {
      console.warn(`[Tokens] countTokens failed: ${e.message}`);
    }

    // Helper: call Claude with optional streaming
    async function callClaude(params: any): Promise<Anthropic.Message> {
      if (onStream) {
        const stream = client.messages.stream(params);
        stream.on('text', (text) => onStream(text));
        const msg = await stream.finalMessage();
        return msg;
      }
      return client.messages.create(params);
    }

    let response = await callClaude(createParams);
    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;
    // Log cache metrics
    const usage = response.usage as any;
    if (usage?.cache_read_input_tokens) {
      console.log(`[Cache] Hit: ${usage.cache_read_input_tokens} tokens read from cache`);
    }
    if (usage?.cache_creation_input_tokens) {
      console.log(`[Cache] Created: ${usage.cache_creation_input_tokens} tokens cached`);
    }

    // Process tool calls in a loop (max 15 iterations to prevent runaway)
    const MAX_TOOL_ITERATIONS = 15;
    let toolIteration = 0;
    while (response.stop_reason === 'tool_use' && toolIteration < MAX_TOOL_ITERATIONS) {
      toolIteration++;
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      // Execute tools in parallel (Claude already decides which tools are independent)
      const toolPromises = toolBlocks.map(async (block) => {
        console.log(`[Tool] ${block.name}(${JSON.stringify(block.input).slice(0, 100)})`);
        const toolStart = Date.now();
        const result = await executeTool(block.name, block.input as Record<string, any>);
        const toolDuration = Date.now() - toolStart;
        const toolSuccess = !result.startsWith('Error:') ? 1 : 0;
        console.log(`[Tool] → ${result.slice(0, 100)} (${toolDuration}ms)`);
        try { db.prepare('INSERT INTO tool_usage (tool_name, success, duration_ms) VALUES (?, ?, ?)').run(block.name, toolSuccess, toolDuration); } catch {}
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: result,
        };
      });
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(toolPromises);

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      const continueParams: any = {
        model: modelId,
        max_tokens: useOpus ? 16000 : 8192,
        system: systemPrompt,
        tools: toolDefinitions,
        messages,
      };
      if (useThinking) {
        continueParams.thinking = { type: 'enabled', budget_tokens: useOpus ? 10000 : 5000 };
      }
      // Notify streaming user about tool execution
      if (onStream) {
        for (const block of toolBlocks) {
          onStream('', block.name);
        }
      }
      response = await callClaude(continueParams);
      totalInputTokens += response.usage?.input_tokens || 0;
      totalOutputTokens += response.usage?.output_tokens || 0;
    }

    // Extract text response (filter out thinking blocks, include citations)
    const textParts: string[] = [];
    const citedSources = new Set<string>();
    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
        // Check for citation markers within text blocks
        if ('citations' in block && Array.isArray((block as any).citations)) {
          for (const cite of (block as any).citations) {
            if (cite.document_title) citedSources.add(cite.document_title);
          }
        }
      }
    }
    replyText = textParts.join('\n');
    // Append cited sources footer if any
    if (citedSources.size > 0) {
      replyText += `\n\n📎 מקורות: ${[...citedSources].join(', ')}`;
    }
    if (!replyText && toolIteration >= MAX_TOOL_ITERATIONS) {
      replyText = 'ביצעתי פעולות אבל הגעתי למגבלת הכלים. נסה לנסח את הבקשה מחדש.';
    } else if (!replyText) {
      replyText = 'קיבלתי את ההודעה אבל לא הצלחתי לייצר תשובה. נסה שוב.';
    }
  } catch (err: any) {
    // Fallback to Gemini on rate limit (429), overload (529), or billing/auth errors (400/401)
    const fallbackStatuses = [400, 401, 429, 529];
    if (fallbackStatuses.includes(err?.status)) {
      console.warn(`[Agent] Claude ${err.status} — falling back to Gemini`);
      try {
        // Flatten system prompt for Gemini (it only accepts string)
        const flatPrompt = Array.isArray(systemPrompt) ? systemPrompt.map((b: any) => b.text).join('\n') : systemPrompt;
        const fallback = await callGeminiFallback(flatPrompt, messages);
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

  // Track API usage (Opus: $15/$75, Sonnet: $3/$15 per M tokens)
  const inputRate = useOpus ? 15 : 3;
  const outputRate = useOpus ? 75 : 15;
  const costInput = (totalInputTokens / 1_000_000) * inputRate;
  const costOutput = (totalOutputTokens / 1_000_000) * outputRate;
  const totalCost = costInput + costOutput;
  try {
    db.prepare('INSERT INTO api_usage (model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?)').run(
      modelUsed, totalInputTokens, totalOutputTokens, totalCost
    );
  } catch { /* ok */ }

  // Save assistant response WITHOUT footer (keeps history clean for Claude)
  saveMessage(msg.channel, msg.senderId, msg.senderName, 'assistant', replyText);

  // Append model/usage footer AFTER saving (display-only, not in history)
  const env = config.mode === 'cloud' ? '☁️ ענן' : '🖥️ מחשב';
  const costStr = modelUsed.includes('Gemini') ? 'חינם' : `$${totalCost.toFixed(4)}`;
  replyText += `\n\n_\u200E${env} | ${modelUsed} | ${totalInputTokens.toLocaleString()}↓ ${totalOutputTokens.toLocaleString()}↑ | ${costStr}_`;

  // Auto-summarize old messages if threshold reached
  if (shouldSummarize(msg.channel, msg.senderId)) {
    summarizeInBackground(msg.channel, msg.senderId).catch(err =>
      console.error('[Summarize] Error:', err.message)
    );
  }

  // Collect any media from tool calls (per-request isolation)
  const media = collectMedia(requestId);
  const reply: UnifiedReply = { text: replyText };

  for (const m of media) {
    if (m.type === 'image') reply.image = m.data;
    if (m.type === 'voice') reply.voice = m.data;
  }

  // Voice-to-voice: if user sent voice message, auto-generate TTS reply
  if (msg.isVoice && !reply.voice && config.elevenlabsApiKey) {
    try {
      // Strip the footer for TTS (don't read out model info)
      const ttsText = replyText.replace(/\n\n_\u200E.*_$/, '').trim();
      if (ttsText.length > 0 && ttsText.length < 3000) {
        const isHebrew = /[\u0590-\u05FF]/.test(ttsText);
        const voiceId = isHebrew ? config.elevenlabsVoiceId : 'nPczCjzI2devNBz1zQrb';
        const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': config.elevenlabsApiKey },
          body: JSON.stringify({ text: ttsText, model_id: 'eleven_v3', voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 } }),
        });
        if (ttsRes.ok) {
          reply.voice = Buffer.from(await ttsRes.arrayBuffer());
          console.log(`[Agent] Voice-to-voice: generated ${reply.voice.length} bytes TTS`);
        }
      }
    } catch (e: any) {
      console.error('[Agent] Voice-to-voice TTS failed:', e.message);
    }
  }

  return reply;
}

async function summarizeInBackground(channel: string, senderId: string) {
  const unsummarized = getUnsummarizedMessages(channel, senderId);
  if (unsummarized.length < 40) return;

  const conversationText = unsummarized
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  const fromDate = unsummarized[0].created_at;
  const toDate = unsummarized[unsummarized.length - 1].created_at;

  // Use Batch API (50% cheaper, async processing)
  const { submitSummarizeBatch } = await import('./batch.js');
  const batchId = await submitSummarizeBatch(
    channel, senderId, conversationText, fromDate, toDate, unsummarized.length
  );
  if (batchId) {
    console.log(`[Summarize] Submitted batch ${batchId} for ${channel}/${senderId} (${unsummarized.length} messages)`);
  } else {
    console.error(`[Summarize] Batch submit failed for ${channel}/${senderId}`);
  }
}
