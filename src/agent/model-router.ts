/**
 * AI Model Router — Smart routing between models for cost optimization.
 *
 * Strategy:
 * - Simple queries (greetings, short answers) → free/cheap model (Gemini Flash / Groq)
 * - Medium queries (tasks, tools, memory) → balanced model (Claude Sonnet)
 * - Complex queries (long reasoning, multi-step) → premium model (Claude Opus)
 *
 * Ported from AliClaw, adapted for AalonBot.
 */

import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';

const log = createLogger('model-router');

export type ModelTier = 'free' | 'balanced' | 'premium';

export interface ModelConfig {
  provider: 'anthropic' | 'gemini' | 'openai' | 'groq' | 'ollama' | 'openrouter';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  tier: ModelTier;
  maxTokens?: number;
  costPer1kInput?: number;
  costPer1kOutput?: number;
}

export interface RoutingDecision {
  model: ModelConfig;
  reason: string;
  estimatedCost: string;
}

// Model alias resolution
const MODEL_ALIASES: Record<string, string> = {
  'claude-sonnet-latest': 'claude-sonnet-4-6',
  'claude-opus-latest': 'claude-opus-4-6',
};

export function resolveModelAlias(model: string): string {
  return MODEL_ALIASES[model] || model;
}

// Patterns for classification
const SIMPLE_PATTERNS = [
  /^(hi|hey|hello|שלום|היי|מה נשמע|מה קורה|בוקר טוב|ערב טוב|תודה|ביי|להתראות)/i,
  /^(what time|מה השעה|what date|מה התאריך)/i,
  /^(yes|no|כן|לא|אוקיי|ok|sure|בסדר)$/i,
];

const COMPLEX_PATTERNS = [
  /\b(analyze|אנלז|compare|השווה|explain in detail|הסבר לעומק|write a full|כתוב מלא|create a plan|תכנן|refactor|debug|architect)\b/i,
  /\b(multi.?step|מרובה שלבים|comprehensive|מקיף|in-depth|לעומק)\b/i,
];

const TOOL_PATTERNS = [
  /\b(search|חפש|browse|גלוש|screenshot|צילום|file|קובץ|shell|terminal|remember|תזכור|task|משימה|voice|קול|cron)\b/i,
  /\b(camera|מצלמה|צלם|תמונה|image|generate|ייצר|תייצר|create|weather|מזג אוויר|translate|תרגם|remind|תזכורת|calculate|חשב)\b/i,
  /\b(install|התקן|skill|improve|שפר|שדרג|upgrade|cron|schedule|תזמן|knowledge|ידע|analyze|נתח|scrape|email|אימייל)\b/i,
];

export function classifyComplexity(text: string, hasMedia: boolean, historyLength: number): ModelTier {
  // Only very short, obvious greetings/confirmations go to free tier
  if (!hasMedia && text.length < 15 && SIMPLE_PATTERNS.some(p => p.test(text)) && !TOOL_PATTERNS.some(p => p.test(text))) {
    return 'free';
  }

  // Explicit complex patterns
  if (COMPLEX_PATTERNS.some(p => p.test(text))) {
    return 'premium';
  }

  // Tool usage hints = balanced (needs tool calling)
  if (TOOL_PATTERNS.some(p => p.test(text))) {
    return 'balanced';
  }

  // Long messages or media = balanced
  if (text.length > 500 || hasMedia) {
    return 'balanced';
  }

  // Deep conversation (many turns) = balanced
  if (historyLength > 10) {
    return 'balanced';
  }

  // Default: balanced
  return 'balanced';
}

