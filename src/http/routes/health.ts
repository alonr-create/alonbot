import { Router } from 'express';
import { getConnectionStatus } from '../../whatsapp/qr.js';
import { getDb, checkDbHealth } from '../../db/index.js';

export const healthRouter = Router();

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
