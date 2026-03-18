import express from 'express';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../utils/config.js';
import { executeTool } from '../agent/tools.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('server');

// Cache HTML at startup (no server-side variables needed)
const dashboardHTML = readFileSync(join(import.meta.dirname, '../views/dashboard.html'), 'utf-8');
const chatHTML = readFileSync(join(import.meta.dirname, '../views/chat.html'), 'utf-8');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.get('/health', (_req, res) => {
  // Deep health check: DB connectivity, memory, uptime
  let dbStatus = 'ok';
  let dbTables = 0;
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'").get() as any;
    dbTables = row.count;
  } catch (e: any) {
    dbStatus = `error: ${e.message}`;
  }

  const mem = process.memoryUsage();

  res.json({
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    mode: config.mode,
    version: 'v25-reliability',
    uptime: {
      seconds: Math.floor(process.uptime()),
      human: formatUptime(process.uptime()),
    },
    db: {
      status: dbStatus,
      tables: dbTables,
    },
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    },
    localConnected: !!config.localApiUrl,
  });
});

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Cloud mode: allow local Mac to register its tunnel URL
if (config.mode === 'cloud') {
  app.post('/api/register-local', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${config.localApiSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    // Update config in memory (no restart needed)
    (config as any).localApiUrl = url;
    log.info({ url }, 'local Mac registered');
    res.json({ ok: true, registered: url });
  });
}

