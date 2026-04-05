import Anthropic from '@anthropic-ai/sdk';
import { config } from '../utils/config.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getHistory, getSmartContext, saveMessage, shouldSummarize, getUnsummarizedMessages, saveSummary, extractEntities, indexDocumentToMemory, autoSaveCorrection, trackSentiment, tagConversationTopics, getContextBridge, extractCommitments, extractRelationships } from './memory.js';
import { getToolDefinitions, executeTool, collectMedia, collectInteractive, setCurrentRequestId } from './tools.js';
import { VOICE_PRESETS } from '../tools/handlers/send-voice.js';
import { searchKnowledge } from './knowledge.js';
import { db } from '../utils/db.js';
import type { UnifiedMessage, UnifiedReply } from '../channels/types.js';
import { withRetry } from '../utils/retry.js';
import { createLogger } from '../utils/logger.js';
import { classifyComplexity, selectModel, buildModelCatalog, callFreeModel, type ModelTier } from './model-router.js';

const log = createLogger('agent');
const client = new Anthropic({ apiKey: config.anthropicApiKey });

function nowIsrael(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}

// Build model catalog once at startup
const modelCatalog = buildModelCatalog();
log.info({ models: modelCatalog.map(m => `${m.provider}/${m.model} (${m.tier})`).join(', ') }, 'model catalog');

// Gemini fallback for when Claude rate-limits (429)
async function callGeminiFallback(systemPrompt: string, messages: Anthropic.MessageParam[]): Promise<{ text: string; model: string }> {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : (m.content as any[]).filter((b: any) => b.type === 'text' || b.type === 'tool_result').map((b: any) => b.text || b.content || '').join('\n') }],
  }));

  // Try free tier models from catalog
  const freeModels = modelCatalog.filter(m => m.tier === 'free' && m.apiKey);
  for (const fm of freeModels) {
    try {
      const result = await callFreeModel(fm, systemPrompt, contents.map(c => ({ role: c.role === 'model' ? 'assistant' as const : 'user' as const, content: c.parts[0].text })));
      if (result.text) return { text: result.text, model: `${fm.provider}/${fm.model}` };
    } catch (e: any) {
      log.warn({ err: e.message, model: fm.model }, 'free model fallback failed');
    }
  }

  return { text: 'לא הצלחתי לעבד (כל המודלים נכשלו).', model: 'none' };
}

// Rate limiting: max 10 messages per minute per user (DB-backed, survives restarts)
const RATE_LIMIT = 10;

const stmtRateLimitCheck = db.prepare(
  "SELECT COUNT(*) as count FROM rate_limits WHERE user_id = ? AND timestamp > datetime(?, '-60 seconds')"
);
const stmtRateLimitAdd = db.prepare(
  "INSERT INTO rate_limits (user_id, timestamp) VALUES (?, ?)"
);
const stmtRateLimitClean = db.prepare(
  "DELETE FROM rate_limits WHERE timestamp < datetime(?, '-5 minutes')"
);

function checkRateLimit(userId: string): boolean {
  // Skip rate limiting for the owner
  if (config.allowedTelegram.includes(userId) || config.allowedWhatsApp.includes(userId)) return true;
  const now = nowIsrael();
  const row = stmtRateLimitCheck.get(userId, now) as { count: number };
  if (row.count >= RATE_LIMIT) return false;
  stmtRateLimitAdd.run(userId, now);
  return true;
}

