import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getConnectionStatus } from '../../whatsapp/qr.js';
import { getDb, checkDbHealth } from '../../db/index.js';
import { config } from '../../config.js';

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

// Migrate data from old alonbot.db to new bot.db (one-time operation)
healthRouter.post('/health/migrate-old-db', (req, res) => {
  const token = req.query.token as string;
  if (token !== process.env.API_SECRET) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const oldDbPath = join(config.dataDir, 'alonbot.db');
  if (!existsSync(oldDbPath)) {
    res.json({ success: false, error: 'alonbot.db not found at ' + oldDbPath });
    return;
  }

  try {
    const oldDb = new Database(oldDbPath, { readonly: true });
    const newDb = getDb();

    // Check old DB tables
    const oldTables = oldDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);

    let leadsImported = 0;
    let messagesImported = 0;

    // Import leads (skip duplicates by phone)
    if (oldTables.includes('leads')) {
      const oldLeads = oldDb.prepare('SELECT * FROM leads').all() as any[];
      const insertLead = newDb.prepare(`
        INSERT OR IGNORE INTO leads (phone, name, source, status, created_at, updated_at, monday_item_id, monday_board_id, interest, notes, score, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      for (const l of oldLeads) {
        const result = insertLead.run(
          l.phone, l.name, l.source || 'whatsapp', l.status || 'new',
          l.created_at, l.updated_at || l.created_at,
          l.monday_item_id || null, l.monday_board_id || null,
          l.interest || null, l.notes || null, l.score || 0
        );
        if (result.changes > 0) leadsImported++;
      }
    }

    // Import messages (skip duplicates by checking phone+content+created_at)
    if (oldTables.includes('messages')) {
      const oldMsgs = oldDb.prepare('SELECT * FROM messages').all() as any[];
      const insertMsg = newDb.prepare(`
        INSERT INTO messages (phone, direction, content, created_at, tenant_id)
        SELECT ?, ?, ?, ?, 1
        WHERE NOT EXISTS (
          SELECT 1 FROM messages WHERE phone = ? AND content = ? AND created_at = ?
        )
      `);
      for (const m of oldMsgs) {
        if (!m.phone || !m.content) continue; // skip incomplete records
        const ts = m.created_at || m.timestamp || new Date().toISOString();
        try {
          const result = insertMsg.run(
            m.phone, m.direction || 'in', m.content, ts,
            m.phone, m.content, ts
          );
          if (result.changes > 0) messagesImported++;
        } catch { /* skip problematic records */ }
      }
    }

    oldDb.close();
    res.json({ success: true, leadsImported, messagesImported, oldTables });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
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
