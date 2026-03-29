import express from 'express';
import crypto from 'crypto';
import http from 'http';
import { readFileSync, existsSync as fsExists, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import webpush from 'web-push';
import { config } from '../utils/config.js';
import { executeTool } from '../agent/tools.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';
import { getAllWorkspaces, getWorkspace, createWorkspace, updateWorkspace, deleteWorkspace } from '../utils/workspaces.js';
import { LEAD_STATUS, PIPELINE_STAGES, TERMINAL_STATUSES } from '../utils/lead-status.js';

const log = createLogger('server');

/** Return current Israel time as ISO string for SQLite (handles DST automatically) */
function nowIsrael(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}

// Cache HTML at startup (no server-side variables needed)
const dashboardHTML = readFileSync(join(import.meta.dirname, '../views/dashboard.html'), 'utf-8');
const chatHTML = readFileSync(join(import.meta.dirname, '../views/chat.html'), 'utf-8');
const waInboxHTML = readFileSync(join(import.meta.dirname, '../views/wa-inbox.html'), 'utf-8');
const waMobileHTML = readFileSync(join(import.meta.dirname, '../views/wa-mobile.html'), 'utf-8');
const manifestJSON = readFileSync(join(import.meta.dirname, '../views/manifest.json'), 'utf-8');
const manifestWaJSON = readFileSync(join(import.meta.dirname, '../views/manifest-wa.json'), 'utf-8');
const waManagerManifestJSON = readFileSync(join(import.meta.dirname, '../views/wa-manager-manifest.json'), 'utf-8');
const manifestWaMobileJSON = readFileSync(join(import.meta.dirname, '../views/manifest-wa-mobile.json'), 'utf-8');
const swJS = readFileSync(join(import.meta.dirname, '../views/sw.js'), 'utf-8');
const iconPNG = readFileSync(join(import.meta.dirname, '../views/icon.png'));
const iconWa192 = readFileSync(join(import.meta.dirname, '../views/icon-wa-192.png'));
const iconWa512 = readFileSync(join(import.meta.dirname, '../views/icon-wa-512.png'));
const appleTouchIconWa = readFileSync(join(import.meta.dirname, '../views/apple-touch-icon-wa.png'));
const faviconWa32 = readFileSync(join(import.meta.dirname, '../views/favicon-wa-32.png'));
const iconWaBlue192 = readFileSync(join(import.meta.dirname, '../views/icon-wa-blue-192.png'));
const iconWaBlue512 = readFileSync(join(import.meta.dirname, '../views/icon-wa-blue-512.png'));
const appleTouchIconWaBlue = readFileSync(join(import.meta.dirname, '../views/apple-touch-icon-wa-blue.png'));
const faviconWaBlue32 = readFileSync(join(import.meta.dirname, '../views/favicon-wa-blue-32.png'));

const app = express();
app.use(express.json({ limit: '12mb' }));

// Serve media files from incoming WhatsApp messages (dashboard display)
app.use('/media', express.static(join(config.dataDir, 'media'), { maxAge: '30d' }));

// Serve marketing assets (logo, images, video)
app.use('/assets', express.static(join(config.dataDir), {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
  },
}));

// ── A/B/C Price Tier System ──
// Deterministic assignment: hash phone → consistent tier per lead
const PRICE_TIERS = {
  A: { basic: { regular: 990, discount: 790 }, premium: { regular: 1790, discount: 1590 }, label: 'רגיל' },
  B: { basic: { regular: 690, discount: 490 }, premium: { regular: 1290, discount: 990 }, label: 'אגרסיבי' },
  C: { basic: { regular: 1290, discount: 990 }, premium: { regular: 2290, discount: 1990 }, label: 'פרימיום' },
} as const;

function getLeadTier(phone: string): 'A' | 'B' | 'C' {
  // Check if already assigned
  const lead = db.prepare('SELECT price_tier FROM leads WHERE phone = ?').get(phone) as any;
  if (lead?.price_tier && ['A', 'B', 'C'].includes(lead.price_tier)) return lead.price_tier as 'A' | 'B' | 'C';

  // Assign deterministically: sum of digits mod 3
  const sum = phone.replace(/\D/g, '').split('').reduce((s, d) => s + parseInt(d), 0);
  const tier = (['A', 'B', 'C'] as const)[sum % 3];

  // Save to DB
  try {
    db.prepare('UPDATE leads SET price_tier = ? WHERE phone = ?').run(tier, phone);
  } catch (e) { log.debug({ err: (e as Error).message, phone }, 'price tier DB save failed'); }

  return tier;
}

function getTierPrices(tier: 'A' | 'B' | 'C') {
  return PRICE_TIERS[tier];
}

// ── Lead Scoring Helper ──
// 0=unknown, 1=cold, 2=warm, 3=hot, 4=fire
function bumpLeadScore(phone: string, action: 'message' | 'checkout' | 'paid' | 'booked' | 'clicked_link') {
  const scoreMap = { message: 2, clicked_link: 2, checkout: 3, booked: 3, paid: 4 };
  const newScore = scoreMap[action] || 1;
  try {
    db.prepare(`UPDATE leads SET lead_score = MAX(COALESCE(lead_score, 0), ?), updated_at = ? WHERE phone = ?`).run(newScore, nowIsrael(), phone);
  } catch (e) { log.debug({ err: (e as Error).message, phone, action }, 'lead score bump failed'); }
}