// Cleanup old rate limit entries every 10 minutes
setInterval(() => {
  try { stmtRateLimitClean.run(nowIsrael()); } catch (e) { log.debug({ err: (e as Error).message }, 'document index to memory failed'); }
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

  // Save user message (skip internal SYSTEM prompts from cron follow-ups)
  if (!msg.text.startsWith('[SYSTEM:')) {
    saveMessage(msg.channel, msg.senderId, msg.senderName, 'user', msg.text);
  }

  // Extract entities from user message (non-blocking)
  try { extractEntities(msg.text, `${msg.channel}:${msg.senderId}`); } catch (e) { log.debug({ err: (e as Error).message }, 'entity extraction failed'); }

  // Auto-detect corrections and save as feedback (non-blocking)
  try { autoSaveCorrection(msg.text, msg.channel, msg.senderId); } catch (e) { log.debug({ err: (e as Error).message }, 'auto correction save failed'); }

  // Track sentiment (non-blocking)
  try { trackSentiment(msg.channel, msg.senderId, msg.text); } catch (e) { log.debug({ err: (e as Error).message }, 'sentiment tracking failed'); }

  // Tag conversation topics (non-blocking)
  try { tagConversationTopics(msg.channel, msg.senderId, msg.text); } catch (e) { log.debug({ err: (e as Error).message }, 'topic tagging failed'); }

  // Extract commitments/promises (non-blocking)
  try { extractCommitments(msg.text, msg.channel, msg.senderId); } catch (e) { log.debug({ err: (e as Error).message }, 'commitment extraction failed'); }

  // Extract relationships (non-blocking)
  try { extractRelationships(msg.text, `${msg.channel}:${msg.senderId}`); } catch (e) { log.debug({ err: (e as Error).message }, 'relationship extraction failed'); }

  // Build conversation with smart context (relevant old messages beyond the window)
  const history = getHistory(msg.channel, msg.senderId);
  const smartCtx = getSmartContext(msg.channel, msg.senderId, msg.text);
  const messages: Anthropic.MessageParam[] = [];

  // Inject context bridge (what was discussed last time) if returning after a break
  const bridge = getContextBridge(msg.channel, msg.senderId);
  if (bridge) {
    messages.push({ role: 'user', content: bridge });
    messages.push({ role: 'assistant', content: 'הבנתי, אני זוכר את ההקשר מהפעם הקודמת.' });
  }

  // Inject smart context as early system-like messages (before recent history)
  if (smartCtx.length > 0) {
    messages.push({ role: 'user', content: '[הקשר רלוונטי משיחות קודמות]\n' + smartCtx.map(s => `${s.role}: ${s.content}`).join('\n') });
    messages.push({ role: 'assistant', content: 'הבנתי, אני זוכר את ההקשר הזה.' });
  }

  // Add recent conversation history
  for (const h of history) {
    messages.push({ role: h.role as 'user' | 'assistant', content: h.content });
  }

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
  const useOpus = msg.text.startsWith('[OPUS] ') || /אופוס/i.test(msg.text) || /^opus\b/i.test(msg.text);
  if (useOpus) {
    const isKeywordOnly = /^(\[OPUS\] )?אופוס$/i.test(msg.text.trim()) || /^תחליף לאופוס$/i.test(msg.text.trim()) || /^opus$/i.test(msg.text.trim());
    const cleanText = isKeywordOnly ? 'עברתי לאופוס. מה תרצה לשאול?' : msg.text.replace(/^\[OPUS\] /, '').replace(/^opus\s*/i, '').replace(/תחליף לאופוס[,.]?\s*/i, '').trim();
    // Update saved message to strip prefix (already saved above with prefix)
    try { db.prepare("UPDATE messages SET content = ? WHERE channel = ? AND sender_id = ? ORDER BY id DESC LIMIT 1").run(cleanText, msg.channel, msg.senderId); } catch (e: any) { log.debug({ err: e.message }, 'failed to strip OPUS prefix from DB'); }
    msg.text = cleanText;
    // Update the last message in history to strip prefix too
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.content = typeof lastMsg.content === 'string'
        ? lastMsg.content.replace(/^\[OPUS\] /, '')
        : lastMsg.content;
    }
  }

  // Smart model routing — classify complexity and pick the right model
  const hasMedia = !!(msg.image || msg.document);
  const routedTier: ModelTier = useOpus ? 'premium' : classifyComplexity(msg.text, hasMedia, history.length);
  const routingDecision = selectModel(routedTier, modelCatalog, useOpus ? 'claude-opus-4-6' : undefined);
  const modelId = routingDecision.model.model;
  const isFreeTier = routedTier === 'free' && routingDecision.model.provider !== 'anthropic';
  log.info({ tier: routedTier, model: modelId, provider: routingDecision.model.provider, reason: routingDecision.reason }, 'model routing');

  // Detect if this is a lead conversation (not Alon) — for privacy redaction in tools
  let isLeadConversation = false;
  if (msg.channel === 'whatsapp' && msg.senderId) {
    try {
      const lead = db.prepare('SELECT 1 FROM leads WHERE phone = ?').get(msg.senderId);
      isLeadConversation = !!lead;
    } catch (e) { log.debug({ err: (e as Error).message }, 'leads table check failed'); }
  }

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
  const useThinking = isComplex && !msg.image && !msg.document && !isLeadConversation; // Thinking off for leads (can return empty text blocks)

  // Agent loop — handle tool calls, with Gemini fallback on rate limit
  let replyText: string;
  let modelUsed = `${routingDecision.model.provider}/${routingDecision.model.model}`;
  if (routingDecision.model.provider === 'anthropic') {
    modelUsed = modelId.includes('opus') ? 'Claude Opus 4.6' : 'Claude Sonnet 4.6';
  }
  if (useThinking) modelUsed += ' 🧠';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // FREE TIER SHORTCUT — simple queries go to Gemini/Groq (no tools needed, saves $$$)
  // NEVER use free tier for lead conversations — they need tools (calendar, monday, send_voice)
  let usedFreeTier = false;
  if (isFreeTier && !isLeadConversation) {
    try {
      const flatMessages = messages
        .filter(m => typeof m.content === 'string')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
      // Flatten system prompt for non-Anthropic models (they only accept string)
      const flatPrompt = Array.isArray(systemPrompt) ? systemPrompt.map((b: any) => b.text).join('\n') : String(systemPrompt);
      const result = await callFreeModel(routingDecision.model, flatPrompt, flatMessages);
      replyText = result.text || 'לא הצלחתי לעבד.';
      totalInputTokens = result.inputTokens || 0;
      totalOutputTokens = result.outputTokens || 0;
      usedFreeTier = true;
      log.info({ model: modelUsed, tokens: totalInputTokens + totalOutputTokens }, 'free tier response');
    } catch (e: any) {
      log.warn({ err: e.message }, 'free tier failed, upgrading to balanced');
      // Fall through to Claude path below
      modelUsed = 'Claude Sonnet 4.6';
      replyText = ''; // will be filled by Claude path
    }

    if (usedFreeTier && replyText) {
      // Track API usage (free = $0)
      try {
        db.prepare('INSERT INTO api_usage (model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?)').run(
          modelUsed, totalInputTokens, totalOutputTokens, 0
        );
      } catch (e: any) { log.debug({ err: e.message }, 'api usage tracking failed'); }

      // Save and return
      saveMessage(msg.channel, msg.senderId, msg.senderName, 'assistant', replyText);
      const isAuthorizedUser = config.allowedWhatsApp.includes(msg.senderId) || config.allowedTelegram.includes(msg.senderId) || msg.channel === 'telegram';
      if (isAuthorizedUser) {
        const env = config.mode === 'cloud' ? '☁️ ענן' : '🖥️ מחשב';
        replyText += `\n\n_\u200E${env} | ${modelUsed} | חינם_`;
      }

      if (shouldSummarize(msg.channel, msg.senderId)) {
        summarizeInBackground(msg.channel, msg.senderId).catch(err => log.error({ err: err.message }, 'summarize error'));
      }
      return { text: replyText };
    }
  }

  // CLAUDE PATH — only if free tier was not used or failed
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
      } catch (e: any) { log.debug({ err: e.message }, 'knowledge search failed'); }
    }

    const createParams: any = {
      model: modelId,
      max_tokens: useOpus ? 16000 : 8192,
      system: systemPrompt,
      tools: getToolDefinitions(),
      messages,
    };
    if (useThinking) {
      createParams.thinking = { type: 'adaptive' };
    }
    if (hasKnowledgeDocs) {
      createParams.citations = { enabled: true };
    }

    // Token counting: log input size and auto-trim if near context limit
    try {
      const tokenCount = await client.messages.countTokens({
        model: modelId,
        system: systemPrompt,
        tools: getToolDefinitions() as any,
        messages,
      });
      const contextLimit = useOpus ? 200000 : 200000;
      log.info({ inputTokens: tokenCount.input_tokens, contextLimit }, 'token count');
      if (tokenCount.input_tokens > contextLimit * 0.85) {
        // Trim oldest messages to stay within budget
        const trimCount = Math.min(Math.ceil(messages.length / 3), messages.length - 2);
        messages.splice(0, trimCount);
        log.info({ trimCount }, 'trimmed old messages to fit context');
      }
    } catch (e: any) {
      log.warn({ err: e.message }, 'countTokens failed');
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
      log.info({ cacheReadTokens: usage.cache_read_input_tokens }, 'cache hit');
    }
    if (usage?.cache_creation_input_tokens) {
      log.info({ cacheCreatedTokens: usage.cache_creation_input_tokens }, 'cache created');
    }

    // Process tool calls in a loop (max 15 iterations to prevent runaway)
    const MAX_TOOL_ITERATIONS = 15;
    let toolIteration = 0;
    while (response.stop_reason === 'tool_use' && toolIteration < MAX_TOOL_ITERATIONS) {
      toolIteration++;
      const toolBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
      );

      // Notify streaming user BEFORE tool execution (so they see what's happening)
      if (onStream) {
        for (const block of toolBlocks) {
          onStream('', block.name);
        }
      }

      // Execute tools in parallel (Claude already decides which tools are independent)
      const TOOL_TIMEOUT_MS = 30_000;
      const toolPromises = toolBlocks.map(async (block) => {
        log.info({ tool: block.name, input: JSON.stringify(block.input).slice(0, 100) }, 'tool call');
        const toolStart = Date.now();
        const result = await Promise.race([
          executeTool(block.name, block.input as Record<string, any>, { isLeadConversation, senderId: msg.senderId, senderName: msg.senderName }),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`Tool ${block.name} timed out after ${TOOL_TIMEOUT_MS / 1000}s`)), TOOL_TIMEOUT_MS)),
        ]).catch((err: Error) => `Error: ${err.message}`);
        const toolDuration = Date.now() - toolStart;
        const toolSuccess = !result.startsWith('Error:') ? 1 : 0;
        log.info({ tool: block.name, result: result.slice(0, 100), durationMs: toolDuration }, 'tool result');
        try { db.prepare('INSERT INTO tool_usage (tool_name, success, duration_ms) VALUES (?, ?, ?)').run(block.name, toolSuccess, toolDuration); } catch (e: any) { log.debug({ err: e.message }, 'tool usage tracking failed'); }
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: result,
        };
      });
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(toolPromises);

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      // Notify streaming that tools finished and bot is thinking again
      if (onStream) {
        onStream('\n🤔 _חושב..._\n');
      }

      const continueParams: any = {
        model: modelId,
        max_tokens: useOpus ? 16000 : 8192,
        system: systemPrompt,
        tools: getToolDefinitions(),
        messages,
      };
      if (useThinking) {
        continueParams.thinking = { type: 'adaptive' };
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
      replyText = isLeadConversation ? 'שלום! קיבלתי את הודעתך. אחזור אליך בהקדם.' : 'ביצעתי פעולות אבל הגעתי למגבלת הכלים. נסה לנסח את הבקשה מחדש.';
    } else if (!replyText) {
      log.warn({ senderId: msg.senderId, channel: msg.channel }, 'empty response from Claude');
      replyText = isLeadConversation ? 'שלום! קיבלתי את הודעתך. אחזור אליך בהקדם.' : 'קיבלתי את ההודעה אבל לא הצלחתי לייצר תשובה. נסה שוב.';
    }
  } catch (err: any) {
    // Fallback to Gemini on rate limit (429), overload (529), or billing/auth errors (400/401)
    const fallbackStatuses = [400, 401, 429, 529];
    if (fallbackStatuses.includes(err?.status)) {
      log.warn({ status: err.status }, 'Claude error, falling back to Gemini');
      try {
        // Flatten system prompt for Gemini (it only accepts string)
        const flatPrompt = Array.isArray(systemPrompt) ? systemPrompt.map((b: any) => b.text).join('\n') : systemPrompt;
        const fallback = await callGeminiFallback(flatPrompt, messages);
        replyText = fallback.text;
        modelUsed = `${fallback.model} (fallback)`;
      } catch (geminiErr: any) {
        log.error({ err: geminiErr.message }, 'Gemini fallback also failed');
        throw err;
      }
    } else {
      throw err;
    }
  }

  // Track API usage — use actual model costs from routing decision
  const costInput = (totalInputTokens / 1_000) * (routingDecision.model.costPer1kInput || 0);
  const costOutput = (totalOutputTokens / 1_000) * (routingDecision.model.costPer1kOutput || 0);
  const totalCost = costInput + costOutput;
  try {
    db.prepare('INSERT INTO api_usage (model, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?)').run(
      modelUsed, totalInputTokens, totalOutputTokens, totalCost
    );
  } catch (e: any) { log.debug({ err: e.message }, 'api usage tracking failed'); }

  // Strip leaked tool call descriptions from text (e.g. "**כלי שנקרא:** `send_voice`")
  // This happens when the model describes tool calls in text instead of using tool_use API
  if (isLeadConversation) {
    replyText = replyText
      .replace(/\*\*כלי שנקרא:?\*\*[^\n]*/gi, '')
      .replace(/\*\*עם הטקסט:?\*\*[^\n]*/gi, '')
      .replace(/\*\*עם הקול:?\*\*[^\n]*/gi, '')
      .replace(/\(שלחתי לך גם הודעה קולית[^)]*\)/gi, '')
      .replace(/כלי שנקרא:?\s*`[^`]*`/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Save assistant response WITHOUT footer (keeps history clean for Claude)
  saveMessage(msg.channel, msg.senderId, msg.senderName, 'assistant', replyText);

  // Index document/image content to memory (non-blocking)
  if (msg.document || msg.image) {
    try {
      const docType = msg.document ? 'pdf' : 'image';
      // Index the AI's analysis of the document as searchable memory
      if (replyText.length > 50) {
        indexDocumentToMemory(replyText, `${msg.channel}:${msg.senderId}:${Date.now()}`, docType);
      }
    } catch (e) { log.debug({ err: (e as Error).message }, 'document index to memory failed'); }
  }

  // Prepend opus indicator (display-only, not in history)
  if (useOpus) {
    replyText = '🧠 עברתי לאופוס\n\n' + replyText;
  }

  // Append model/usage footer AFTER saving (display-only, not in history)
  // Only show footer to authorized users (not to leads)
  const isAuthorizedUser = config.allowedWhatsApp.includes(msg.senderId) || config.allowedTelegram.includes(msg.senderId) || msg.channel === 'telegram';
  if (isAuthorizedUser) {
    const env = config.mode === 'cloud' ? '☁️ ענן' : '🖥️ מחשב';
    const costStr = totalCost === 0 ? 'חינם' : `$${totalCost.toFixed(4)}`;
    replyText += `\n\n_\u200E${env} | ${modelUsed} | ${totalInputTokens.toLocaleString()}↓ ${totalOutputTokens.toLocaleString()}↑ | ${costStr}_`;
  }

  // Auto-summarize old messages if threshold reached
  if (shouldSummarize(msg.channel, msg.senderId)) {
    summarizeInBackground(msg.channel, msg.senderId).catch(err =>
      log.error({ err: err.message }, 'summarize error')
    );
  }

  // Collect any media from tool calls (per-request isolation)
  const media = collectMedia(requestId);
  const interactive = collectInteractive(requestId);
  const reply: UnifiedReply = { text: replyText };

  for (const m of media) {
    if (m.type === 'image') reply.image = m.data;
    if (m.type === 'voice') reply.voice = m.data;
    if (m.type === 'document') {
      reply.document = m.data;
      reply.documentName = m.filename;
      reply.documentMimetype = m.mimetype;
    }
  }

  // Attach interactive message (buttons/list/CTA) if queued via send_buttons tool
  if (interactive) {
    if (interactive.buttons) reply.buttons = interactive.buttons;
    if (interactive.listSections) reply.listSections = interactive.listSections;
    if (interactive.interactiveBody) reply.interactiveBody = interactive.interactiveBody;
    if (interactive.interactiveHeader) reply.interactiveHeader = interactive.interactiveHeader;
    if (interactive.interactiveFooter) reply.interactiveFooter = interactive.interactiveFooter;
    if (interactive.listButtonText) reply.listButtonText = interactive.listButtonText;
    if (interactive.ctaUrl) reply.ctaUrl = interactive.ctaUrl;
  }

  // Fallback: parse [interactive:buttons:...] from text if AI wrote it inline instead of using send_buttons tool
  if (!reply.buttons && !reply.listSections) {
    const btnMatch = reply.text.match(/\[interactive:buttons:(\[.*?\])\]/);
    if (btnMatch) {
      try {
        const titles: string[] = JSON.parse(btnMatch[1]);
        reply.buttons = titles.map((t, i) => ({ id: `btn_${i}`, title: t.slice(0, 20) }));
        reply.interactiveBody = reply.text.replace(/\[interactive:buttons:\[.*?\]\]\s*/g, '').trim();
        reply.text = reply.text.replace(/\[interactive:buttons:\[.*?\]\]\s*/g, '').trim();
      } catch {}
    }
    const listMatch = reply.text.match(/\[interactive:list:(\[.*?\])\]/);
    if (listMatch) {
      try {
        const titles: string[] = JSON.parse(listMatch[1]);
        reply.listSections = [{ title: 'אפשרויות', rows: titles.map((t, i) => ({ id: `opt_${i}`, title: t.slice(0, 24) })) }];
        reply.interactiveBody = reply.text.replace(/\[interactive:list:\[.*?\]\]\s*/g, '').trim();
        reply.text = reply.text.replace(/\[interactive:list:\[.*?\]\]\s*/g, '').trim();
      } catch {}
    }
    const ctaMatch = reply.text.match(/\[interactive:cta:([^:]+):([^\]]+)\]/);
    if (ctaMatch) {
      reply.ctaUrl = { display_text: ctaMatch[1], url: ctaMatch[2] };
      reply.interactiveBody = reply.text.replace(/\[interactive:cta:[^\]]+\]\s*/g, '').trim();
      reply.text = reply.text.replace(/\[interactive:cta:[^\]]+\]\s*/g, '').trim();
    }
  }

  // Voice-to-voice: if user sent voice message, auto-generate TTS reply
  if (msg.isVoice && !reply.voice && config.elevenlabsApiKey) {
    try {
      // Strip the footer for TTS (don't read out model info)
      const ttsText = replyText.replace(/\n\n_\u200E.*_$/, '').trim();
      if (ttsText.length > 0 && ttsText.length < 3000) {
        const isHebrew = /[\u0590-\u05FF]/.test(ttsText);
        const preset = isHebrew ? VOICE_PRESETS.alon : VOICE_PRESETS.english;
        const ttsRes = await withRetry(() => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${preset.id}?output_format=ogg_opus`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': config.elevenlabsApiKey },
          body: JSON.stringify({ text: ttsText, model_id: 'eleven_v3', voice_settings: preset.settings }),
        }));
        if (ttsRes.ok) {
          reply.voice = Buffer.from(await ttsRes.arrayBuffer());
          log.info({ bytes: reply.voice.length }, 'voice-to-voice TTS generated');
        }
      }
    } catch (e: any) {
      log.error({ err: e.message }, 'voice-to-voice TTS failed');
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
    log.info({ batchId, channel, senderId, messageCount: unsummarized.length }, 'submitted summarize batch');
  } else {
    log.error({ channel, senderId }, 'batch submit failed');
  }
}
