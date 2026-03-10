import { Router } from 'express';
import { getConnectionStatus } from '../../whatsapp/qr.js';
import { getDb, checkDbHealth } from '../../db/index.js';

export const healthRouter = Router();

// Admin: clear conversation history for a phone number
healthRouter.post('/admin/clear-history/:phone', (req, res) => {
  const phone = req.params.phone;
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