// ── Smart Timing Helper — Israel quiet hours ──
function isQuietHours(): boolean {
  const israelHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: 'numeric', hour12: false }));
  return israelHour >= 22 || israelHour < 8;
}

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
app.get('/manifest-wa-mobile.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  // Inject token into start_url so PWA home screen launch includes it
  const token = req.query.token || config.dashboardSecret;
  const manifest = JSON.parse(manifestWaMobileJSON);
  manifest.start_url = `/wa-mobile?token=${token}`;
  res.send(JSON.stringify(manifest));
});
app.get('/icon-wa-192.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(iconWa192);
});
app.get('/icon-wa-512.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(iconWa512);
});
app.get('/apple-touch-icon-wa.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(appleTouchIconWa);
});
app.get('/favicon-wa-32.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(faviconWa32);
});
app.get('/icon-wa-blue-192.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(iconWaBlue192);
});
app.get('/icon-wa-blue-512.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(iconWaBlue512);
});
app.get('/apple-touch-icon-wa-blue.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(appleTouchIconWaBlue);
});
app.get('/favicon-wa-blue-32.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.send(faviconWaBlue32);
});
app.get('/wa-manager-manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.send(waManagerManifestJSON);
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
      path: config.dataDir,
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

// ===== Web Push Notifications (VAPID) =====
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BNI2cmVacqU-ko85HdAztRuHeIkcEkSkqtowzctVvRmlsaAVCLYq-SJ4rfHiHlJavEINc8dDieQGPA-fK2jaGOo';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'tJ2AEB-UTaKnLnHgeZbAJ8LOQv8NtpfK43o2JKoFQkc';
webpush.setVapidDetails('mailto:alondevoffice@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

// Create push_subscriptions table
try {
  db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at TEXT
  )`);
} catch (e) { log.debug({ err: (e as Error).message }, 'push_subscriptions table creation failed'); }

// Seed example chatbot flows
import('./flow-engine.js').then(m => { m.seedExampleFlows(); m.migrateFlowsAddVoice(); }).catch((e) => { log.debug({ err: (e as Error).message }, 'seed/migrate flows failed'); });

// Setup follow-up cron
import('./followup-engine.js').then(m => m.setupFollowupCron()).catch((e) => { log.debug({ err: (e as Error).message }, 'followup cron setup failed'); });

// Setup no-show detection engine
import('./no-show-engine.js').then(m => m.startNoShowEngine()).catch((e) => { log.debug({ err: (e as Error).message }, 'no-show engine setup failed'); });

// Public key endpoint (no auth — needed before subscribing)
app.get('/api/push/vapid-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Subscribe endpoint
app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    res.status(400).json({ success: false, error: 'Invalid subscription' });
    return;
  }
  try {
    db.prepare('INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?)')
      .run(endpoint, keys.p256dh, keys.auth);
    log.info('push subscription saved');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Unsubscribe
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
  res.json({ success: true });
});

// Test push — sends a test notification to all subscribers with detailed results
app.post('/api/push/test', dashAuth, async (_req, res) => {
  try {
    const subs = db.prepare('SELECT * FROM push_subscriptions').all() as any[];
    if (!subs.length) return res.json({ success: false, error: 'No subscribers', subscribers: 0 });
    const data = JSON.stringify({
      title: '360Shmikley - בדיקה',
      body: 'ההתראות עובדות! 🎉',
      tag: 'test-' + Date.now(),
    });
    const results: any[] = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
        }, data);
        results.push({ endpoint: sub.endpoint.slice(-30), status: 'ok' });
      } catch (e: any) {
        results.push({ endpoint: sub.endpoint.slice(-30), status: 'error', code: e.statusCode, message: e.body || e.message });
        log.warn({ err: e.message, statusCode: e.statusCode, endpoint: sub.endpoint.slice(-30) }, 'push test send failed');
      }
    }
    res.json({ success: true, subscribers: subs.length, results });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Send push notification to all subscribers
export async function sendPushNotification(payload: { title: string; body: string; phone?: string; url?: string; tag?: string }) {
  try {
    const subs = db.prepare('SELECT * FROM push_subscriptions').all() as any[];
    if (!subs.length) return;
    const data = JSON.stringify(payload);
    const stale: string[] = [];
    await Promise.allSettled(subs.map(async (sub) => {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
        }, data);
      } catch (e: any) {
        log.warn({ err: e.message, statusCode: e.statusCode }, 'push send failed for subscriber');
        if (e.statusCode === 410 || e.statusCode === 404) {
          stale.push(sub.endpoint);
        }
      }
    }));
    // Clean up expired subscriptions
    if (stale.length) {
      const placeholders = stale.map(() => '?').join(',');
      db.prepare(`DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`).run(...stale);
      log.info({ count: stale.length }, 'removed stale push subscriptions');
    }
  } catch (e: any) {
    log.error({ err: e.message }, 'push notification dispatch failed');
  }
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
  } catch (e) { log.debug({ err: (e as Error).message }, 'settings table may not exist yet'); }

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
// Signed auth cookie that survives server restarts (HMAC-based, no server state needed)
const AUTH_COOKIE = 'alonbot_auth';
function signToken(secret: string): string {
  const expires = Date.now() + SESSION_TTL;
  const payload = `${secret}:${expires}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  return `${expires}:${sig}`;
}
function verifyAuthCookie(cookieVal: string, secret: string): boolean {
  try {
    const [expiresStr, sig] = cookieVal.split(':');
    const expires = parseInt(expiresStr);
    if (Date.now() > expires) return false;
    const payload = `${secret}:${expires}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
    return sig === expected;
  } catch (e) { log.debug({ err: (e as Error).message }, 'auth cookie verification failed'); return false; }
}

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

// === CSRF Protection for state-changing endpoints ===
function csrfCheck(req: any, res: any, next: any) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // Allow API clients with explicit secret header (programmatic access)
  if (req.headers['x-api-secret'] || req.headers['x-dashboard-token']) return next();
  // Check Origin/Referer header for cross-origin attacks
  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  const host = req.headers['host'] || '';
  if (origin && !origin.includes(host) && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
    res.status(403).json({ error: 'CSRF check failed — origin mismatch' });
    return;
  }
  if (!origin && referer && !referer.includes(host) && !referer.includes('localhost') && !referer.includes('127.0.0.1')) {
    res.status(403).json({ error: 'CSRF check failed — referer mismatch' });
    return;
  }
  next();
}
app.use('/api/wa-manager', csrfCheck);
app.use('/api/dashboard', csrfCheck);

// === Dashboard API (protected by cookie-based sessions) ===
function dashAuth(req: any, res: any, next: any) {
  const ip = getClientIp(req);

  // 1. Check rate limit
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    return;
  }

  // 2. Check signed auth cookie (survives server restarts)
  const cookies = parseCookies(req);
  if (cookies[AUTH_COOKIE] && verifyAuthCookie(cookies[AUTH_COOKIE], config.dashboardSecret)) {
    next();
    return;
  }

  // 3. Check in-memory session cookie (legacy, cleared on restart)
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session && Date.now() - session.createdAt < SESSION_TTL) {
      next();
      return;
    }
    if (session) sessions.delete(sessionId);
  }

  // 4. Check query token
  if (req.query.token === config.dashboardSecret) {
    const newSession = crypto.randomBytes(32).toString('hex');
    sessions.set(newSession, { createdAt: Date.now() });

    const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.secure;
    // Set both: signed cookie (persists across restarts) + session cookie (legacy)
    const authCookie = `${AUTH_COOKIE}=${signToken(config.dashboardSecret)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}${isSecure ? '; Secure' : ''}`;
    const sessionCookie = `${SESSION_COOKIE}=${newSession}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}${isSecure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', [authCookie, sessionCookie]);

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
// Import campaign messages for leads that have no messages logged
app.post('/api/wa-manager/import-campaign-messages', dashAuth, (_req, res) => {
  try {
    const leadsWithoutMsgs = db.prepare(`
      SELECT l.phone, l.name FROM leads l
      WHERE NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.sender_id = l.phone
        AND m.channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
      )
    `).all() as any[];
    if (!leadsWithoutMsgs.length) {
      res.json({ success: true, imported: 0 });
      return;
    }
    const stmt = db.prepare(`INSERT INTO messages (channel, sender_id, sender_name, role, content, created_at)
      VALUES ('whatsapp-outbound', ?, ?, 'assistant', ?, ?)`);
    let count = 0;
    for (const lead of leadsWithoutMsgs) {
      stmt.run(lead.phone, lead.name || lead.phone, 'הודעת קמפיין נשלחה', nowIsrael());
      count++;
    }
    // Schedule follow-ups for imported leads
    import('./followup-engine.js').then(({ scheduleFirstFollowup }) => {
      for (const lead of leadsWithoutMsgs) {
        scheduleFirstFollowup(lead.phone);
      }
    }).catch((e: any) => { log.warn({ err: e.message }, 'followup schedule for campaign import failed'); });
    log.info({ count }, 'campaign messages imported + follow-ups scheduled');
    res.json({ success: true, imported: count });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Log external message (from campaign scripts, etc.) ──
// Accepts both dashboard auth AND x-api-secret for campaign script compatibility
app.post('/api/wa-manager/log-external-message', (req: any, res: any, next: any) => {
  if (req.headers['x-api-secret'] === config.localApiSecret) return next();
  dashAuth(req, res, next);
}, (req: any, res: any) => {
  try {
    const { phone, message, direction, sender_name } = req.body || {};
    if (!phone || !message) {
      res.status(400).json({ success: false, error: 'phone and message required' });
      return;
    }
    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const channel = direction === 'inbound' ? 'whatsapp-inbound' : 'whatsapp-outbound';
    const role = direction === 'inbound' ? 'user' : 'assistant';
    // Ensure lead exists in leads table
    const source = req.body.source || 'alon_dev';
    const now = nowIsrael();
    db.prepare(`INSERT INTO leads (phone, name, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET updated_at = ?`)
      .run(normalizedPhone, sender_name || normalizedPhone, source, now, now, now);
    bumpLeadScore(normalizedPhone, 'message');
    db.prepare(`INSERT INTO messages (channel, sender_id, sender_name, role, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(channel, normalizedPhone, sender_name || normalizedPhone, role, message, now);
    log.info({ phone: normalizedPhone, direction }, 'external message logged');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Meta Health: WhatsApp number quality + WABA status + Ads overview ──
app.get('/api/wa-manager/meta-health', dashAuth, async (_req, res) => {
  try {
    const token = config.waCloudToken;
    const phoneId = config.waCloudPhoneId;
    const wabaId = config.waCloudWabaId;
    if (!token || !phoneId) {
      res.json({ success: false, error: 'WhatsApp Cloud API not configured' });
      return;
    }
    // Phone number quality + status
    const phoneRes = await fetch(`https://graph.facebook.com/v21.0/${phoneId}?fields=verified_name,quality_rating,display_phone_number,platform_type,code_verification_status,name_status,messaging_limit_tier`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const phoneData = await phoneRes.json();

    // WABA account info
    let wabaData: any = {};
    if (wabaId) {
      const wabaRes = await fetch(`https://graph.facebook.com/v21.0/${wabaId}?fields=name,account_review_status,message_template_namespace,timezone_id`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      wabaData = await wabaRes.json();
    }

    // Facebook Ads overview for alon.dev account
    let adsData: any = null;
    if (config.fbAccessToken) {
      try {
        const adsRes = await fetch(`https://graph.facebook.com/v21.0/act_1314904720689466/insights?fields=spend,impressions,clicks,actions,cpc,ctr,cpp&date_preset=last_7d&access_token=${config.fbAccessToken}`);
        const adsJson = await adsRes.json();
        adsData = adsJson.data?.[0] || null;
      } catch (e) { log.debug({ err: (e as Error).message }, 'FB ads overview fetch failed'); }
    }

    res.json({
      success: true,
      phone: {
        verified_name: phoneData.verified_name,
        quality_rating: phoneData.quality_rating,
        display_phone_number: phoneData.display_phone_number,
        platform_type: phoneData.platform_type,
        name_status: phoneData.name_status,
        messaging_limit_tier: phoneData.messaging_limit_tier,
      },
      waba: {
        name: wabaData.name,
        review_status: wabaData.account_review_status,
      },
      ads: adsData,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Profile Picture: lookup WhatsApp contact profile pic ──
app.get('/api/wa-manager/profile-pic/:phone', dashAuth, async (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');

    // Check cache in DB first
    const cached = db.prepare('SELECT profile_pic_url FROM leads WHERE phone = ?').get(phone) as any;
    if (cached?.profile_pic_url) {
      res.json({ success: true, url: cached.profile_pic_url });
      return;
    }

    // Try Evolution API (Baileys) — supports profile pictures
    if (config.evolutionApiUrl && config.evolutionApiKey) {
      try {
        const evoRes = await fetch(`${config.evolutionApiUrl}/chat/fetchProfilePictureUrl/${config.evolutionInstance}`, {
          method: 'POST',
          headers: { apikey: config.evolutionApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: phone })
        });
        const evoData = await evoRes.json();
        if (evoData?.profilePictureUrl) {
          // Cache in DB
          db.prepare('UPDATE leads SET profile_pic_url = ? WHERE phone = ?').run(evoData.profilePictureUrl, phone);
          res.json({ success: true, url: evoData.profilePictureUrl });
          return;
        }
      } catch (e) { log.debug({ err: (e as Error).message, phone }, 'profile pic fetch failed'); }
    }

    res.json({ success: true, url: null });
  } catch (e: any) {
    res.json({ success: false, url: null });
  }
});

// ── Batch Profile Pictures ──
app.post('/api/wa-manager/profile-pics-batch', dashAuth, async (req, res) => {
  try {
    const phones: string[] = (req.body.phones || []).slice(0, 20);
    if (!config.evolutionApiUrl || !config.evolutionApiKey) {
      res.json({ success: true, results: {} });
      return;
    }
    const results: Record<string, string | null> = {};
    for (const rawPhone of phones) {
      const phone = rawPhone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
      const cached = db.prepare('SELECT profile_pic_url FROM leads WHERE phone = ?').get(phone) as any;
      if (cached?.profile_pic_url) {
        results[rawPhone] = cached.profile_pic_url;
        continue;
      }
      try {
        const evoRes = await fetch(`${config.evolutionApiUrl}/chat/fetchProfilePictureUrl/${config.evolutionInstance}`, {
          method: 'POST',
          headers: { apikey: config.evolutionApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ number: phone })
        });
        const evoData = await evoRes.json();
        if (evoData?.profilePictureUrl) {
          db.prepare('UPDATE leads SET profile_pic_url = ? WHERE phone = ?').run(evoData.profilePictureUrl, phone);
          results[rawPhone] = evoData.profilePictureUrl;
        } else {
          results[rawPhone] = null;
        }
      } catch (e) {
        log.debug({ err: (e as Error).message, rawPhone }, 'batch profile pic fetch failed');
        results[rawPhone] = null;
      }
    }
    res.json({ success: true, results });
  } catch (e: any) {
    console.error('profile-pics-batch error:', e?.message || e);
    res.json({ success: false, results: {}, error: e?.message });
  }
});

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
        (SELECT COUNT(*) FROM messages m WHERE m.sender_id = l.phone AND m.channel IN ('whatsapp','whatsapp-inbound') AND m.role = 'user') as user_reply_count,
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
      SELECT id, channel, sender_id, sender_name, role, content, created_at
      FROM messages
      WHERE sender_id = ? AND channel IN ('whatsapp-inbound','whatsapp-outbound')
      ORDER BY id ASC
    `).all(phone);
    // Get delivery receipts for this phone to determine read/delivered status
    const receipts = db.prepare(`
      SELECT status, read_at, delivered_at, sent_at FROM delivery_receipts
      WHERE phone = ? ORDER BY created_at DESC LIMIT 10
    `).all(phone) as { status: string; read_at: string | null; delivered_at: string | null; sent_at: string | null }[];
    const lastRead = receipts.find(r => r.read_at);
    const lastDelivered = receipts.find(r => r.delivered_at);
    const deliveryStatus = lastRead ? 'read' : lastDelivered ? 'delivered' : 'sent';
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
    res.json({ success: true, lead, messages, deliveryStatus });
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
      ? db.prepare(`SELECT COUNT(*) as count FROM leads WHERE lead_status IN ('${LEAD_STATUS.NEW}','${LEAD_STATUS.CONTACTED}') AND source IN (${srcPlaceholders})`).get(...sources) as any
      : db.prepare(`SELECT COUNT(*) as count FROM leads WHERE lead_status IN ('${LEAD_STATUS.NEW}','${LEAD_STATUS.CONTACTED}')`).get() as any;
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
    } catch (e) { log.debug({ err: (e as Error).message }, 'avg response time calc failed'); }

    // Bot activity stats (Feature 5)
    const botMessagesToday = db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE role = 'assistant' AND channel IN ('whatsapp','whatsapp-outbound')
      AND date(created_at) = date('now')
    `).get() as any;
    const botMeetingsBooked = db.prepare(`
      SELECT COUNT(*) as count FROM leads
      WHERE was_booked = 1 AND date(updated_at) >= date('now', '-7 days')
    `).get() as any;
    const leadsRepliedToday = db.prepare(`
      SELECT COUNT(DISTINCT sender_id) as count FROM messages
      WHERE role = 'user' AND channel IN ('whatsapp','whatsapp-inbound')
      AND date(created_at) = date('now')
    `).get() as any;
    const hotLeads = db.prepare(`
      SELECT COUNT(DISTINCT phone) as count FROM lead_tags WHERE tag = 'hot'
    `).get() as any;
    const botPausedCount = db.prepare(`
      SELECT COUNT(*) as count FROM leads WHERE bot_paused = 1
    `).get() as any;

    // Interactive messages stats (buttons, lists, CTA)
    const interactiveCount = db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE role = 'assistant' AND content LIKE '%[interactive:%'
      AND channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
    `).get() as any;
    const buttonsCount = db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE role = 'assistant' AND content LIKE '%[interactive:buttons:%'
      AND channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
    `).get() as any;
    const listsCount = db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE role = 'assistant' AND content LIKE '%[interactive:list:%'
      AND channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
    `).get() as any;
    const ctaCount = db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE role = 'assistant' AND content LIKE '%[interactive:cta:%'
      AND channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
    `).get() as any;
    const voiceCount = db.prepare(`
      SELECT COUNT(*) as count FROM messages
      WHERE role = 'assistant' AND content LIKE '%[media:voice%'
      AND channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')
    `).get() as any;

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
      botMessagesToday: botMessagesToday.count,
      botMeetingsBooked: botMeetingsBooked.count,
      leadsRepliedToday: leadsRepliedToday.count,
      hotLeads: hotLeads.count,
      botPausedCount: botPausedCount.count,
      interactiveCount: interactiveCount.count,
      buttonsCount: buttonsCount.count,
      listsCount: listsCount.count,
      ctaCount: ctaCount.count,
      voiceCount: voiceCount.count,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Toggle bot pause for a specific lead (manual mode)
app.post('/api/wa-manager/bot-pause', dashAuth, (req, res) => {
  try {
    const { phone, paused } = req.body;
    if (!phone) { res.status(400).json({ success: false, error: 'Missing phone' }); return; }
    db.prepare('UPDATE leads SET bot_paused = ?, updated_at = datetime(\'now\') WHERE phone = ?').run(paused ? 1 : 0, phone);
    res.json({ success: true, paused: !!paused });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/wa-manager/send', dashAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    res.status(400).json({ success: false, error: 'Missing phone or message' });
    return;
  }
  try {
    let chatPhone = phone.replace(/[\s\-\(\)]/g, '');
    if (chatPhone.startsWith('0')) chatPhone = '972' + chatPhone.slice(1);
    chatPhone = chatPhone.replace(/^\+/, '');

    // Try adapter first, fall back to direct Cloud API
    const { getAdapter } = await import('./router.js');
    const wa = getAdapter('whatsapp');
    if (wa) {
      const chatId = `${chatPhone}@s.whatsapp.net`;
      await wa.sendReply(
        { id: 'wa-mgr', channel: 'whatsapp', senderId: chatPhone, senderName: '', text: '', timestamp: Date.now(), raw: { from: chatId } },
        { text: message }
      );
    } else if (config.waCloudToken && config.waCloudPhoneId) {
      // Direct Cloud API fallback
      const r = await fetch(`https://graph.facebook.com/v21.0/${config.waCloudPhoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${config.waCloudToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: chatPhone, type: 'text', text: { body: message } }),
      });
      const data = await r.json() as any;
      if (data.error) throw new Error(data.error.message || 'Cloud API error');
      // Save wamid for delivery receipt tracking
      const wamid = data.messages?.[0]?.id;
      if (wamid) {
        try {
          const nowTs = nowIsrael();
          db.prepare(`INSERT INTO delivery_receipts (wamid, phone, status, created_at, sent_at) VALUES (?, ?, 'sent', ?, ?)
            ON CONFLICT(wamid) DO UPDATE SET status = 'sent', sent_at = ?`).run(wamid, chatPhone, nowTs, nowTs, nowTs);
        } catch (e) { log.debug({ err: (e as Error).message }, 'delivery receipt insert failed'); }
      }
    } else {
      res.json({ success: false, error: 'WhatsApp not connected' });
      return;
    }

    try {
      db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)`).run(chatPhone, message, nowIsrael());
    } catch (e) { log.warn({ err: (e as Error).message }, 'message log DB write failed'); }
    // WebSocket broadcast so CRM updates in real-time
    try {
      wsBroadcast({ type: 'new_message', phone: chatPhone, name: 'Alon', text: message.slice(0, 200), role: 'assistant', timestamp: new Date().toISOString() });
    } catch { /* non-critical */ }
    log.info({ phone: chatPhone }, 'wa-manager: message sent');
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Send image/document via WhatsApp from dashboard
app.post('/api/wa-manager/send-media', dashAuth, async (req, res) => {
  const { phone, caption, mediaBase64, mimeType, filename } = req.body;
  if (!phone || !mediaBase64) {
    res.status(400).json({ success: false, error: 'Missing phone or mediaBase64' });
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
    const buffer = Buffer.from(mediaBase64, 'base64');
    const isImage = (mimeType || '').startsWith('image/');
    const fakeMsg = { id: 'wa-mgr', channel: 'whatsapp' as const, senderId: chatPhone, senderName: '', text: '', timestamp: Date.now(), raw: { from: `${chatPhone}@s.whatsapp.net` } };

    if (isImage) {
      await wa.sendReply(fakeMsg, { text: caption || '', image: buffer });
    } else {
      await wa.sendReply(fakeMsg, { text: caption || '', document: buffer, documentName: filename || 'file', documentMimetype: mimeType });
    }
    try {
      const label = isImage ? '[תמונה]' : `[קובץ: ${filename || 'file'}]`;
      db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)`).run(chatPhone, caption ? `${label} ${caption}` : label, nowIsrael());
    } catch (e) { log.debug({ err: (e as Error).message }, 'media send DB log failed'); }
    log.info({ phone: chatPhone, type: isImage ? 'image' : 'document' }, 'wa-manager: media sent');
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
        } catch (e) { log.debug({ err: (e as Error).message }, 'broadcast personalize failed'); }

        await wa.sendReply(
          { id: 'wa-broadcast', channel: 'whatsapp', senderId: chatPhone, senderName: '', text: '', timestamp: Date.now(), raw: { from: chatId } },
          { text: personalMsg }
        );
        try {
          db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)`).run(chatPhone, personalMsg, nowIsrael());
        } catch (e) { log.warn({ err: (e as Error).message }, 'broadcast message log DB write failed'); }
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
    const { lead_status, tags, name, source } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (lead_status !== undefined) {
      // Record status history
      try {
        const current = db.prepare('SELECT lead_status FROM leads WHERE phone = ?').get(phone) as any;
        db.prepare('INSERT INTO status_history (phone, old_status, new_status) VALUES (?, ?, ?)').run(phone, current?.lead_status || null, lead_status);
      } catch (e) { log.debug({ err: (e as Error).message }, 'status history recording failed'); }
      updates.push('lead_status = ?'); params.push(lead_status);
    }
    if (source !== undefined) { updates.push('source = ?'); params.push(source); }
    else if (tags !== undefined) { updates.push('source = ?'); params.push(tags); }
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (updates.length === 0) {
      res.status(400).json({ success: false, error: 'No fields to update' });
      return;
    }
    updates.push("updated_at = ?");
    params.push(nowIsrael());
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
        l.lead_status || LEAD_STATUS.NEW, l.was_booked ? 'כן' : 'לא',
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
      try { f.steps = JSON.parse(f.steps); } catch (e) { log.debug({ err: (e as Error).message, flowId: f.id }, 'flow steps JSON parse failed'); f.steps = []; }
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

// Run a flow manually for selected leads
app.post('/api/wa-manager/flows/:id/run', dashAuth, async (req, res) => {
  try {
    const flowId = parseInt(req.params.id);
    const { phones } = req.body; // Array of phone numbers, or 'all' for all leads
    const { executeFlow } = await import('./flow-engine.js');

    let targetPhones: string[] = [];
    if (phones === 'all' || !phones) {
      const leads = db.prepare('SELECT phone FROM leads').all() as any[];
      targetPhones = leads.map((l: any) => l.phone);
    } else if (Array.isArray(phones)) {
      targetPhones = phones;
    }

    // Execute in background
    let started = 0;
    for (const phone of targetPhones) {
      executeFlow(flowId, phone).catch((e: any) => { log.warn({ err: e.message, flowId, phone }, 'flow execution failed'); });
      started++;
    }

    res.json({ success: true, started, flowId });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// === Follow-up Management Endpoints ===

// Get follow-up config
app.get('/api/wa-manager/followup/config', dashAuth, async (_req, res) => {
  try {
    const { getFollowupConfig } = await import('./followup-engine.js');
    res.json({ success: true, config: getFollowupConfig() });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Update follow-up config
app.patch('/api/wa-manager/followup/config', dashAuth, (req, res) => {
  try {
    const allowed = ['auto_enabled', 'send_hour', 'max_followups', 'skip_statuses', 'skip_replied'];
    for (const [key, value] of Object.entries(req.body)) {
      if (!allowed.includes(key)) continue;
      const val = typeof value === 'boolean' ? String(value) : Array.isArray(value) ? value.join(',') : String(value);
      db.prepare("INSERT OR REPLACE INTO followup_config (key, value, updated_at) VALUES (?, ?, ?)").run(key, val, nowIsrael());
    }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Get follow-up templates
app.get('/api/wa-manager/followup/templates', dashAuth, (_req, res) => {
  try {
    const templates = db.prepare('SELECT * FROM followup_templates ORDER BY sort_order ASC, id ASC').all();
    res.json({ success: true, templates });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Create follow-up template
app.post('/api/wa-manager/followup/templates', dashAuth, (req, res) => {
  try {
    const { name, day_offset, message, message_type, sort_order } = req.body;
    if (!name || !message) { res.status(400).json({ success: false, error: 'Missing name or message' }); return; }
    const result = db.prepare('INSERT INTO followup_templates (name, day_offset, message, message_type, sort_order) VALUES (?, ?, ?, ?, ?)').run(
      name, day_offset || 3, message, message_type || 'text', sort_order || 0
    );
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Update follow-up template
app.patch('/api/wa-manager/followup/templates/:id', dashAuth, (req, res) => {
  try {
    const { name, day_offset, message, message_type, sort_order, enabled } = req.body;
    const updates: string[] = [];
    const params: any[] = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (day_offset !== undefined) { updates.push('day_offset = ?'); params.push(day_offset); }
    if (message !== undefined) { updates.push('message = ?'); params.push(message); }
    if (message_type !== undefined) { updates.push('message_type = ?'); params.push(message_type); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order); }
    if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (!updates.length) { res.status(400).json({ success: false, error: 'No fields' }); return; }
    params.push(req.params.id);
    db.prepare(`UPDATE followup_templates SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Delete follow-up template
app.delete('/api/wa-manager/followup/templates/:id', dashAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM followup_templates WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Get pending follow-ups (leads that need follow-up today)
app.get('/api/wa-manager/followup/pending', dashAuth, async (_req, res) => {
  try {
    const { getPendingFollowups } = await import('./followup-engine.js');
    const pending = getPendingFollowups();
    res.json({ success: true, pending, count: pending.length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Send follow-up to a specific lead
app.post('/api/wa-manager/followup/send', dashAuth, async (req, res) => {
  try {
    const { phone, template_id } = req.body;
    if (!phone) { res.status(400).json({ success: false, error: 'Missing phone' }); return; }
    const { sendFollowup } = await import('./followup-engine.js');
    const result = await sendFollowup(phone, template_id);
    res.json({ success: true, ...result });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Postpone follow-up for a lead
app.post('/api/wa-manager/followup/postpone', dashAuth, (req, res) => {
  try {
    const { phone, days } = req.body;
    if (!phone) { res.status(400).json({ success: false, error: 'Missing phone' }); return; }
    const israelDate = nowIsrael().slice(0, 10);
    db.prepare(`UPDATE leads SET next_followup = date(?, '+${Math.max(1, Math.min(days || 1, 30))} days'), updated_at = ? WHERE phone = ?`).run(israelDate, nowIsrael(), phone);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Cancel follow-up for a lead
app.post('/api/wa-manager/followup/cancel', dashAuth, (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) { res.status(400).json({ success: false, error: 'Missing phone' }); return; }
    db.prepare("UPDATE leads SET next_followup = NULL, updated_at = ? WHERE phone = ?").run(nowIsrael(), phone);
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Run auto follow-ups now (manual trigger)
app.post('/api/wa-manager/followup/run-auto', dashAuth, async (req, res) => {
  try {
    const workspace = req.body?.workspace as string | undefined;
    const { runAutoFollowups } = await import('./followup-engine.js');
    const result = await runAutoFollowups(workspace);
    res.json({ success: true, ...result });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Schedule first follow-up for a lead
app.post('/api/wa-manager/followup/schedule', dashAuth, (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) { res.status(400).json({ success: false, error: 'Missing phone' }); return; }
    import('./followup-engine.js').then(({ scheduleFirstFollowup }) => {
      scheduleFirstFollowup(phone);
      res.json({ success: true });
    });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Lead score endpoint
app.get('/api/wa-manager/followup/score/:phone', dashAuth, async (req, res) => {
  try {
    const { calculateLeadScore } = await import('./followup-engine.js');
    const result = calculateLeadScore(req.params.phone);
    res.json({ success: true, ...result });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ===== Meetings & No-Show =====

// Record a meeting
app.post('/api/wa-manager/meetings', dashAuth, (req, res) => {
  try {
    const { phone, leadName, meetingTime, durationMin, meetingLink, calendarEventId } = req.body;
    if (!phone || !meetingTime) { res.status(400).json({ success: false, error: 'Missing phone or meetingTime' }); return; }
    import('./no-show-engine.js').then(({ recordMeeting }) => {
      const id = recordMeeting({ phone, leadName, meetingTime, durationMin, meetingLink, calendarEventId });
      res.json({ success: true, meetingId: id });
    });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// List meetings
app.get('/api/wa-manager/meetings', dashAuth, (_req, res) => {
  try {
    const meetings = db.prepare('SELECT * FROM meetings ORDER BY meeting_time DESC LIMIT 50').all();
    res.json({ success: true, meetings });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Mark meeting completed
app.post('/api/wa-manager/meetings/:phone/complete', dashAuth, (req, res) => {
  try {
    import('./no-show-engine.js').then(({ markMeetingCompleted }) => {
      markMeetingCompleted(req.params.phone);
      res.json({ success: true });
    });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Morning report endpoint
app.get('/api/wa-manager/followup/morning-report', dashAuth, async (_req, res) => {
  try {
    const { generateMorningReport } = await import('./followup-engine.js');
    const report = generateMorningReport();
    res.json({ success: true, report });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Follow-up history for a lead
app.get('/api/wa-manager/followup/history/:phone', dashAuth, (_req, res) => {
  try {
    const phone = _req.params.phone;
    const history = db.prepare(`
      SELECT content, created_at, role, channel FROM messages
      WHERE sender_id = ? AND channel IN ('whatsapp-outbound','whatsapp','whatsapp-inbound')
        AND (content LIKE '%[Template:%' OR content LIKE '%פולואפ%' OR content LIKE '%followup%')
      ORDER BY created_at DESC LIMIT 20
    `).all(phone);
    const lead = db.prepare('SELECT followup_count, next_followup FROM leads WHERE phone = ?').get(phone) as any;
    res.json({ success: true, history, followup_count: lead?.followup_count || 0, next_followup: lead?.next_followup });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Pipeline summary (kanban data)
app.get('/api/wa-manager/followup/pipeline', dashAuth, (_req, res) => {
  try {
    const stages = [...PIPELINE_STAGES];
    const pipeline: Record<string, any[]> = {};
    for (const stage of stages) {
      pipeline[stage] = db.prepare(`
        SELECT l.phone, l.name, l.source, l.lead_status, l.followup_count, l.next_followup,
          (SELECT COUNT(*) FROM messages WHERE sender_id = l.phone AND role = 'user' AND channel IN ('whatsapp','whatsapp-inbound')) as replies
        FROM leads l WHERE l.lead_status = ? ORDER BY l.updated_at DESC LIMIT 50
      `).all(stage);
    }
    // Also get leads with NULL status (treat as 'new')
    const noStatus = db.prepare(`
      SELECT l.phone, l.name, l.source, '${LEAD_STATUS.NEW}' as lead_status, l.followup_count, l.next_followup,
        (SELECT COUNT(*) FROM messages WHERE sender_id = l.phone AND role = 'user' AND channel IN ('whatsapp','whatsapp-inbound')) as replies
      FROM leads l WHERE l.lead_status IS NULL ORDER BY l.updated_at DESC LIMIT 50
    `).all();
    pipeline[LEAD_STATUS.NEW] = [...(pipeline[LEAD_STATUS.NEW] || []), ...noStatus];
    // Count totals
    const totals: Record<string, number> = {};
    for (const [stage, leads] of Object.entries(pipeline)) {
      totals[stage] = leads.length;
    }
    res.json({ success: true, pipeline, totals });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Re-engage old leads (monthly)
app.post('/api/wa-manager/followup/reengage', dashAuth, async (req, res) => {
  try {
    const { days_inactive = 30 } = req.body || {};
    const staleLeads = db.prepare(`
      SELECT phone, name FROM leads
      WHERE lead_status NOT IN ('${LEAD_STATUS.CLOSED}','${LEAD_STATUS.NOT_RELEVANT}','${LEAD_STATUS.REFUSED}','done')
        AND next_followup IS NULL
        AND updated_at < datetime('now', '-${Math.max(7, Math.min(days_inactive, 90))} days')
      ORDER BY updated_at DESC LIMIT 50
    `).all() as any[];

    let scheduled = 0;
    const { scheduleFirstFollowup } = await import('./followup-engine.js');
    for (const lead of staleLeads) {
      scheduleFirstFollowup(lead.phone);
      db.prepare("UPDATE leads SET followup_count = 0, updated_at = ? WHERE phone = ?").run(nowIsrael(), lead.phone);
      scheduled++;
    }
    res.json({ success: true, scheduled, total_stale: staleLeads.length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// Quick reply (send a quick text message)
app.post('/api/wa-manager/followup/quick-reply', dashAuth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) { res.status(400).json({ success: false, error: 'Missing phone or message' }); return; }
    const token = config.waCloudToken;
    const phoneId = config.waCloudPhoneId;
    if (!token || !phoneId) { res.status(500).json({ success: false, error: 'Cloud API not configured' }); return; }
    const to = phone.replace(/\D/g, '');
    const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } })
    });
    if (!resp.ok) throw new Error(`WhatsApp API error: ${resp.status}`);
    db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)").run(phone, message, nowIsrael());
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

// Create WhatsApp message template via Meta Graph API
app.post('/api/wa-manager/create-template', dashAuth, async (req, res) => {
  try {
    const { name, category, language, headerType, headerText, body, footer, buttons } = req.body;
    if (!name || !body) { res.status(400).json({ success: false, error: 'name and body are required' }); return; }
    const wabaId = config.waCloudWabaId || '1289908913100682';
    const token = config.waCloudToken;
    if (!token) { res.status(400).json({ success: false, error: 'Cloud API token not configured' }); return; }

    // Build components array
    const components: any[] = [];

    // Header component
    if (headerType && headerType !== 'NONE') {
      if (headerType === 'TEXT' && headerText) {
        components.push({ type: 'HEADER', format: 'TEXT', text: headerText });
      } else if (headerType === 'IMAGE') {
        components.push({ type: 'HEADER', format: 'IMAGE' });
      }
    }

    // Body component (required)
    components.push({ type: 'BODY', text: body });

    // Footer component
    if (footer) {
      components.push({ type: 'FOOTER', text: footer });
    }

    // Buttons component
    if (buttons && Array.isArray(buttons) && buttons.length > 0) {
      const btns = buttons.map((b: any) => {
        if (b.type === 'QUICK_REPLY') {
          return { type: 'QUICK_REPLY', text: b.text };
        } else if (b.type === 'URL') {
          return { type: 'URL', text: b.text, url: b.url };
        } else if (b.type === 'PHONE_NUMBER') {
          return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
        }
        return { type: b.type, text: b.text };
      });
      components.push({ type: 'BUTTONS', buttons: btns });
    }

    const payload = {
      name,
      category: category || 'MARKETING',
      language: language || 'he',
      components
    };

    log.info({ name, category, language, componentsCount: components.length }, 'creating template');

    const r = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/message_templates`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json() as any;

    if (data.error) {
      log.error({ error: data.error }, 'Meta create template API error');
      res.json({ success: false, error: data.error });
      return;
    }

    res.json({ success: true, template: data });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// WA Inbox HTML — served without auth (API calls still require token)
app.get('/wa-inbox', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.send(waInboxHTML);
});

// WA Mobile PWA (iPhone app) — served without dashAuth so PWA home screen launch works
// Auth is enforced on API calls; the HTML shell itself contains no sensitive data
app.get('/wa-mobile', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.send(waMobileHTML);
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

// --- Claude Memory Sync ---
// Upload memory files from Claude Code / Obsidian → AlonBot
const MEMORY_DIR = join(config.dataDir, 'claude-memory');
if (!fsExists(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

// POST /api/memory/sync — bulk upload memory files
app.post('/api/memory/sync', externalAuth, (req, res) => {
  try {
    const { files } = req.body; // [{name: "user_profile.md", content: "..."}]
    if (!Array.isArray(files)) {
      res.status(400).json({ success: false, error: 'files array required' });
      return;
    }
    let written = 0;
    for (const f of files) {
      if (!f.name || !f.content) continue;
      const safeName = f.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      writeFileSync(join(MEMORY_DIR, safeName), f.content, 'utf-8');
      written++;
    }
    log.info({ written }, 'memory sync completed');
    res.json({ success: true, written });
  } catch (e: any) {
    log.error({ error: e.message }, 'memory sync failed');
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/memory/list — list all memory files
app.get('/api/memory/list', externalAuth, (_req, res) => {
  try {
    const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
    res.json({ success: true, files });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/memory/read/:name — read a specific memory file
app.get('/api/memory/read/:name', externalAuth, (req, res) => {
  try {
    const safeName = req.params.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const filePath = join(MEMORY_DIR, safeName);
    if (!fsExists(filePath)) {
      res.status(404).json({ success: false, error: 'not found' });
      return;
    }
    const content = readFileSync(filePath, 'utf-8');
    res.json({ success: true, name: safeName, content });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/memory/all — return all memory files as JSON (for system prompt injection)
app.get('/api/memory/all', externalAuth, (_req, res) => {
  try {
    const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith('.md'));
    const memories: Record<string, string> = {};
    for (const f of files) {
      memories[f] = readFileSync(join(MEMORY_DIR, f), 'utf-8');
    }
    res.json({ success: true, count: files.length, memories });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Accept both externalAuth (x-api-secret header) and dashAuth (token query param)
function combinedAuth(req: any, res: any, next: any) {
  // Try external auth first (x-api-secret header)
  const secret = req.headers['x-api-secret'];
  if (secret === config.localApiSecret) { next(); return; }
  // Fall back to dashboard auth (token query param)
  if (req.query.token === config.dashboardSecret) { next(); return; }
  res.status(401).json({ success: false, error: 'Unauthorized' });
}

app.post('/api/send-whatsapp', combinedAuth, async (req, res) => {
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
          VALUES (?, ?, 'voice_agent', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET
            name = COALESCE(excluded.name, leads.name),
            last_call_summary = COALESCE(excluded.last_call_summary, leads.last_call_summary),
            last_call_sentiment = COALESCE(excluded.last_call_sentiment, leads.last_call_sentiment),
            last_call_duration_sec = COALESCE(excluded.last_call_duration_sec, leads.last_call_duration_sec),
            was_booked = excluded.was_booked,
            call_mode = COALESCE(excluded.call_mode, leads.call_mode),
            lead_status = COALESCE(excluded.lead_status, leads.lead_status),
            monday_item_id = COALESCE(excluded.monday_item_id, leads.monday_item_id),
            updated_at = ?
        `).run(
          chatPhone, leadName || null, ctx.mondayItemId || null,
          ctx.callSummary || null, ctx.sentiment || null,
          ctx.callDurationSec || null, ctx.wasBooked ? 1 : 0,
          ctx.callMode || null, ctx.leadStatus || null,
          nowIsrael(), nowIsrael()
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
    // Log outbound WA message for flow tracking + 360Shmikley CRM visibility
    const logContent = template ? `[template:${template}] ${(templateParams || []).join(', ')}` : message;
    try {
      db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)`).run(chatPhone, logContent, nowIsrael());
    } catch (e) { log.warn({ err: (e as Error).message }, 'outbound WA message log failed'); }
    // WebSocket broadcast so CRM updates in real-time
    try {
      wsBroadcast({ type: 'new_message', phone: chatPhone, name: 'Bot', text: logContent.slice(0, 200), role: 'assistant', timestamp: new Date().toISOString() });
    } catch { /* non-critical */ }
    log.info({ phone, leadName, template: template || 'none' }, 'external WhatsApp sent');
    res.json({ success: true });
  } catch (e: any) {
    log.error({ err: e.message }, 'external WhatsApp send failed');
    res.json({ success: false, error: e.message });
  }
});

// ── A/B/C Price Tier Analytics ──
app.get('/api/tier-analytics', dashAuth, (_req, res) => {
  try {
    const tiers = db.prepare(`
      SELECT
        price_tier as tier,
        COUNT(*) as total_checkouts,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid,
        SUM(CASE WHEN status = 'paid' THEN price ELSE 0 END) as revenue,
        ROUND(100.0 * SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) as conversion_rate
      FROM orders
      WHERE price_tier IN ('A','B','C')
      GROUP BY price_tier
      ORDER BY price_tier
    `).all();

    const checkouts = db.prepare(`
      SELECT
        COALESCE(l.price_tier, '') as tier,
        COUNT(*) as visits,
        SUM(CASE WHEN cv.paid = 1 THEN 1 ELSE 0 END) as paid_visits
      FROM checkout_visits cv
      LEFT JOIN leads l ON l.phone = cv.phone
      WHERE l.price_tier IN ('A','B','C')
      GROUP BY l.price_tier
    `).all();

    res.json({ success: true, tiers, checkouts, priceTiers: PRICE_TIERS });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get lead's assigned tier (for checkout page)
app.get('/api/lead-tier/:phone', (req, res) => {
  try {
    const phone = req.params.phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const tier = getLeadTier(phone);
    const prices = getTierPrices(tier);
    res.json({ success: true, tier, prices });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Page Visit Tracking ──

// Collect visit data (time on site, scroll depth)
app.post('/api/track', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { phone, site, page, referrer, duration, scroll, ua } = req.body || {};
    if (!site) { res.json({ ok: true }); return; }
    const normPhone = phone ? phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '') : null;
    db.prepare(
      'INSERT INTO page_visits (phone, site, page, referrer, duration_sec, scroll_pct, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(normPhone, site, page || '/', referrer || null, Math.round(duration || 0), Math.round(scroll || 0), ua || null);
    if (normPhone && (duration || 0) > 30) bumpLeadScore(normPhone, 'clicked_link');
    res.json({ ok: true });
  } catch (e: any) {
    log.warn({ err: e.message }, 'track failed');
    res.json({ ok: true }); // never block the client
  }
});

// CORS preflight for track endpoint
app.options('/api/track', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// Visit analytics — time on site per site/lead
app.get('/api/visit-analytics', (req, res) => {
  if (!req.query.token || req.query.token !== config.dashboardSecret) {
    res.status(401).json({ error: 'Unauthorized — add ?token=YOUR_SECRET' });
    return;
  }
  try {
    const bySite = db.prepare(`
      SELECT site,
        COUNT(*) as visits,
        ROUND(AVG(duration_sec)) as avg_duration_sec,
        ROUND(AVG(scroll_pct)) as avg_scroll_pct,
        MAX(duration_sec) as max_duration_sec
      FROM page_visits
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY site ORDER BY visits DESC
    `).all();

    const topLeads = db.prepare(`
      SELECT phone, site,
        COUNT(*) as visits,
        SUM(duration_sec) as total_sec,
        ROUND(AVG(duration_sec)) as avg_sec,
        MAX(scroll_pct) as max_scroll
      FROM page_visits
      WHERE phone IS NOT NULL AND created_at >= datetime('now', '-30 days')
      GROUP BY phone, site ORDER BY total_sec DESC LIMIT 30
    `).all();

    const recent = db.prepare(`
      SELECT phone, site, page, duration_sec, scroll_pct, created_at
      FROM page_visits ORDER BY id DESC LIMIT 50
    `).all();

    res.json({ success: true, bySite, topLeads, recent });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Grow (Meshulam) Payment Integration ──

// Create a Grow payment page and return the URL
app.post('/api/create-payment', async (req, res) => {
  try {
    const { name, phone, email, plan, discount, tier: reqTier } = req.body || {};
    if (!name || !phone || !plan) {
      res.status(400).json({ success: false, error: 'Missing name, phone, or plan' });
      return;
    }

    // A/B/C price tier — from URL param or auto-assigned
    const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
    const tier = (reqTier && ['A', 'B', 'C'].includes(reqTier)) ? reqTier as 'A' | 'B' | 'C' : getLeadTier(normalizedPhone);
    const tierPrices = getTierPrices(tier);
    const planPrices = plan === 'premium' ? tierPrices.premium : tierPrices.basic;

    const labels: Record<string, string> = {
      basic: 'אתר בסיסי — Alon.dev',
      premium: 'אתר פרימיום — Alon.dev',
    };
    const amount = discount ? planPrices.discount : planPrices.regular;
    const pLabel = labels[plan] || labels.basic;
    log.info({ name, phone: normalizedPhone, plan, tier, amount, discount: !!discount }, 'checkout with price tier');

    // Track checkout visit for abandoned cart recovery
    try {
      db.prepare(`CREATE TABLE IF NOT EXISTS checkout_visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL, name TEXT, plan TEXT, amount INTEGER,
        paid INTEGER DEFAULT 0, reminded INTEGER DEFAULT 0,
        created_at TEXT
      )`).run();
      db.prepare('INSERT INTO checkout_visits (phone, name, plan, amount, created_at) VALUES (?, ?, ?, ?, ?)').run(normalizedPhone, name, plan, amount, nowIsrael());
      bumpLeadScore(normalizedPhone, 'checkout');
      log.info({ phone: normalizedPhone, plan, amount }, 'checkout visit tracked');
    } catch (e: any) { log.warn({ err: e.message }, 'checkout visit tracking failed'); }

    if (!config.growUserId || !config.growPageCode) {
      // Fallback: save order without real payment
      log.warn('Grow credentials not set — saving order as pending');
      saveOrder(name, phone, email, plan, amount, !!discount, 'pending_no_gateway', '', tier);
      res.json({ success: true, paymentUrl: null, fallback: true, message: 'Order saved — payment gateway not configured yet' });
      return;
    }

    // Create Grow payment page
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('pageCode', config.growPageCode);
    form.append('userId', config.growUserId);
    form.append('sum', amount.toString());
    form.append('description', pLabel);
    form.append('pageField[fullName]', name);
    form.append('pageField[phone]', phone.replace(/^\+/, ''));
    if (email) form.append('pageField[email]', email);
    form.append('successUrl', 'https://checkout-alondev-dh6yb4f2r-alonr-7280s-projects.vercel.app/?status=success');
    form.append('cancelUrl', 'https://checkout-alondev-dh6yb4f2r-alonr-7280s-projects.vercel.app/?status=cancelled');
    form.append('notifyUrl', 'https://alonbot.onrender.com/api/grow-webhook');
    form.append('cField1', plan);
    form.append('cField2', discount ? 'discount' : 'regular');

    const growRes = await fetch(`${config.growApiUrl}/createPaymentProcess`, {
      method: 'POST',
      body: form as any,
      headers: form.getHeaders(),
    });
    const growData = await growRes.json() as any;

    if (growData?.status === 1 && growData?.data?.url) {
      const paymentUrl = growData.data.url;
      log.info({ name, phone, plan, amount, paymentUrl }, 'Grow payment page created');
      saveOrder(name, phone, email, plan, amount, !!discount, 'payment_created', growData.data.processId || '', tier);
      res.json({ success: true, paymentUrl });
    } else {
      log.error({ growData }, 'Grow createPaymentProcess failed');
      saveOrder(name, phone, email, plan, amount, !!discount, 'grow_error', '', tier);
      res.json({ success: false, error: growData?.err?.message || 'Payment creation failed' });
    }
  } catch (e: any) {
    log.error({ err: e.message }, 'create-payment error');
    res.status(500).json({ success: false, error: e.message });
  }
});

// Grow webhook — called server-to-server when payment completes
app.post('/api/grow-webhook', (req, res) => {
  try {
    const data = req.body || {};
    const { customFields, asmachta, cardSuffix, sum, statusCode, transactionId, paymentProcessId } = data;
    const plan = customFields?.cField1 || 'basic';
    const isDiscount = customFields?.cField2 === 'discount';

    log.info({ transactionId, sum, statusCode, cardSuffix, plan }, '💳 Grow webhook received');

    if (statusCode === 1 || statusCode === '1') {
      // Payment successful!
      db.prepare(`UPDATE orders SET status = 'paid', card_last4 = ?, updated_at = ? WHERE grow_process_id = ?`)
        .run(cardSuffix || '', nowIsrael(), paymentProcessId || '');

      // Mark checkout_visits as paid (for abandoned cart recovery)
      try {
        const order = db.prepare(`SELECT phone FROM orders WHERE grow_process_id = ?`).get(paymentProcessId || '') as any;
        if (order?.phone) {
          db.prepare('UPDATE checkout_visits SET paid = 1 WHERE phone = ? AND paid = 0').run(order.phone);
        }
      } catch (e) { log.debug({ err: (e as Error).message }, 'checkout visit paid mark failed'); }

      // Find the order to get customer details
      const order = db.prepare(`SELECT * FROM orders WHERE grow_process_id = ? OR (status = 'payment_created' AND plan = ?)`)
        .get(paymentProcessId || '', plan) as any;

      if (order) {
        const normalizedPhone = order.phone;
        db.prepare(`UPDATE leads SET lead_status = 'paid', updated_at = ? WHERE phone = ?`).run(nowIsrael(), normalizedPhone);
        bumpLeadScore(normalizedPhone, 'paid');

        // Log payment in messages for dashboard
        const planLabel = plan === 'premium' ? 'פרימיום' : 'בסיסי';
        const payMsg = `💳 תשלום התקבל! ₪${sum}\nחבילה: ${planLabel}\nכרטיס: ****${cardSuffix || '????'}\nאסמכתא: ${asmachta || transactionId || ''}`;
        db.prepare(`INSERT INTO messages (channel, sender_id, sender_name, role, content, created_at)
          VALUES ('whatsapp-inbound', ?, ?, 'system', ?, ?)`)
          .run(normalizedPhone, order.name, payMsg, nowIsrael());

        // WhatsApp notifications
        (async () => {
          try {
            const { getAdapter } = await import('./router.js');
            const wa = getAdapter('whatsapp');
            if (wa) {
              const makeMsg = (senderId: string, senderName: string) => ({
                id: 'pay', channel: 'whatsapp' as const, senderId, senderName, text: '', timestamp: Date.now(), raw: { from: `${senderId}@s.whatsapp.net` },
              });

              // 1. Notify Alon
              await wa.sendReply(
                makeMsg('972546300783', 'אלון'),
                { text: `💳 תשלום חדש!\n\nשם: ${order.name}\nטלפון: ${order.phone}\nחבילה: ${planLabel}\nסכום: ₪${sum}\nכרטיס: ****${cardSuffix || '????'}\nאסמכתא: ${asmachta || ''}` }
              );

              // 2. Customer confirmation — immediate
              await wa.sendReply(
                makeMsg(normalizedPhone, order.name),
                { text: `${order.name}, התשלום התקבל בהצלחה! 🎉\n\nחבילה: ${planLabel}\nסכום: ₪${sum}\nאסמכתא: ${asmachta || transactionId || ''}\n\nתודה שבחרת ב-Alon.dev! ⭐` }
              );

              // 3. What happens next — after 3 seconds
              await new Promise(r => setTimeout(r, 3000));
              await wa.sendReply(
                makeMsg(normalizedPhone, order.name),
                { text: `אז מה קורה עכשיו? 👇\n\n🚀 *אנחנו משדרגים את האתר שלך!*\nהאתר שראית — זה הבסיס. עכשיו אנחנו מתאימים אותו בדיוק לעסק שלך.\n\n📋 *השלבים הבאים:*\n1️⃣ אלון יצור איתך קשר תוך כמה שעות\n2️⃣ שלח לנו פה: לוגו, תמונות אמיתיות של העסק, וטקסטים שרוצה לשנות\n3️⃣ אנחנו משדרגים — צבעים, תוכן, תמונות, דומיין\n4️⃣ תוך 24-48 שעות האתר המשודרג באוויר! 🔥\n\n💡 *כלול בחבילה:*\n${plan === 'premium'
                    ? '• שדרוג עיצוב + תוכן מותאם\n• קידום SEO\n• Google Business\n• תמיכה 24/7 ל-3 חודשים\n• כפתור WhatsApp חכם'
                    : '• שדרוג עיצוב + תוכן מותאם\n• דומיין לשנה\n• כפתור WhatsApp\n• אתר מהיר ומאובטח'}\n\nשאלות? פשוט שלח הודעה פה ואני כאן 💬` }
              );

              // 4. Upsell hint — after 30 seconds
              await new Promise(r => setTimeout(r, 27000));
              await wa.sendReply(
                makeMsg(normalizedPhone, order.name),
                { text: `💡 אגב ${order.name}, הרבה לקוחות שלנו משדרגים עם שירותים נוספים:\n\n🔍 קידום SEO — שיופיעו ראשונים בגוגל\n📣 קמפיינים ממומנים — לידים חמים ישירות לפלאפון\n💬 בוט WhatsApp חכם — עונה ללקוחות 24/7\n🤖 נציגה קולית AI — עונה לטלפון בשבילך\n\nרוצה לשמוע על החבילות? יש לנו מבצעי באנדל משתלמים 🔥` }
              );
            }
          } catch (e: any) { log.warn({ err: e.message }, 'payment WA notification failed'); }
        })();
      }
    } else {
      log.warn({ statusCode, transactionId }, 'Grow payment not successful');
    }

    res.json({ success: true });
  } catch (e: any) {
    log.error({ err: e.message }, 'grow-webhook error');
    res.status(500).json({ success: false, error: e.message });
  }
});

function saveOrder(name: string, phone: string, email: string | undefined, plan: string, price: number, discount: boolean, status: string, growProcessId?: string, priceTier?: string) {
  const normalizedPhone = phone.replace(/[\s\-\(\)]/g, '').replace(/^0/, '972').replace(/^\+/, '');
  db.prepare(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, email TEXT, plan TEXT, price INTEGER,
    discount INTEGER DEFAULT 0, card_last4 TEXT, status TEXT DEFAULT 'pending',
    grow_process_id TEXT DEFAULT '',
    review_requested INTEGER DEFAULT 0,
    referral_code TEXT DEFAULT '',
    price_tier TEXT DEFAULT '',
    created_at TEXT,
    updated_at TEXT
  )`).run();
  const now = nowIsrael();
  db.prepare(`INSERT INTO orders (name, phone, email, plan, price, discount, status, grow_process_id, price_tier, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, normalizedPhone, email || '', plan, price, discount ? 1 : 0, status, growProcessId || '', priceTier || '', now, now);
}

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
          ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, leads.name), updated_at = ?
        `).run(chatPhone, leadName, nowIsrael());
      } catch (e) { log.debug({ err: (e as Error).message, chatPhone }, 'voice lead register failed'); }
    }

    const voiceBuffer = Buffer.from(audio, 'base64');
    await wa.sendReply(
      { id: 'ext-voice', channel: 'whatsapp', senderId: chatPhone, senderName: leadName || '', text: '', timestamp: Date.now(), raw: { from: chatId } },
      { text: '', voice: voiceBuffer }
    );
    // Log outbound voice note for flow tracking
    try {
      db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)`).run(chatPhone, `[הודעה קולית — ${voiceBuffer.length} bytes]`, nowIsrael());
    } catch (e) { log.warn({ err: (e as Error).message }, 'voice outbound log DB write failed'); }
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
      } catch (e) { log.debug({ err: (e as Error).message }, 'lead name lookup failed'); return { ...row, name: null }; }
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

// ===== WebSocket Real-Time =====
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

const wsClients = new Set<WebSocket>();

wss.on('connection', (ws, req) => {
  // Validate token from query string
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (token !== config.dashboardSecret) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  wsClients.add(ws);
  log.info({ clients: wsClients.size }, 'WebSocket client connected');

  ws.on('close', () => {
    wsClients.delete(ws);
  });
  ws.on('error', () => {
    wsClients.delete(ws);
  });

  // Send heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(heartbeat);
    }
  }, 30000);
  ws.on('close', () => clearInterval(heartbeat));
});

// Broadcast event to all connected WebSocket clients
export function wsBroadcast(event: { type: string; [key: string]: any }) {
  const data = JSON.stringify(event);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

export function startServer() {
  httpServer.listen(config.port, () => {
    log.info({ port: config.port }, 'server started (HTTP + WebSocket)');
    log.info({ url: `http://localhost:${config.port}/chat?token=${config.dashboardSecret}` }, 'chat URL');
    log.info({ url: `http://localhost:${config.port}/dashboard?token=${config.dashboardSecret}` }, 'dashboard URL');
    if (config.mode === 'local') {
      log.info({ url: `http://localhost:${config.port}/api/tool` }, 'tool API URL');
    }
  });
}

