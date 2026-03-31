import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../../db/index.js';
import { getTenants, getTenantById } from '../../db/tenants.js';
import { sendCloudMessage } from '../../whatsapp/cloud-api.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('wa-inbox');

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────

function requireToken(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.API_SECRET;
  const token = req.query.token as string;
  if (!secret || token !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export const waInboxRouter = Router();

// Apply auth middleware to all routes
waInboxRouter.use(requireToken);

// ── GET /wa-inbox/api/tenants ─────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/tenants', (_req: Request, res: Response): void => {
  try {
    const tenants = getTenants();
    const result = tenants.map((t) => ({
      id: t.id,
      name: t.name,
      business_name: t.business_name,
    }));
    // Add personal admin tab
    result.push({ id: -1, name: 'admin', business_name: 'אלון (אישי)' });
    res.json(result);
  } catch (err: any) {
    log.error({ err }, 'GET /wa-inbox/api/tenants: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /wa-inbox/api/conversations ─────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/conversations', (req: Request, res: Response): void => {
  const tenantIdRaw = req.query.tenant_id as string | undefined;

  if (!tenantIdRaw) {
    res.status(400).json({ error: 'tenant_id is required' });
    return;
  }

  const tenantId = parseInt(tenantIdRaw, 10);
  if (isNaN(tenantId)) {
    res.status(400).json({ error: 'tenant_id must be a number' });
    return;
  }

  try {
    const db = getDb();

    // Admin tab (tenant_id=-1): show admin phone conversations from messages table directly
    if (tenantId === -1) {
      const adminPhone = process.env.ALON_PHONE || '';
      if (!adminPhone) {
        res.json([]);
        return;
      }
      const msgCount = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE phone = ?').get(adminPhone) as any;
      const lastMsg = db.prepare('SELECT content, created_at FROM messages WHERE phone = ? ORDER BY id DESC LIMIT 1').get(adminPhone) as any;
      if (msgCount?.cnt > 0) {
        res.json([{
          phone: adminPhone,
          name: 'אלון (בוס)',
          status: 'admin',
          interest: null,
          updated_at: lastMsg?.created_at,
          last_msg: lastMsg?.content,
          last_msg_at: lastMsg?.created_at,
        }]);
      } else {
        res.json([]);
      }
      return;
    }

    const rows = db.prepare(`
      SELECT
        l.phone,
        l.name,
        l.status,
        l.interest,
        l.updated_at,
        (SELECT content FROM messages WHERE phone = l.phone ORDER BY id DESC LIMIT 1) as last_msg,
        (SELECT created_at FROM messages WHERE phone = l.phone ORDER BY id DESC LIMIT 1) as last_msg_at
      FROM leads l
      WHERE l.tenant_id = ?
      ORDER BY l.updated_at DESC
      LIMIT 100
    `).all(tenantId);
    res.json(rows);
  } catch (err: any) {
    log.error({ err, tenantId }, 'GET /wa-inbox/api/conversations: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /wa-inbox/api/messages ───────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/messages', (req: Request, res: Response): void => {
  const phone = req.query.phone as string | undefined;

  if (!phone) {
    res.status(400).json({ error: 'phone is required' });
    return;
  }

  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT direction, content, created_at FROM messages
      WHERE phone = ?
      ORDER BY created_at ASC
      LIMIT 200
    `).all(phone);
    res.json(rows);
  } catch (err: any) {
    log.error({ err, phone }, 'GET /wa-inbox/api/messages: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /wa-inbox/api/reply ─────────────────────────────────────────────────

waInboxRouter.post('/wa-inbox/api/reply', async (req: Request, res: Response): Promise<void> => {
  const { phone, message, tenant_id } = req.body as {
    phone?: string;
    message?: string;
    tenant_id?: number;
  };

  if (!phone || !message || tenant_id === undefined) {
    res.status(400).json({ error: 'phone, message, and tenant_id are required' });
    return;
  }

  const tenant = getTenantById(Number(tenant_id));
  if (!tenant) {
    res.status(400).json({ error: 'Invalid tenant_id' });
    return;
  }

  try {
    const result = await sendCloudMessage({
      to: phone,
      message,
      phoneNumberId: tenant.wa_phone_number_id,
    });

    if (result.success) {
      // Store outgoing message in DB
      try {
        const db = getDb();
        db.prepare(
          'INSERT INTO messages (phone, direction, content, tenant_id) VALUES (?, ?, ?, ?)'
        ).run(phone, 'out', message, tenant.id);
      } catch (dbErr: any) {
        log.warn({ dbErr }, 'POST /wa-inbox/api/reply: failed to store message in DB');
      }
      res.json({ success: true });
    } else {
      log.warn({ phone, tenantId: tenant.id, error: result.error }, 'POST /wa-inbox/api/reply: sendCloudMessage failed');
      res.json({ success: false, error: result.error });
    }
  } catch (err: any) {
    log.error({ err, phone }, 'POST /wa-inbox/api/reply: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});
