/**
 * Website chat API endpoint.
 * Connects the alon-dev.vercel.app chat widget to the same AI brain as the WhatsApp bot.
 * Manages sessions in-memory (no auth needed — website visitors).
 */
import { Router } from 'express';
import { generateResponse } from '../../ai/claude-client.js';
import { buildSystemPrompt } from '../../ai/system-prompt.js';
import { getDb } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('chat-api');

export const chatRouter = Router();

// In-memory session store: sessionId → conversation history
const sessions = new Map<string, {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  lang: string;
  createdAt: number;
}>();

// Clean up sessions older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000);

// Rate limiting: max 30 requests per minute per IP
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 30) return false;
  entry.count++;
  return true;
}

chatRouter.post('/api/chat', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';

  if (!checkRateLimit(ip)) {
    res.status(429).json({ reply: 'יותר מדי בקשות, נסה שוב בעוד דקה.' });
    return;
  }

  const { message, sessionId, lang = 'he' } = req.body || {};

  if (!message || typeof message !== 'string' || message.length > 2000) {
    res.status(400).json({ reply: 'הודעה לא תקינה.' });
    return;
  }

  // Get or create session
  const sid = (typeof sessionId === 'string' && sessionId) || crypto.randomUUID();
  let session = sessions.get(sid);
  if (!session) {
    session = { messages: [], lang, createdAt: Date.now() };
    sessions.set(sid, session);
  }

  try {
    // Build system prompt (website visitor context)
    const systemPrompt = await buildSystemPrompt('מבקר באתר', '', '', true);

    // Add user message to history
    session.messages.push({ role: 'user', content: message });

    // Keep only last 20 messages
    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    const response = await generateResponse(session.messages, systemPrompt);

    // Strip any action markers from website responses (safety — no WhatsApp-specific markers)
    const cleanResponse = response
      .replace(/\[BOOK:[^\]]*\]/g, '')
      .replace(/\[ESCALATE\]/g, '')
      .replace(/\[VOICE\]/g, '')
      .replace(/\[SEARCH:[^\]]*\]/g, '')
      .replace(/\[PREP:[^\]]*\]/g, '')
      .replace(/\[NOTE:[^\]]*\]/g, '')
      .replace(/\[CREATE_LEAD:[^\]]*\]/g, '')
      .replace(/\[MONDAY_STATS\]/g, '')
      .replace(/\[CLOSE:[^\]]*\]/g, '')
      .replace(/\[QUOTE:[^\]]*\]/g, '')
      .replace(/\[RULE:[^\]]*\]/g, '')
      .replace(/\[REMOVE_RULE:[^\]]*\]/g, '')
      .replace(/\[LIST_RULES\]/g, '')
      .replace(/\[REMINDER:[^\]]*\]/g, '')
      .trim();

    // Add assistant response to history
    session.messages.push({ role: 'assistant', content: cleanResponse });

    // Track as website lead in DB (fire-and-forget)
    trackWebsiteLead(message, cleanResponse, ip).catch((err) => {
      log.error({ err }, 'failed to track website lead');
    });

    res.json({ reply: cleanResponse, sessionId: sid });

    log.info({ sid: sid.slice(0, 8), msgLen: message.length, respLen: cleanResponse.length }, 'chat response sent');
  } catch (err) {
    log.error({ err }, 'chat API error');
    res.status(500).json({ reply: lang === 'en' ? 'Something went wrong, try again.' : 'משהו השתבש, נסה שוב.' });
  }
});

/**
 * Track website chat interactions as leads.
 * Creates a lead with source='website' if first interaction from this IP.
 */
async function trackWebsiteLead(message: string, response: string, ip: string): Promise<void> {
  const db = getDb();

  // Use IP hash as identifier for website visitors (no phone number)
  const visitorId = `web-${Buffer.from(ip).toString('base64url').slice(0, 12)}`;

  // Create lead if doesn't exist
  db.prepare(
    `INSERT OR IGNORE INTO leads (phone, name, source, status, interest, source_detail)
     VALUES (?, 'מבקר באתר', 'website', 'new', '', 'website-chat')`,
  ).run(visitorId);

  const lead = db.prepare('SELECT id FROM leads WHERE phone = ?').get(visitorId) as { id: number } | undefined;
  const leadId = lead?.id || null;

  // Store messages
  db.prepare('INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)').run(visitorId, leadId, 'in', message);
  db.prepare('INSERT INTO messages (phone, lead_id, direction, content) VALUES (?, ?, ?, ?)').run(visitorId, leadId, 'out', response);

  // Update status to contacted
  db.prepare("UPDATE leads SET status = 'contacted', updated_at = datetime('now') WHERE phone = ? AND status = 'new'").run(visitorId);
}