// Local mode: expose tools as API for cloud proxy
if (config.mode === 'local') {
  app.post('/api/tool', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${config.localApiSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { name, input } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Missing tool name' });
      return;
    }

    try {
      const result = await executeTool(name, input || {});
      // Check for pending media (screenshot, etc.)
      const { collectMedia } = await import('../agent/tools.js');
      const media = collectMedia();
      res.json({ result, media: media.map(m => ({ type: m.type, data: m.data.toString('base64') })) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}

// === Session & Rate Limiting Infrastructure ===
const sessions = new Map<string, { createdAt: number }>();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_COOKIE = 'alonbot_session';

const authFailures = new Map<string, { count: number; firstAttempt: number }>();
const MAX_AUTH_FAILURES = 5;
const AUTH_WINDOW_MS = 60_000; // 1 minute

function getClientIp(req: any): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '0.0.0.0';
}

function isRateLimited(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > AUTH_WINDOW_MS) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= MAX_AUTH_FAILURES;
}

function recordAuthFailure(ip: string): void {
  const entry = authFailures.get(ip);
  if (!entry || Date.now() - entry.firstAttempt > AUTH_WINDOW_MS) {
    authFailures.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    entry.count++;
  }
}

function parseCookies(req: any): Record<string, string> {
  const header = req.headers['cookie'];
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

// === Dashboard API (protected by cookie-based sessions) ===
function dashAuth(req: any, res: any, next: any) {
  const ip = getClientIp(req);

  // 1. Check rate limit
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    return;
  }

  // 2. Check session cookie
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session && Date.now() - session.createdAt < SESSION_TTL) {
      next();
      return;
    }
    // Expired or invalid — clean up
    if (session) sessions.delete(sessionId);
  }

  // 3. Check query token
  if (req.query.token === config.dashboardSecret) {
    const newSession = crypto.randomBytes(32).toString('hex');
    sessions.set(newSession, { createdAt: Date.now() });

    const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.secure;
    const cookieFlags = `${SESSION_COOKIE}=${newSession}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}${isSecure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', cookieFlags);

    // For HTML page requests, redirect to strip token from URL
    const path = req.path;
    if (path === '/dashboard' || path === '/chat') {
      res.redirect(302, path);
      return;
    }

    next();
    return;
  }

  // 4. Check header token (programmatic API access)
  if (req.headers['x-dashboard-token'] === config.dashboardSecret) {
    next();
    return;
  }

  // 5. Auth failed
  recordAuthFailure(ip);
  res.status(401).json({ error: 'Unauthorized — add ?token=YOUR_SECRET' });
}

app.get('/api/dashboard/stats', dashAuth, (_req, res) => {
  const memories = db.prepare('SELECT COUNT(*) as count FROM memories').get() as any;
  const tasks = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'").get() as any;
  const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as any;
  const docs = db.prepare('SELECT COUNT(*) as count FROM knowledge_docs').get() as any;
  const workflows = db.prepare('SELECT COUNT(*) as count FROM workflows WHERE enabled = 1').get() as any;
  const todayCost = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as cost FROM api_usage WHERE date(created_at) = date('now')").get() as any;
  const weekCost = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as cost FROM api_usage WHERE created_at >= datetime('now', '-7 days')").get() as any;
  const monthCost = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as cost FROM api_usage WHERE created_at >= datetime('now', '-30 days')").get() as any;

  res.json({
    memories: memories.count,
    pendingTasks: tasks.count,
    totalMessages: messages.count,
    knowledgeDocs: docs.count,
    activeWorkflows: workflows.count,
    costs: {
      today: Math.round(todayCost.cost * 10000) / 10000,
      week: Math.round(weekCost.cost * 10000) / 10000,
      month: Math.round(monthCost.cost * 10000) / 10000,
    },
    uptime: Math.floor(process.uptime()),
    mode: config.mode,
    localConnected: !!config.localApiUrl,
  });
});

app.get('/api/dashboard/memories', dashAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const rows = db.prepare('SELECT * FROM memories ORDER BY importance DESC, created_at DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.get('/api/dashboard/tasks', dashAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'done\' THEN 1 ELSE 2 END, priority DESC, created_at DESC LIMIT 100').all();
  res.json(rows);
});

app.get('/api/dashboard/messages', dashAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
  const rows = db.prepare('SELECT id, channel, sender_name, role, substr(content, 1, 200) as content, created_at FROM messages ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.get('/api/dashboard/costs', dashAuth, (_req, res) => {
  const daily = db.prepare(`
    SELECT date(created_at) as day, model, COUNT(*) as calls,
           SUM(input_tokens) as input_t, SUM(output_tokens) as output_t,
           ROUND(SUM(cost_usd), 4) as cost
    FROM api_usage
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY day, model ORDER BY day DESC
  `).all();
  res.json(daily);
});

app.get('/api/dashboard/knowledge', dashAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM knowledge_docs ORDER BY created_at DESC').all();
  res.json(rows);
});

app.get('/api/dashboard/workflows', dashAuth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM workflows ORDER BY created_at DESC').all();
  res.json(rows.map((r: any) => ({ ...r, actions: JSON.parse(r.actions) })));
});

app.get('/api/dashboard/tools', dashAuth, (_req, res) => {
  const rows = db.prepare(`
    SELECT tool_name, COUNT(*) as calls,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
           SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
           ROUND(AVG(duration_ms)) as avg_ms,
           MAX(created_at) as last_used
    FROM tool_usage
    GROUP BY tool_name ORDER BY calls DESC
  `).all();
  res.json(rows);
});

// Web Chat — message history
app.get('/api/chat/history', dashAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const rows = db.prepare(
    `SELECT role, content, created_at FROM messages
     WHERE channel = 'telegram' AND sender_id = ?
     ORDER BY id DESC LIMIT ?`
  ).all(config.allowedTelegram[0] || '', limit) as any[];
  res.json(rows.reverse());
});

// Web Chat API — send message and get response
app.post('/api/chat', dashAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Missing text' });
    return;
  }

  try {
    const { handleMessage } = await import('../agent/agent.js');
    const msg = {
      id: `web-${Date.now()}`,
      channel: 'telegram' as const,
      senderId: config.allowedTelegram[0] || 'web',
      senderName: 'Alon (Web)',
      text: text.slice(0, 4000),
      timestamp: Date.now(),
      raw: null,
    };
    const reply = await handleMessage(msg);
    res.json({ text: reply.text });
  } catch (e: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Dashboard HTML
app.get('/dashboard', dashAuth, (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(dashboardHTML);
});

// Web Chat HTML
app.get('/chat', dashAuth, (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(chatHTML);
});

// === External API: Send WhatsApp message (used by voice-agent) ===
function externalAuth(req: any, res: any, next: any) {
  const secret = req.headers['x-api-secret'];
  if (secret !== config.localApiSecret) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  next();
}

app.post('/api/send-whatsapp', externalAuth, async (req, res) => {
  const { phone, message, leadName } = req.body;
  if (!phone || !message) {
    res.status(400).json({ success: false, error: 'Missing phone or message' });
    return;
  }
  try {
    const { getAdapter } = await import('./router.js');
    const wa = getAdapter('whatsapp');
    if (!wa) {
      res.json({ success: false, error: 'WhatsApp not connected' });
      return;
    }
    // Normalize phone: 05X → 972X (whatsapp-web.js needs international format without +)
    let chatPhone = phone.replace(/[\s\-\(\)]/g, '');
    if (chatPhone.startsWith('0')) chatPhone = '972' + chatPhone.slice(1);
    chatPhone = chatPhone.replace(/^\+/, '');
    const chatId = `${chatPhone}@c.us`;

    await wa.sendReply(
      { id: 'ext', channel: 'whatsapp', senderId: chatPhone, senderName: leadName || '', text: '', timestamp: Date.now(), raw: { from: chatId } },
      { text: message }
    );
    log.info({ phone, leadName }, 'external WhatsApp text sent');
    res.json({ success: true });
  } catch (e: any) {
    log.error({ err: e.message }, 'external WhatsApp send failed');
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/send-whatsapp-voice', externalAuth, async (req, res) => {
  const { phone, audio, leadName } = req.body;
  if (!phone || !audio) {
    res.status(400).json({ success: false, error: 'Missing phone or audio' });
    return;
  }
  try {
    const { getAdapter } = await import('./router.js');
    const wa = getAdapter('whatsapp');
    if (!wa) {
      res.json({ success: false, error: 'WhatsApp not connected' });
      return;
    }
    // Normalize phone
    let chatPhone = phone.replace(/[\s\-\(\)]/g, '');
    if (chatPhone.startsWith('0')) chatPhone = '972' + chatPhone.slice(1);
    chatPhone = chatPhone.replace(/^\+/, '');
    const chatId = `${chatPhone}@c.us`;

    const voiceBuffer = Buffer.from(audio, 'base64');
    await wa.sendReply(
      { id: 'ext-voice', channel: 'whatsapp', senderId: chatPhone, senderName: leadName || '', text: '', timestamp: Date.now(), raw: { from: chatId } },
      { text: '', voice: voiceBuffer }
    );
    log.info({ phone, leadName, bytes: voiceBuffer.length }, 'external WhatsApp voice sent');
    res.json({ success: true });
  } catch (e: any) {
    log.error({ err: e.message }, 'external WhatsApp voice send failed');
    res.json({ success: false, error: e.message });
  }
});

export function startServer() {
  app.listen(config.port, () => {
    log.info({ port: config.port }, 'health check server started');
    log.info({ url: `http://localhost:${config.port}/chat?token=${config.dashboardSecret}` }, 'chat URL');
    log.info({ url: `http://localhost:${config.port}/dashboard?token=${config.dashboardSecret}` }, 'dashboard URL');
    if (config.mode === 'local') {
      log.info({ url: `http://localhost:${config.port}/api/tool` }, 'tool API URL');
    }
  });
}

