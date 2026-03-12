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
