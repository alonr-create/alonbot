import express from 'express';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../utils/config.js';
import { executeTool } from '../agent/tools.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';
import { getAllWorkspaces, getWorkspace, createWorkspace, updateWorkspace, deleteWorkspace } from '../utils/workspaces.js';

const log = createLogger('server');

// Cache HTML at startup (no server-side variables needed)
const dashboardHTML = readFileSync(join(import.meta.dirname, '../views/dashboard.html'), 'utf-8');
const chatHTML = readFileSync(join(import.meta.dirname, '../views/chat.html'), 'utf-8');
const waInboxHTML = readFileSync(join(import.meta.dirname, '../views/wa-inbox.html'), 'utf-8');
const manifestJSON = readFileSync(join(import.meta.dirname, '../views/manifest.json'), 'utf-8');
const manifestWaJSON = readFileSync(join(import.meta.dirname, '../views/manifest-wa.json'), 'utf-8');
const swJS = readFileSync(join(import.meta.dirname, '../views/sw.js'), 'utf-8');
const iconPNG = readFileSync(join(import.meta.dirname, '../views/icon.png'));

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve marketing assets (logo, images, video)
app.use('/assets', express.static(join(config.dataDir), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
  },
}));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// PWA static assets (no auth needed)
app.get('/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.send(manifestJSON);
});
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(swJS);
});
app.get('/icon-192.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(iconPNG);
});
app.get('/icon-512.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(iconPNG);
});
app.get('/manifest-wa.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.send(manifestWaJSON);
});
app.get('/icon-wa-192.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(iconPNG);
});
app.get('/icon-wa-512.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(iconPNG);
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
  // Restore local URL from DB on startup (survives restarts)
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('local_api_url') as any;
    if (row?.value) {
      (config as any).localApiUrl = row.value;
      log.info({ url: row.value }, 'local URL restored from DB');
    }
  } catch { /* settings table may not exist yet */ }

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
    // Update config in memory + persist to DB
    (config as any).localApiUrl = url;
    db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))').run('local_api_url', url);
    log.info({ url }, 'local Mac registered (persisted)');
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

    // For HTML page requests, redirect to strip token from URL (except wa-inbox which needs it for JS API calls)
    const path = req.path;
    if (path === '/dashboard' || path === '/chat' || path === '/wa-manager') {
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
     WHERE channel = 'web' AND sender_id = 'web'
     ORDER BY id DESC LIMIT ?`
  ).all(limit) as any[];
  res.json(rows.reverse());
});

// Web Chat API — streaming response via SSE
app.post('/api/chat', dashAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    res.status(400).json({ error: 'Missing text' });
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { handleMessage } = await import('../agent/agent.js');
    const msg = {
      id: `web-${Date.now()}`,
      channel: 'web' as const,
      senderId: 'web',
      senderName: 'Alon (Web)',
      text: text.slice(0, 4000),
      timestamp: Date.now(),
      raw: null,
    };

    const reply = await handleMessage(msg, (chunk, toolName) => {
      if (toolName) {
        res.write(`data: ${JSON.stringify({ tool: toolName })}\n\n`);
      } else if (chunk) {
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
    });

    res.write(`data: ${JSON.stringify({ done: true, text: reply.text })}\n\n`);
    res.end();
  } catch (e: any) {
    res.write(`data: ${JSON.stringify({ error: 'Internal server error' })}\n\n`);
    res.end();
  }
});

// Workspace → source mapping (voice_agent leads belong to dekel workspace)
function workspaceSources(workspace: string): string[] {
  const map: Record<string, string[]> = {
    'dekel': ['dekel', 'voice_agent'],
    'alon_dev': ['alon_dev', 'alon_dev_whatsapp'],
  };
  return map[workspace] || [workspace];
}
function wsSourceSQL(workspace: string | undefined): { clause: string; params: string[] } {
  if (!workspace) return { clause: '', params: [] };
  const sources = workspaceSources(workspace);
  const placeholders = sources.map(() => '?').join(',');
  return { clause: `l.source IN (${placeholders})`, params: sources };
}

// === WA Manager API Endpoints ===
app.get('/api/wa-manager/leads', dashAuth, (req, res) => {
  try {
    const workspace = req.query.workspace as string | undefined;
    const { clause, params } = wsSourceSQL(workspace);
    const whereClause = clause ? `WHERE ${clause}` : '';
    const leads = db.prepare(`
      SELECT l.*,
        (SELECT COUNT(*) FROM messages m WHERE m.sender_id = l.phone AND m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')) as message_count,
        (SELECT m.content FROM messages m WHERE m.sender_id = l.phone AND m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound') ORDER BY m.id DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.sender_id = l.phone AND m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound') ORDER BY m.id DESC LIMIT 1) as last_message_at,
        (SELECT m.role FROM messages m WHERE m.sender_id = l.phone AND m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound') ORDER BY m.id DESC LIMIT 1) as last_message_role,
        (SELECT GROUP_CONCAT(tag, ',') FROM lead_tags lt WHERE lt.phone = l.phone) as tags_csv
      FROM leads l ${whereClause} ORDER BY l.updated_at DESC
    `).all(...params) as any[];
    // Parse tags CSV to array
    for (const lead of leads) {
      lead.tags = lead.tags_csv ? lead.tags_csv.split(',') : [];
      delete lead.tags_csv;
    }
    res.json({ success: true, leads });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/wa-manager/conversations/:phone', dashAuth, (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const messages = db.prepare(`
      SELECT MIN(id) as id, channel, sender_id, sender_name, role, content, created_at
      FROM messages
      WHERE sender_id = ? AND channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
      GROUP BY content, created_at, role
      ORDER BY MIN(id) ASC
    `).all(phone);
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
    res.json({ success: true, lead, messages });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/wa-manager/stats', dashAuth, (req, res) => {
  try {
    const workspace = req.query.workspace as string | undefined;
    const sources = workspace ? workspaceSources(workspace) : [];
    const srcPlaceholders = sources.map(() => '?').join(',');
    const leadFilter = workspace ? `WHERE source IN (${srcPlaceholders})` : '';
    const leadJoinFilter = workspace ? `AND l.source IN (${srcPlaceholders})` : '';
    const msgJoinFilter = workspace ? `AND m.sender_id IN (SELECT phone FROM leads WHERE source IN (${srcPlaceholders}))` : '';

    // Build a phone list for message filtering
    const phoneList = workspace
      ? (db.prepare(`SELECT phone FROM leads WHERE source IN (${srcPlaceholders})`).all(...sources) as any[]).map((r: any) => r.phone)
      : null;
    const phoneFilter = phoneList ? `AND m.sender_id IN (${phoneList.map(() => '?').join(',')})` : '';

    const totalLeads = workspace
      ? db.prepare(`SELECT COUNT(*) as count FROM leads WHERE source IN (${srcPlaceholders})`).get(...sources) as any
      : db.prepare('SELECT COUNT(*) as count FROM leads').get() as any;
    const activeConvos = db.prepare(`
      SELECT COUNT(DISTINCT m.sender_id) as count FROM messages m
      WHERE m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
      AND m.created_at >= datetime('now', '-7 days')
      ${phoneFilter}
    `).get(...(phoneList || [])) as any;
    const messagesToday = db.prepare(`
      SELECT COUNT(*) as count FROM messages m
      WHERE m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
      AND date(m.created_at) = date('now')
      ${phoneFilter}
    `).get(...(phoneList || [])) as any;
    const totalInbound = db.prepare(`
      SELECT COUNT(*) as count FROM messages m
      WHERE m.channel IN ('whatsapp','whatsapp-inbound') AND m.role = 'user'
      ${phoneFilter}
    `).get(...(phoneList || [])) as any;
    const totalOutbound = db.prepare(`
      SELECT COUNT(*) as count FROM messages m
      WHERE m.channel IN ('whatsapp','whatsapp-outbound') AND m.role = 'assistant'
      ${phoneFilter}
    `).get(...(phoneList || [])) as any;
    const responseRate = totalInbound.count > 0 ? Math.round((totalOutbound.count / totalInbound.count) * 100) : 0;
    const pendingFollowups = workspace
      ? db.prepare(`SELECT COUNT(*) as count FROM leads WHERE lead_status IN ('new','contacted') AND source IN (${srcPlaceholders})`).get(...sources) as any
      : db.prepare("SELECT COUNT(*) as count FROM leads WHERE lead_status IN ('new','contacted')").get() as any;
    const bookedCount = workspace
      ? db.prepare(`SELECT COUNT(*) as count FROM leads WHERE was_booked = 1 AND source IN (${srcPlaceholders})`).get(...sources) as any
      : db.prepare('SELECT COUNT(*) as count FROM leads WHERE was_booked = 1').get() as any;
    const sourceBreakdown = workspace
      ? db.prepare(`SELECT source, COUNT(*) as count FROM leads WHERE source IN (${srcPlaceholders}) GROUP BY source ORDER BY count DESC`).all(...sources)
      : db.prepare('SELECT source, COUNT(*) as count FROM leads GROUP BY source ORDER BY count DESC').all();
    const statusBreakdown = workspace
      ? db.prepare(`SELECT lead_status, COUNT(*) as count FROM leads WHERE source IN (${srcPlaceholders}) GROUP BY lead_status ORDER BY count DESC`).all(...sources)
      : db.prepare('SELECT lead_status, COUNT(*) as count FROM leads GROUP BY lead_status ORDER BY count DESC').all();

    const messagesPerDay = db.prepare(`
      SELECT date(m.created_at) as day, COUNT(*) as count
      FROM messages m WHERE m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
      AND m.created_at >= datetime('now', '-30 days')
      ${phoneFilter}
      GROUP BY day ORDER BY day ASC
    `).all(...(phoneList || []));

    const leadsPerDay = workspace
      ? db.prepare(`SELECT date(created_at) as day, COUNT(*) as count FROM leads WHERE created_at >= datetime('now', '-30 days') AND source IN (${srcPlaceholders}) GROUP BY day ORDER BY day ASC`).all(...sources)
      : db.prepare("SELECT date(created_at) as day, COUNT(*) as count FROM leads WHERE created_at >= datetime('now', '-30 days') GROUP BY day ORDER BY day ASC").all();

    // Average response time (minutes) — time between user msg and next assistant msg
    let avgResponseMin: number | null = null;
    try {
      const avgResp = db.prepare(`
        SELECT AVG(resp_sec) / 60.0 as avg_min FROM (
          SELECT m1.id,
            (SELECT MIN(julianday(m2.created_at) - julianday(m1.created_at)) * 86400
             FROM messages m2 WHERE m2.sender_id = m1.sender_id AND m2.role = 'assistant'
             AND m2.channel IN ('whatsapp','whatsapp-outbound') AND m2.id > m1.id) as resp_sec
          FROM messages m1
          WHERE m1.role = 'user' AND m1.channel IN ('whatsapp','whatsapp-inbound')
          AND m1.created_at >= datetime('now', '-7 days')
          ${phoneFilter}
        ) WHERE resp_sec IS NOT NULL AND resp_sec < 86400
      `).get(...(phoneList || [])) as any;
      if (avgResp?.avg_min) avgResponseMin = Math.round(avgResp.avg_min);
    } catch { /* ok */ }

    res.json({
      success: true,
      totalLeads: totalLeads.count,
      activeConvos: activeConvos.count,
      messagesToday: messagesToday.count,
      responseRate,
      pendingFollowups: pendingFollowups.count,
      bookedCount: bookedCount.count,
      avgResponseMin,
      sourceBreakdown,
      statusBreakdown,
      messagesPerDay,
      leadsPerDay,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/wa-manager/send', dashAuth, async (req, res) => {
  const { phone, message } = req.body;
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
    let chatPhone = phone.replace(/[\s\-\(\)]/g, '');
    if (chatPhone.startsWith('0')) chatPhone = '972' + chatPhone.slice(1);
    chatPhone = chatPhone.replace(/^\+/, '');
    const chatId = `${chatPhone}@s.whatsapp.net`;
    await wa.sendReply(
      { id: 'wa-mgr', channel: 'whatsapp', senderId: chatPhone, senderName: '', text: '', timestamp: Date.now(), raw: { from: chatId } },
      { text: message }
    );
    try {
      db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, datetime('now'))`).run(chatPhone, message);
    } catch { /* logging failure should not break send */ }
    log.info({ phone: chatPhone }, 'wa-manager: message sent');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/wa-manager/broadcast', dashAuth, async (req, res) => {
  const { phones, message } = req.body;
  if (!Array.isArray(phones) || !message) {
    res.status(400).json({ success: false, error: 'Missing phones array or message' });
    return;
  }
  try {
    const { getAdapter } = await import('./router.js');
    const wa = getAdapter('whatsapp');
    if (!wa) {
      res.json({ success: false, error: 'WhatsApp not connected' });
      return;
    }
    const results: { phone: string; success: boolean; error?: string }[] = [];
    for (const phone of phones) {
      try {
        let chatPhone = phone.replace(/[\s\-\(\)]/g, '');
        if (chatPhone.startsWith('0')) chatPhone = '972' + chatPhone.slice(1);
        chatPhone = chatPhone.replace(/^\+/, '');
        const chatId = `${chatPhone}@s.whatsapp.net`;

        // Personalize message: replace {name} with lead name
        let personalMsg = message;
        try {
          const lead = db.prepare('SELECT name FROM leads WHERE phone = ?').get(chatPhone) as any;
          if (lead?.name) personalMsg = personalMsg.replace(/\{name\}/g, lead.name);
          else personalMsg = personalMsg.replace(/\{name\}/g, '');
          personalMsg = personalMsg.replace(/\{phone\}/g, chatPhone);
        } catch { /* continue with raw message */ }

        await wa.sendReply(
          { id: 'wa-broadcast', channel: 'whatsapp', senderId: chatPhone, senderName: '', text: '', timestamp: Date.now(), raw: { from: chatId } },
          { text: personalMsg }
        );
        try {
          db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, datetime('now'))`).run(chatPhone, personalMsg);
        } catch { /* logging failure should not break send */ }
        results.push({ phone: chatPhone, success: true });
        // Small delay between sends to avoid rate limiting
        await new Promise(r => setTimeout(r, 1500));
      } catch (e: any) {
        results.push({ phone, success: false, error: e.message });
      }
    }
    log.info({ sent: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length }, 'wa-manager: broadcast complete');
    res.json({ success: true, results });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch('/api/wa-manager/leads/:phone', dashAuth, (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const { lead_status, tags, name } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (lead_status !== undefined) {
      // Record status history
      try {
        const current = db.prepare('SELECT lead_status FROM leads WHERE phone = ?').get(phone) as any;
        db.prepare('INSERT INTO status_history (phone, old_status, new_status) VALUES (?, ?, ?)').run(phone, current?.lead_status || null, lead_status);
      } catch { /* ok */ }
      updates.push('lead_status = ?'); params.push(lead_status);
    }
    if (tags !== undefined) { updates.push('source = ?'); params.push(tags); }
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (updates.length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }
    updates.push("updated_at = datetime('now')");
    params.push(phone);
    db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE phone = ?`).run(...params);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === Tags API ===
app.get('/api/wa-manager/tags/:phone', dashAuth, (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const tags = db.prepare('SELECT tag FROM lead_tags WHERE phone = ? ORDER BY created_at ASC').all(phone) as any[];
    res.json({ success: true, tags: tags.map(t => t.tag) });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/wa-manager/tags/:phone', dashAuth, (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const { tag } = req.body;
    if (!tag) { res.status(400).json({ success: false, error: 'Missing tag' }); return; }
    db.prepare('INSERT OR IGNORE INTO lead_tags (phone, tag) VALUES (?, ?)').run(phone, tag.trim());
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/wa-manager/tags/:phone/:tag', dashAuth, (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    db.prepare('DELETE FROM lead_tags WHERE phone = ? AND tag = ?').run(phone, req.params.tag);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/wa-manager/all-tags', dashAuth, (_req, res) => {
  try {
    const tags = db.prepare('SELECT tag, COUNT(*) as count FROM lead_tags GROUP BY tag ORDER BY count DESC').all();
    res.json({ success: true, tags });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// === Notes API ===
app.get('/api/wa-manager/notes/:phone', dashAuth, (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const notes = db.prepare('SELECT * FROM lead_notes WHERE phone = ? ORDER BY created_at DESC').all(phone);
    res.json({ success: true, notes });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/wa-manager/notes/:phone', dashAuth, (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const { content } = req.body;
    if (!content) { res.status(400).json({ success: false, error: 'Missing content' }); return; }
    db.prepare('INSERT INTO lead_notes (phone, content) VALUES (?, ?)').run(phone, content.trim());
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/wa-manager/notes/:id', dashAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM lead_notes WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// === Quick Replies API ===
app.get('/api/wa-manager/quick-replies', dashAuth, (req, res) => {
  try {
    const wsId = req.query.workspace as string | undefined;
    const replies = wsId
      ? db.prepare('SELECT * FROM quick_replies WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY sort_order ASC').all(wsId)
      : db.prepare('SELECT * FROM quick_replies ORDER BY sort_order ASC').all();
    res.json({ success: true, replies });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/wa-manager/quick-replies', dashAuth, (req, res) => {
  try {
    const { title, content, workspace_id } = req.body;
    if (!title || !content) { res.status(400).json({ success: false, error: 'Missing title or content' }); return; }
    db.prepare('INSERT INTO quick_replies (title, content, workspace_id) VALUES (?, ?, ?)').run(title, content, workspace_id || null);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/wa-manager/quick-replies/:id', dashAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM quick_replies WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// === Status History API ===
app.get('/api/wa-manager/status-history/:phone', dashAuth, (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const history = db.prepare('SELECT * FROM status_history WHERE phone = ? ORDER BY changed_at DESC LIMIT 20').all(phone);
    res.json({ success: true, history });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// === CSV Export ===
app.get('/api/wa-manager/export-csv', dashAuth, (req, res) => {
  try {
    const workspace = req.query.workspace as string | undefined;
    const { clause, params } = wsSourceSQL(workspace);
    const whereClause = clause ? `WHERE ${clause}` : '';
    const leads = db.prepare(`
      SELECT l.phone, l.name, l.source, l.lead_status, l.was_booked, l.last_call_summary, l.last_call_sentiment, l.created_at, l.updated_at,
        (SELECT GROUP_CONCAT(tag, ', ') FROM lead_tags lt WHERE lt.phone = l.phone) as tags,
        (SELECT COUNT(*) FROM messages m WHERE m.sender_id = l.phone AND m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')) as message_count
      FROM leads l ${whereClause} ORDER BY l.updated_at DESC
    `).all(...params) as any[];

    const header = 'טלפון,שם,מקור,סטטוס,נקבעה פגישה,תגיות,הודעות,סנטימנט,נוצר,עודכן,סיכום שיחה';
    const rows = leads.map(l => {
      const fields = [
        l.phone, `"${(l.name || '').replace(/"/g, '""')}"`, l.source || '',
        l.lead_status || 'new', l.was_booked ? 'כן' : 'לא',
        `"${(l.tags || '').replace(/"/g, '""')}"`, l.message_count || 0,
        l.last_call_sentiment || '', l.created_at || '', l.updated_at || '',
        `"${(l.last_call_summary || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`,
      ];
      return fields.join(',');
    });
    const csv = '\uFEFF' + header + '\n' + rows.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// === Chatbot Flows API ===
app.get('/api/wa-manager/flows', dashAuth, (req, res) => {
  try {
    const wsId = req.query.workspace as string | undefined;
    const flows = wsId
      ? db.prepare('SELECT * FROM chatbot_flows WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY created_at DESC').all(wsId)
      : db.prepare('SELECT * FROM chatbot_flows ORDER BY created_at DESC').all();
    for (const f of flows as any[]) {
      try { f.steps = JSON.parse(f.steps); } catch { f.steps = []; }
      const runs = db.prepare('SELECT COUNT(*) as c FROM flow_runs WHERE flow_id = ?').get(f.id) as any;
      f.run_count = runs?.c || 0;
    }
    res.json({ success: true, flows });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/wa-manager/flows', dashAuth, (req, res) => {
  try {
    const { name, trigger_type, trigger_value, steps, workspace_id } = req.body;
    if (!name || !trigger_type) { res.status(400).json({ success: false, error: 'Missing name or trigger_type' }); return; }
    const result = db.prepare('INSERT INTO chatbot_flows (name, trigger_type, trigger_value, steps, workspace_id) VALUES (?, ?, ?, ?, ?)').run(
      name, trigger_type, trigger_value || null, JSON.stringify(steps || []), workspace_id || null
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.patch('/api/wa-manager/flows/:id', dashAuth, (req, res) => {
  try {
    const { name, trigger_type, trigger_value, steps, enabled } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (trigger_type !== undefined) { updates.push('trigger_type = ?'); params.push(trigger_type); }
    if (trigger_value !== undefined) { updates.push('trigger_value = ?'); params.push(trigger_value); }
    if (steps !== undefined) { updates.push('steps = ?'); params.push(JSON.stringify(steps)); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (!updates.length) { res.status(400).json({ success: false, error: 'No fields' }); return; }
    params.push(req.params.id);
    db.prepare(`UPDATE chatbot_flows SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/wa-manager/flows/:id', dashAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM chatbot_flows WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// === Workspace CRUD Endpoints ===
app.get('/api/wa-manager/workspaces', dashAuth, (_req, res) => {
  try {
    const workspaces = getAllWorkspaces();
    res.json({ success: true, workspaces });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/wa-manager/workspaces', dashAuth, (req, res) => {
  try {
    const { id, name, icon, color, welcome_msg, system_prompt, monday_board_id, monday_columns, calendar_id, zoom_link, website } = req.body;
    if (!id || !name) {
      res.status(400).json({ success: false, error: 'Missing id or name' });
      return;
    }
    createWorkspace({ id, name, icon, color, welcome_msg, system_prompt, monday_board_id, monday_columns, calendar_id, zoom_link, website });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.patch('/api/wa-manager/workspaces/:id', dashAuth, (req, res) => {
  try {
    updateWorkspace(req.params.id, req.body);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/wa-manager/workspaces/:id', dashAuth, (req, res) => {
  try {
    deleteWorkspace(req.params.id);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// API Costs tracking
app.get('/api/wa-manager/costs', dashAuth, (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const daily = db.prepare(`
      SELECT date(created_at) as day, model,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost_usd) as cost_usd,
        COUNT(*) as calls
      FROM api_usage
      WHERE created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY day, model ORDER BY day DESC
    `).all(days) as any[];

    const totals = db.prepare(`
      SELECT
        SUM(cost_usd) as total_cost,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        COUNT(*) as total_calls
      FROM api_usage
      WHERE created_at >= datetime('now', '-' || ? || ' days')
    `).get(days) as any;

    const today = db.prepare(`
      SELECT model,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost_usd) as cost_usd,
        COUNT(*) as calls
      FROM api_usage
      WHERE date(created_at) = date('now')
      GROUP BY model
    `).all() as any[];

    // WhatsApp costs — estimated from conversations (unique contacts per day)
    // Meta pricing Israel: service $0.02, marketing $0.065, utility $0.008
    const waDaily = db.prepare(`
      SELECT date(created_at) as day,
        COUNT(CASE WHEN role='user' THEN 1 END) as incoming_msgs,
        COUNT(CASE WHEN role='assistant' THEN 1 END) as outgoing_msgs,
        COUNT(DISTINCT sender_id) as conversations
      FROM messages
      WHERE channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
        AND created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY day ORDER BY day DESC
    `).all(days) as any[];

    // Estimate: user-initiated = service ($0.02), bot-initiated = marketing ($0.065)
    const waToday = db.prepare(`
      SELECT
        COUNT(DISTINCT sender_id) as conversations,
        COUNT(CASE WHEN role='user' THEN 1 END) as incoming_msgs,
        COUNT(CASE WHEN role='assistant' THEN 1 END) as outgoing_msgs
      FROM messages
      WHERE channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
        AND date(created_at) = date('now')
    `).get() as any;

    res.json({ success: true, daily, totals, today, waDaily, waToday });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// WA Templates API — proxy to Meta Graph API
app.get('/api/wa-manager/templates', dashAuth, async (_req, res) => {
  try {
    const wabaId = config.waCloudWabaId || '1289908013100682';
    const token = config.waCloudToken;
    if (!token) { res.json({ templates: [], debug: 'no token' }); return; }
    const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates?limit=100`;
    log.info({ wabaId, url }, 'fetching templates');
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await r.json() as any;
    if (data.error) {
      log.error({ error: data.error }, 'Meta templates API error');
      res.json({ templates: [], error: data.error });
      return;
    }
    res.json({ templates: data.data || [] });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Send template message via Cloud API
app.post('/api/wa-manager/send-template', dashAuth, async (req, res) => {
  try {
    const { phone, templateName, language } = req.body;
    const token = config.waCloudToken;
    const phoneId = config.waCloudPhoneId;
    if (!token || !phoneId) { res.status(400).json({ success: false, error: 'Cloud API not configured' }); return; }
    const to = phone.replace(/\D/g, '');
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: templateName, language: { code: language || 'he' } }
      })
    });
    const data = await r.json();
    res.json({ success: true, data });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// WA Inbox HTML
app.get('/wa-inbox', dashAuth, (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(waInboxHTML);
});

// WA Manager — redirect to unified wa-inbox
app.get('/wa-manager', dashAuth, (req, res) => {
  const token = req.query.token || '';
  res.redirect(`/wa-inbox${token ? '?token=' + token : ''}`);
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

// Bulk sync: import leads + messages from another instance
app.post('/api/sync/import', externalAuth, (req, res) => {
  try {
    const { leads = [], messages = [] } = req.body;
    let leadsUpserted = 0, msgsInserted = 0;

    const upsertLead = db.prepare(`
      INSERT INTO leads (phone, name, source, lead_status, last_call_summary, last_call_sentiment, last_call_duration_sec, was_booked, call_mode, monday_item_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        name = COALESCE(excluded.name, leads.name),
        source = COALESCE(excluded.source, leads.source),
        lead_status = COALESCE(excluded.lead_status, leads.lead_status),
        last_call_summary = COALESCE(excluded.last_call_summary, leads.last_call_summary),
        last_call_sentiment = COALESCE(excluded.last_call_sentiment, leads.last_call_sentiment),
        last_call_duration_sec = COALESCE(excluded.last_call_duration_sec, leads.last_call_duration_sec),
        was_booked = COALESCE(excluded.was_booked, leads.was_booked),
        call_mode = COALESCE(excluded.call_mode, leads.call_mode),
        monday_item_id = COALESCE(excluded.monday_item_id, leads.monday_item_id),
        updated_at = MAX(excluded.updated_at, leads.updated_at)
    `);

    const insertMsg = db.prepare(`
      INSERT OR IGNORE INTO messages (channel, sender_id, sender_name, role, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const syncTx = db.transaction(() => {
      for (const l of leads) {
        upsertLead.run(l.phone, l.name, l.source, l.lead_status, l.last_call_summary, l.last_call_sentiment, l.last_call_duration_sec, l.was_booked ? 1 : 0, l.call_mode, l.monday_item_id, l.created_at, l.updated_at);
        leadsUpserted++;
      }
      for (const m of messages) {
        insertMsg.run(m.channel, m.sender_id, m.sender_name || '', m.role, m.content, m.created_at);
        msgsInserted++;
      }
    });
    syncTx();

    log.info({ leadsUpserted, msgsInserted }, 'sync import completed');
    res.json({ success: true, leadsUpserted, msgsInserted });
  } catch (e: any) {
    log.error({ error: e.message }, 'sync import failed');
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/send-whatsapp', externalAuth, async (req, res) => {
  const { phone, message, leadName, leadContext, template, templateParams } = req.body;
  if (!phone || (!message && !template)) {
    res.status(400).json({ success: false, error: 'Missing phone or message/template' });
    return;
  }
  try {
    const { getAdapter } = await import('./router.js');
    const wa = getAdapter('whatsapp');
    if (!wa) {
      res.json({ success: false, error: 'WhatsApp not connected' });
      return;
    }
    // Normalize phone: 05X → 972X (international format without +)
    let chatPhone = phone.replace(/[\s\-\(\)]/g, '');
    if (chatPhone.startsWith('0')) chatPhone = '972' + chatPhone.slice(1);
    chatPhone = chatPhone.replace(/^\+/, '');
    const chatId = `${chatPhone}@s.whatsapp.net`;

    // Register/update lead in DB for sales follow-up
    if (leadContext || leadName) {
      try {
        const ctx = leadContext || {};
        db.prepare(`
          INSERT INTO leads (phone, name, source, monday_item_id, last_call_summary, last_call_sentiment, last_call_duration_sec, was_booked, call_mode, lead_status, updated_at)
          VALUES (?, ?, 'voice_agent', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(phone) DO UPDATE SET
            name = COALESCE(excluded.name, leads.name),
            last_call_summary = COALESCE(excluded.last_call_summary, leads.last_call_summary),
            last_call_sentiment = COALESCE(excluded.last_call_sentiment, leads.last_call_sentiment),
            last_call_duration_sec = COALESCE(excluded.last_call_duration_sec, leads.last_call_duration_sec),
            was_booked = excluded.was_booked,
            call_mode = COALESCE(excluded.call_mode, leads.call_mode),
            lead_status = COALESCE(excluded.lead_status, leads.lead_status),
            monday_item_id = COALESCE(excluded.monday_item_id, leads.monday_item_id),
            updated_at = datetime('now')
        `).run(
          chatPhone, leadName || null, ctx.mondayItemId || null,
          ctx.callSummary || null, ctx.sentiment || null,
          ctx.callDurationSec || null, ctx.wasBooked ? 1 : 0,
          ctx.callMode || null, ctx.leadStatus || null
        );
        log.info({ phone: chatPhone, leadName }, 'lead registered/updated in DB');
      } catch (dbErr: any) {
        log.warn({ err: dbErr.message }, 'failed to register lead in DB — continuing');
      }
    }

    const replyPayload: any = template
      ? { text: '', template, templateParams: templateParams || [] }
      : { text: message };

    await wa.sendReply(
      { id: 'ext', channel: 'whatsapp', senderId: chatPhone, senderName: leadName || '', text: '', timestamp: Date.now(), raw: { from: chatId } },
      replyPayload
    );
    // Log outbound WA message for flow tracking
    const logContent = template ? `[template:${template}] ${(templateParams || []).join(', ')}` : message;
    try {
      db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, datetime('now'))`).run(chatPhone, logContent);
    } catch { /* logging failure should not break send */ }
    log.info({ phone, leadName, template: template || 'none' }, 'external WhatsApp sent');
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
    const chatId = `${chatPhone}@s.whatsapp.net`;

    // Register lead if not already tracked
    if (leadName) {
      try {
        db.prepare(`
          INSERT INTO leads (phone, name, source) VALUES (?, ?, 'voice_agent')
          ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, leads.name), updated_at = datetime('now')
        `).run(chatPhone, leadName);
      } catch { /* lead may already exist — ok */ }
    }

    const voiceBuffer = Buffer.from(audio, 'base64');
    await wa.sendReply(
      { id: 'ext-voice', channel: 'whatsapp', senderId: chatPhone, senderName: leadName || '', text: '', timestamp: Date.now(), raw: { from: chatId } },
      { text: '', voice: voiceBuffer }
    );
    // Log outbound voice note for flow tracking
    try {
      db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, datetime('now'))`).run(chatPhone, `[הודעה קולית — ${voiceBuffer.length} bytes]`);
    } catch { /* logging failure should not break send */ }
    log.info({ phone, leadName, bytes: voiceBuffer.length }, 'external WhatsApp voice sent');
    res.json({ success: true });
  } catch (e: any) {
    log.error({ err: e.message }, 'external WhatsApp voice send failed');
    res.json({ success: false, error: e.message });
  }
});

// WhatsApp message log for flow tracking (outbound + inbound conversations)
app.get('/api/wa-outbound-log', externalAuth, (req, res) => {
  try {
    const since = (req.query.since as string) || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const phone = req.query.phone as string;
    let query = `SELECT sender_id as phone, role, content, channel, created_at FROM messages WHERE channel IN ('whatsapp-outbound', 'whatsapp-inbound') AND created_at >= ?`;
    const params: any[] = [since];
    if (phone) {
      const cleanPhone = phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
      query += ` AND sender_id = ?`;
      params.push(cleanPhone);
    }
    query += ` ORDER BY created_at DESC LIMIT 500`;
    const rows = db.prepare(query).all(...params);
    // Enrich with lead names
    const enriched = rows.map((row: any) => {
      try {
        const lead = db.prepare('SELECT name FROM leads WHERE phone = ?').get(row.phone) as any;
        return { ...row, name: lead?.name || null };
      } catch { return { ...row, name: null }; }
    });
    res.json({ success: true, count: enriched.length, messages: enriched });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

// Debug: check registered leads
app.get('/api/leads', externalAuth, (_req, res) => {
  try {
    const leads = db.prepare('SELECT phone, name, lead_status, last_call_sentiment, was_booked, updated_at FROM leads ORDER BY updated_at DESC LIMIT 50').all();
    res.json({ success: true, count: leads.length, leads });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

/** Register a webhook handler (Telegram or WhatsApp cloud mode) */
export function registerWebhook(path: string, handler: (req: any, res: any) => void) {
  app.post(path, handler);

  // WhatsApp Cloud API webhook verification (GET) — needed for Meta webhook setup
  if (path.includes('whatsapp')) {
    const verifyToken = config.localApiSecret; // reuse existing secret as verify token
    app.get(path, (req, res) => {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];
      if (mode === 'subscribe' && token === verifyToken) {
        log.info('WhatsApp webhook verified');
        res.status(200).send(challenge);
      } else {
        log.warn('WhatsApp webhook verification failed');
        res.sendStatus(403);
      }
    });
    log.info({ path, verifyToken }, 'WhatsApp webhook with GET verification registered');
  } else {
    log.info({ path }, 'webhook endpoint registered');
  }
}

// Monday.com webhook for status changes → WhatsApp messages
import { mondayWebhookHandler } from '../utils/monday-leads.js';
app.post('/monday-webhook', mondayWebhookHandler());

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