export function selectModel(
  tier: ModelTier,
  availableModels: ModelConfig[],
  userOverride?: string,
): RoutingDecision {
  // User override always wins
  if (userOverride) {
    const override = availableModels.find(m => m.model === userOverride || m.provider === userOverride);
    if (override) {
      return { model: override, reason: `User override: ${override.model}`, estimatedCost: formatCost(override) };
    }
  }

  // Find models for the requested tier
  let candidates = availableModels.filter(m => m.tier === tier && m.apiKey);

  // Fallback to adjacent tier
  if (candidates.length === 0) {
    if (tier === 'free') candidates = availableModels.filter(m => m.tier === 'balanced' && m.apiKey);
    else if (tier === 'premium') candidates = availableModels.filter(m => m.tier === 'balanced' && m.apiKey);
    else candidates = availableModels.filter(m => m.apiKey);
  }

  // Last resort: any available model
  if (candidates.length === 0) {
    candidates = availableModels.filter(m => m.apiKey);
  }

  if (candidates.length === 0) {
    throw new Error('No AI models configured with API keys');
  }

  // For balanced/premium: prefer Anthropic (tool support), then cheapest
  // For free: pick cheapest
  let model: ModelConfig;
  if (tier === 'free') {
    model = candidates.sort((a, b) => (a.costPer1kInput || 0) - (b.costPer1kInput || 0))[0];
  } else {
    const anthropicCandidates = candidates.filter(m => m.provider === 'anthropic');
    model = anthropicCandidates.length > 0
      ? anthropicCandidates[0]
      : candidates.sort((a, b) => (a.costPer1kInput || 0) - (b.costPer1kInput || 0))[0];
  }

  return { model, reason: `${tier} tier → ${model.provider}/${model.model}`, estimatedCost: formatCost(model) };
}

function formatCost(m: ModelConfig): string {
  if (!m.costPer1kInput && !m.costPer1kOutput) return 'free';
  return `~$${((m.costPer1kInput || 0) * 2 + (m.costPer1kOutput || 0) * 1).toFixed(4)}/msg`;
}

/**
 * Build available models from AalonBot config + env keys
 */
export function buildModelCatalog(): ModelConfig[] {
  const models: ModelConfig[] = [];

  // Anthropic — balanced (Sonnet) + premium (Opus)
  if (config.anthropicApiKey) {
    models.push({
      provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: config.anthropicApiKey,
      tier: 'balanced', costPer1kInput: 0.003, costPer1kOutput: 0.015,
    });
    models.push({
      provider: 'anthropic', model: 'claude-opus-4-6', apiKey: config.anthropicApiKey,
      tier: 'premium', costPer1kInput: 0.015, costPer1kOutput: 0.075,
    });
  }

  // Gemini — free (Flash) + balanced (Pro)
  if (config.geminiApiKey) {
    models.push({
      provider: 'gemini', model: 'gemini-2.5-flash', apiKey: config.geminiApiKey,
      tier: 'free', costPer1kInput: 0, costPer1kOutput: 0,
    });
    models.push({
      provider: 'gemini', model: 'gemini-2.5-pro', apiKey: config.geminiApiKey,
      tier: 'balanced', costPer1kInput: 0.00125, costPer1kOutput: 0.01,
    });
  }

  // Groq — free
  if (config.groqApiKey) {
    models.push({
      provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: config.groqApiKey,
      tier: 'free', costPer1kInput: 0, costPer1kOutput: 0,
    });
  }

  // OpenRouter — balanced (access to 100+ models)
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    models.push({
      provider: 'openrouter', model: 'openrouter/auto', apiKey: openrouterKey,
      tier: 'balanced', costPer1kInput: 0.003, costPer1kOutput: 0.015,
    });
  }

  return models;
}

/**
 * Call a non-Anthropic model (Gemini, Groq, OpenRouter, etc.)
 * For free-tier routing — simple queries that don't need tools.
 */
export async function callFreeModel(
  model: ModelConfig,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {

  if (model.provider === 'gemini') {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent?key=${model.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: { maxOutputTokens: 4096 },
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const data = await res.json() as any;
    return {
      text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
    };
  }

  if (model.provider === 'groq') {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${model.apiKey}` },
      body: JSON.stringify({
        model: model.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: 4096,
      }),
    });
    if (!res.ok) throw new Error(`Groq ${res.status}`);
    const data = await res.json() as any;
    return {
      text: data.choices?.[0]?.message?.content || '',
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    };
  }

  if (model.provider === 'openrouter') {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
        'HTTP-Referer': 'https://alon.dev',
        'X-Title': 'AalonBot',
      },
      body: JSON.stringify({
        model: model.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: 4096,
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
    const data = await res.json() as any;
    return {
      text: data.choices?.[0]?.message?.content || '',
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    };
  }

  throw new Error(`Unsupported free model provider: ${model.provider}`);
}
