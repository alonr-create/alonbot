import { Router } from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConnectionStatus } from '../../whatsapp/qr.js';
import { getDb, checkDbHealth } from '../../db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8'));
const BOOT_TIME = new Date().toISOString();

export const healthRouter = Router();

// Admin: clear conversation history for a phone number
// Protected by simple token check (set ADMIN_TOKEN env var)
healthRouter.post('/admin/clear-history/:phone', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || token !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const phone = req.params.phone.replace(/[^0-9]/g, '');
  if (!phone) {
    res.status(400).json({ error: 'Invalid phone' });
    return;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM messages WHERE phone = ?').run(phone);
  res.json({ ok: true, deleted: result.changes, phone });
});

// Admin: purge stale leads (no messages in N days, not on Monday.com)
healthRouter.post('/admin/purge-stale-leads', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  const expected = process.env.ADMIN_TOKEN;
  if (!expected || token !== expected) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const daysInactive = parseInt(String(req.query.days || '30'), 10);
  const db = getDb();

  // Find leads with no messages in N days AND no monday_item_id
  const stale = db.prepare(`
    SELECT l.id, l.phone, l.name, l.status FROM leads l
    WHERE l.monday_item_id IS NULL
    AND l.updated_at < datetime('now', ? || ' days')
    AND NOT EXISTS (
      SELECT 1 FROM messages m WHERE m.phone = l.phone
      AND m.created_at >= datetime('now', ? || ' days')
    )
  `).all(`-${daysInactive}`, `-${daysInactive}`) as Array<{
    id: number; phone: string; name: string | null; status: string;
  }>;

  if (stale.length === 0) {
    res.json({ ok: true, purged: 0, message: 'No stale leads found' });
    return;
  }

  const purgeStmt = db.prepare('DELETE FROM leads WHERE id = ?');
  const purgeMessages = db.prepare('DELETE FROM messages WHERE phone = ?');
  const purgeFollowUps = db.prepare('DELETE FROM follow_ups WHERE phone = ?');

  let purged = 0;
  for (const lead of stale) {
    purgeMessages.run(lead.phone);
    purgeFollowUps.run(lead.phone);
    purgeStmt.run(lead.id);
    purged++;
  }

  res.json({
    ok: true,
    purged,
    leads: stale.map((l) => `${l.name || l.phone} (${l.status})`),
  });
});

healthRouter.get('/health/env-check', (req, res) => {
  const token = req.query.token as string;
  if (token !== process.env.API_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const check = (k: string) => ({ set: !!process.env[k], len: (process.env[k] || '').length });
  res.json({
    WA_CLOUD_TOKEN: check('WA_CLOUD_TOKEN'),
    WA_CLOUD_PHONE_ID: check('WA_CLOUD_PHONE_ID'),
    API_SECRET: check('API_SECRET'),
    ANTHROPIC_API_KEY: check('ANTHROPIC_API_KEY'),
    DATA_DIR: { set: !!process.env.DATA_DIR, value: process.env.DATA_DIR || '(not set)' },
    SKIP_WWEBJS: { set: !!process.env.SKIP_WWEBJS, value: process.env.SKIP_WWEBJS || '(not set)' },
    ALON_PHONE: check('ALON_PHONE'),
  });
});

healthRouter.get('/health', (_req, res) => {
  const db = getDb();
  const waStatus = getConnectionStatus();
  const waConnected = waStatus === 'connected';
  const dbHealthy = checkDbHealth(db);

  let activeLeadsCount = 0;
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) as count FROM leads WHERE status NOT IN ('closed-won','closed-lost')"
      )
      .get() as { count: number } | undefined;
    activeLeadsCount = row?.count ?? 0;
  } catch {
    // DB may not have leads table yet during early startup
    activeLeadsCount = 0;
  }

  res.json({
    status: waConnected && dbHealthy ? 'ok' : 'degraded',
    version: pkg.version,
    deployedAt: BOOT_TIME,
    whatsapp: {
      connected: waConnected,
      status: waStatus,
    },
    database: {
      healthy: dbHealthy,
    },
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeLeads: activeLeadsCount,
    timestamp: new Date().toISOString(),
  });
});
