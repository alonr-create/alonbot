import { Router, Request, Response, NextFunction } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../../db/index.js';
import { getTenants, getTenantById } from '../../db/tenants.js';
import { sendCloudMessage } from '../../whatsapp/cloud-api.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('wa-inbox');

// Cache HTML at startup — resolve from project root (works from both src/ and dist/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const srcViewsPath = join(__dirname, '../../../src/views/wa-inbox.html');
const distViewsPath = join(__dirname, '../../views/wa-inbox.html');
const htmlPath = existsSync(srcViewsPath) ? srcViewsPath : distViewsPath;
const waInboxHTML = readFileSync(htmlPath, 'utf-8');

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────

function requireToken(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.API_SECRET || process.env.DASHBOARD_SECRET;
  const token = (req.query.token as string) || (req.headers.authorization?.replace('Bearer ', ''));
  if (!secret || token !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Helper: extract tenant_id from query or body
function getTenantId(req: Request): number | null {
  const raw = req.query.tenant_id as string ?? req.body?.tenant_id;
  if (raw === undefined || raw === null) return null;
  const id = parseInt(String(raw), 10);
  return isNaN(id) ? null : id;
}

// Israel-local time (UTC+2/+3)
function nowIsrael(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace('T', ' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export const waInboxRouter = Router();

// ── Serve HTML page ──────────────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox', (req: Request, res: Response): void => {
  const secret = process.env.API_SECRET || process.env.DASHBOARD_SECRET;
  const token = req.query.token as string;
  if (!secret || token !== secret) {
    res.status(401).send('Unauthorized');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(waInboxHTML);
});

// Apply auth middleware to all API routes
waInboxRouter.use('/wa-inbox/api', requireToken);

// ── GET /wa-inbox/api/config ──────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/config', (_req: Request, res: Response): void => {
  res.json({ admin_phone: process.env.ALON_PHONE || '31495095873775' });
});

// ── GET /wa-inbox/api/tenants ─────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/tenants', (_req: Request, res: Response): void => {
  try {
    const tenants = getTenants();
    const result = tenants.map((t) => ({
      id: t.id,
      name: t.name,
      business_name: t.business_name,
    }));
    res.json(result);
  } catch (err: any) {
    log.error({ err }, 'GET /tenants: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /wa-inbox/api/leads ─────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/leads', (req: Request, res: Response): void => {
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    let rows;
    const leadsQuery = `
      SELECT
        l.phone, l.name, l.status, l.interest, l.source, l.score,
        l.updated_at,
        lm.content as last_message,
        lm.created_at as last_message_at,
        lm.direction as last_message_role,
        mc.message_count
      FROM leads l
      LEFT JOIN (
        SELECT m.phone, m.content, m.created_at, m.direction
        FROM messages m
        INNER JOIN (
          SELECT phone, MAX(id) as max_id FROM messages GROUP BY phone
        ) latest ON m.phone = latest.phone AND m.id = latest.max_id
      ) lm ON lm.phone = l.phone
      LEFT JOIN (
        SELECT phone, COUNT(*) as message_count FROM messages GROUP BY phone
      ) mc ON mc.phone = l.phone
    `;
    if (tenantId !== null) {
      rows = db.prepare(`${leadsQuery} WHERE l.tenant_id = ? ORDER BY COALESCE(lm.created_at, l.updated_at) DESC LIMIT 1000`).all(tenantId);
    } else {
      rows = db.prepare(`${leadsQuery} ORDER BY COALESCE(lm.created_at, l.updated_at) DESC LIMIT 1000`).all();
    }
    // Map role: 'out' → 'assistant' for frontend compatibility
    const leads = (rows as any[]).map(r => ({
      ...r,
      last_message_role: r.last_message_role === 'out' ? 'assistant' : r.last_message_role,
      is_outgoing: r.last_message_role === 'out',
    }));
    res.json({ leads });
  } catch (err: any) {
    log.error({ err }, 'GET /leads: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /wa-inbox/api/conversations/:phone ──────────────────────────────────

waInboxRouter.get('/wa-inbox/api/conversations/:phone', (req: Request, res: Response): void => {
  const phone = req.params.phone;
  const since = req.query.since as string | undefined;
  try {
    const db = getDb();
    const rows = since
      ? db.prepare(`
          SELECT direction, content as body, created_at as timestamp FROM messages
          WHERE phone = ? AND created_at > ?
          ORDER BY created_at ASC
        `).all(phone, since)
      : db.prepare(`
          SELECT direction, content as body, created_at as timestamp FROM messages
          WHERE phone = ?
          ORDER BY created_at ASC
        `).all(phone);
    // Map direction to frontend format
    const messages = (rows as any[]).map(r => ({
      ...r,
      fromMe: r.direction === 'out',
      direction: r.direction === 'out' ? 'outgoing' : 'incoming',
    }));
    res.json({ messages });
  } catch (err: any) {
    log.error({ err, phone }, 'GET /conversations: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /wa-inbox/api/send ─────────────────────────────────────────────────

waInboxRouter.post('/wa-inbox/api/send', async (req: Request, res: Response): Promise<void> => {
  const { phone, message, tenant_id } = req.body;
  if (!phone || !message) {
    res.status(400).json({ error: 'phone and message required' });
    return;
  }

  const tId = tenant_id ?? getTenantId(req);
  const tenant = tId ? getTenantById(tId) : null;

  try {
    const result = await sendCloudMessage({
      to: phone,
      message,
      phoneNumberId: tenant?.wa_phone_number_id,
      token: tenant?.wa_cloud_token ?? undefined,
    });

    if (result.success) {
      try {
        const db = getDb();
        db.prepare(
          'INSERT INTO messages (phone, direction, content, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(phone, 'out', message, tenant?.id ?? tId, nowIsrael());
        // Update lead's updated_at
        db.prepare('UPDATE leads SET updated_at = ? WHERE phone = ?').run(nowIsrael(), phone);
      } catch (dbErr: any) {
        log.warn({ dbErr }, 'send: failed to store message');
      }
      res.json({ success: true });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (err: any) {
    log.error({ err, phone }, 'POST /send: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /wa-inbox/api/send-media ───────────────────────────────────────────

waInboxRouter.post('/wa-inbox/api/send-media', async (req: Request, res: Response): Promise<void> => {
  const { phone, caption, mediaBase64, mimeType, filename } = req.body;
  if (!phone || !mediaBase64) {
    res.status(400).json({ error: 'phone and mediaBase64 required' });
    return;
  }

  const tId = getTenantId(req);
  const tenant = tId ? getTenantById(tId) : null;
  const token = tenant?.wa_cloud_token ?? process.env.WA_CLOUD_TOKEN;
  const pid = tenant?.wa_phone_number_id ?? process.env.WA_CLOUD_PHONE_ID;

  if (!token || !pid) {
    res.status(500).json({ error: 'WA Cloud not configured' });
    return;
  }

  try {
    // Upload media to Meta
    const isImage = (mimeType || '').startsWith('image/');
    const buffer = Buffer.from(mediaBase64, 'base64');

    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('file', new Blob([buffer], { type: mimeType }), filename || 'file');

    const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${pid}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const uploadData = await uploadRes.json() as any;

    if (!uploadData.id) {
      res.json({ success: false, error: uploadData.error?.message || 'Upload failed' });
      return;
    }

    // Send the media message
    const msgBody: any = {
      messaging_product: 'whatsapp',
      to: phone.startsWith('972') ? phone : '972' + phone.replace(/^0/, ''),
      type: isImage ? 'image' : 'document',
    };
    if (isImage) {
      msgBody.image = { id: uploadData.id, caption: caption || undefined };
    } else {
      msgBody.document = { id: uploadData.id, caption: caption || undefined, filename };
    }

    const sendRes = await fetch(`https://graph.facebook.com/v21.0/${pid}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(msgBody),
    });
    const sendData = await sendRes.json() as any;

    if (sendData.messages?.[0]?.id) {
      // Store in DB
      try {
        const db = getDb();
        const label = isImage ? '[תמונה]' : `[קובץ: ${filename}]`;
        const content = caption ? `${label} ${caption}` : label;
        db.prepare('INSERT INTO messages (phone, direction, content, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(phone, 'out', content, tenant?.id ?? tId, nowIsrael());
      } catch {}
      res.json({ success: true });
    } else {
      res.json({ success: false, error: sendData.error?.message || 'Send failed' });
    }
  } catch (err: any) {
    log.error({ err, phone }, 'POST /send-media: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /wa-inbox/api/reply (legacy compat) ────────────────────────────────

waInboxRouter.post('/wa-inbox/api/reply', async (req: Request, res: Response): Promise<void> => {
  // Delegate to /send
  req.body.tenant_id = req.body.tenant_id ?? getTenantId(req);
  const handler = waInboxRouter.stack.find((s: any) => s.route?.path === '/wa-inbox/api/send' && s.route?.methods?.post);
  // Just forward
  const { phone, message, tenant_id } = req.body;
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
      try {
        const db = getDb();
        db.prepare('INSERT INTO messages (phone, direction, content, tenant_id) VALUES (?, ?, ?, ?)')
          .run(phone, 'out', message, tenant.id);
      } catch {}
      res.json({ success: true });
    } else {
      res.json({ success: false, error: result.error });
    }
  } catch (err: any) {
    log.error({ err, phone }, 'POST /reply: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /wa-inbox/api/quick-replies ─────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/quick-replies', (req: Request, res: Response): void => {
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    const rows = tenantId !== null
      ? db.prepare('SELECT * FROM quick_replies WHERE tenant_id = ? ORDER BY id').all(tenantId)
      : db.prepare('SELECT * FROM quick_replies ORDER BY id').all();
    res.json({ replies: rows });
  } catch (err: any) {
    log.error({ err }, 'GET /quick-replies: error');
    res.json({ replies: [] });
  }
});

waInboxRouter.post('/wa-inbox/api/quick-replies', (req: Request, res: Response): void => {
  const { name, message } = req.body;
  const tenantId = getTenantId(req);
  if (!name || !message) { res.status(400).json({ error: 'name and message required' }); return; }
  try {
    const db = getDb();
    const info = db.prepare('INSERT INTO quick_replies (name, message, tenant_id) VALUES (?, ?, ?)').run(name, message, tenantId);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err: any) {
    log.error({ err }, 'POST /quick-replies: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

waInboxRouter.delete('/wa-inbox/api/quick-replies/:id', (req: Request, res: Response): void => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM quick_replies WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Tags CRUD ───────────────────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/tags/:phone', (req: Request, res: Response): void => {
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    const rows = tenantId !== null
      ? db.prepare('SELECT tag, created_at FROM lead_tags WHERE phone = ? AND tenant_id = ?').all(req.params.phone, tenantId)
      : db.prepare('SELECT tag, created_at FROM lead_tags WHERE phone = ?').all(req.params.phone);
    res.json({ tags: rows });
  } catch (err: any) {
    res.json({ tags: [] });
  }
});

waInboxRouter.post('/wa-inbox/api/tags/:phone', (req: Request, res: Response): void => {
  const { tag } = req.body;
  const tenantId = getTenantId(req);
  if (!tag) { res.status(400).json({ error: 'tag required' }); return; }
  try {
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO lead_tags (phone, tag, tenant_id) VALUES (?, ?, ?)').run(req.params.phone, tag, tenantId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

waInboxRouter.delete('/wa-inbox/api/tags/:phone/:tag', (req: Request, res: Response): void => {
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    if (tenantId !== null) {
      db.prepare('DELETE FROM lead_tags WHERE phone = ? AND tag = ? AND tenant_id = ?').run(req.params.phone, req.params.tag, tenantId);
    } else {
      db.prepare('DELETE FROM lead_tags WHERE phone = ? AND tag = ?').run(req.params.phone, req.params.tag);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Notes CRUD ──────────────────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/notes/:phone', (req: Request, res: Response): void => {
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    const rows = tenantId !== null
      ? db.prepare('SELECT id, note, created_at FROM lead_notes WHERE phone = ? AND tenant_id = ? ORDER BY id DESC').all(req.params.phone, tenantId)
      : db.prepare('SELECT id, note, created_at FROM lead_notes WHERE phone = ? ORDER BY id DESC').all(req.params.phone);
    res.json({ notes: rows });
  } catch (err: any) {
    res.json({ notes: [] });
  }
});

waInboxRouter.post('/wa-inbox/api/notes/:phone', (req: Request, res: Response): void => {
  const { note } = req.body;
  const tenantId = getTenantId(req);
  if (!note) { res.status(400).json({ error: 'note required' }); return; }
  try {
    const db = getDb();
    const info = db.prepare('INSERT INTO lead_notes (phone, note, tenant_id) VALUES (?, ?, ?)').run(req.params.phone, note, tenantId);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

waInboxRouter.delete('/wa-inbox/api/notes/:id', (req: Request, res: Response): void => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM lead_notes WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Status History ──────────────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/status-history/:phone', (req: Request, res: Response): void => {
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    const rows = tenantId !== null
      ? db.prepare('SELECT status, created_at FROM status_history WHERE phone = ? AND tenant_id = ? ORDER BY id DESC LIMIT 20').all(req.params.phone, tenantId)
      : db.prepare('SELECT status, created_at FROM status_history WHERE phone = ? ORDER BY id DESC LIMIT 20').all(req.params.phone);
    res.json({ history: rows });
  } catch (err: any) {
    res.json({ history: [] });
  }
});

// ── PATCH /wa-inbox/api/leads/:phone ────────────────────────────────────────

waInboxRouter.patch('/wa-inbox/api/leads/:phone', (req: Request, res: Response): void => {
  const { lead_status } = req.body;
  const phone = req.params.phone;
  const tenantId = getTenantId(req);
  if (!lead_status) { res.status(400).json({ error: 'lead_status required' }); return; }
  try {
    const db = getDb();
    db.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE phone = ?').run(lead_status, nowIsrael(), phone);
    // Record status history
    db.prepare('INSERT INTO status_history (phone, status, tenant_id) VALUES (?, ?, ?)').run(phone, lead_status, tenantId);
    res.json({ success: true });
  } catch (err: any) {
    log.error({ err, phone }, 'PATCH /leads: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /wa-inbox/api/profile-pics-batch ───────────────────────────────────

waInboxRouter.post('/wa-inbox/api/profile-pics-batch', (_req: Request, res: Response): void => {
  // Profile pics require WhatsApp Web.js — not available in Cloud API mode
  // Return empty results gracefully
  res.json({ success: true, results: {} });
});

// ── GET /wa-inbox/api/stats ─────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/stats', (req: Request, res: Response): void => {
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const tenantFilter = tenantId !== null ? ' AND tenant_id = ?' : '';
    const params = tenantId !== null ? [tenantId] : [];

    const totalLeads = (db.prepare(`SELECT COUNT(*) as cnt FROM leads WHERE 1=1${tenantFilter}`).get(...params) as any)?.cnt ?? 0;
    const messagesToday = (db.prepare(`SELECT COUNT(*) as cnt FROM messages WHERE created_at >= ?${tenantFilter}`).get(today, ...params) as any)?.cnt ?? 0;
    const bookedCount = (db.prepare(`SELECT COUNT(*) as cnt FROM leads WHERE status = 'meeting-scheduled'${tenantFilter}`).get(...params) as any)?.cnt ?? 0;

    // Messages per day (last 14 days)
    const messagesPerDay = db.prepare(`
      SELECT DATE(created_at) as day, COUNT(*) as count
      FROM messages WHERE created_at >= DATE('now', '-14 days')${tenantFilter}
      GROUP BY DATE(created_at) ORDER BY day
    `).all(...params);

    // Leads per day (last 14 days)
    const leadsPerDay = db.prepare(`
      SELECT DATE(created_at) as day, COUNT(*) as count
      FROM leads WHERE created_at >= DATE('now', '-14 days')${tenantFilter}
      GROUP BY DATE(created_at) ORDER BY day
    `).all(...params);

    // Status breakdown
    const statusBreakdown = db.prepare(`
      SELECT status as lead_status, COUNT(*) as count FROM leads WHERE 1=1${tenantFilter}
      GROUP BY status ORDER BY count DESC
    `).all(...params);

    // Source breakdown
    const sourceBreakdown = db.prepare(`
      SELECT source, COUNT(*) as count FROM leads WHERE 1=1${tenantFilter}
      GROUP BY source ORDER BY count DESC
    `).all(...params);

    res.json({ totalLeads, messagesToday, bookedCount, messagesPerDay, leadsPerDay, statusBreakdown, sourceBreakdown });
  } catch (err: any) {
    log.error({ err }, 'GET /stats: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /wa-inbox/api/meta-health ───────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/meta-health', async (req: Request, res: Response): Promise<void> => {
  const tenantId = getTenantId(req);
  const tenant = tenantId ? getTenantById(tenantId) : null;
  const token = tenant?.wa_cloud_token ?? process.env.WA_CLOUD_TOKEN;
  const pid = tenant?.wa_phone_number_id ?? process.env.WA_CLOUD_PHONE_ID;

  if (!token || !pid) {
    res.json({ success: false, error: 'WA Cloud not configured' });
    return;
  }

  try {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${pid}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json() as any;
    if (data.error) {
      res.json({ success: false, error: data.error.message });
    } else {
      res.json({ success: true, phone: data });
    }
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// ── POST /wa-inbox/api/broadcast ────────────────────────────────────────────

waInboxRouter.post('/wa-inbox/api/broadcast', async (req: Request, res: Response): Promise<void> => {
  const { phones, message } = req.body;
  const tenantId = getTenantId(req);
  const tenant = tenantId ? getTenantById(tenantId) : null;

  if (!phones?.length || !message) {
    res.status(400).json({ error: 'phones and message required' });
    return;
  }

  const results = [];
  for (const phone of phones) {
    try {
      const result = await sendCloudMessage({
        to: phone,
        message,
        phoneNumberId: tenant?.wa_phone_number_id,
        token: tenant?.wa_cloud_token ?? undefined,
      });
      results.push({ phone, success: result.success, error: result.error });
      if (result.success) {
        try {
          const db = getDb();
          db.prepare('INSERT INTO messages (phone, direction, content, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(phone, 'out', message, tenant?.id ?? tenantId, nowIsrael());
        } catch {}
      }
      // Rate limit: 50ms between sends
      await new Promise(r => setTimeout(r, 50));
    } catch (err: any) {
      results.push({ phone, success: false, error: err.message });
    }
  }
  res.json({ results });
});

// ── Templates CRUD ──────────────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/templates', async (req: Request, res: Response): Promise<void> => {
  const tenantId = getTenantId(req);
  const tenant = tenantId ? getTenantById(tenantId) : null;
  const token = tenant?.wa_cloud_token ?? process.env.WA_CLOUD_TOKEN;
  const wabaId = process.env.WABA_ID;

  if (!token || !wabaId) {
    res.json({ templates: [], error: 'WABA not configured' });
    return;
  }

  try {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/message_templates?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json() as any;
    if (data.error) {
      res.json({ templates: [], error: data.error });
    } else {
      res.json({ templates: data.data || [] });
    }
  } catch (err: any) {
    res.json({ templates: [], error: err.message });
  }
});

waInboxRouter.post('/wa-inbox/api/send-template', async (req: Request, res: Response): Promise<void> => {
  const { phone, templateName, language, templateBody } = req.body;
  const tenantId = getTenantId(req);
  const tenant = tenantId ? getTenantById(tenantId) : null;
  const token = tenant?.wa_cloud_token ?? process.env.WA_CLOUD_TOKEN;
  const pid = tenant?.wa_phone_number_id ?? process.env.WA_CLOUD_PHONE_ID;

  if (!phone || !templateName) {
    res.status(400).json({ error: 'phone and templateName required' });
    return;
  }

  try {
    const to = phone.startsWith('972') ? phone : '972' + phone.replace(/^0/, '');
    const resp = await fetch(`https://graph.facebook.com/v21.0/${pid}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: templateName, language: { code: language || 'he' } },
      }),
    });
    const data = await resp.json() as any;
    if (data.messages?.[0]?.id) {
      try {
        const db = getDb();
        const content = templateBody || `[template:${templateName}]`;
        db.prepare('INSERT INTO messages (phone, direction, content, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(phone, 'out', content, tenant?.id ?? tenantId, nowIsrael());
      } catch {}
      res.json({ success: true, messageId: data.messages[0].id });
    } else {
      res.json({ success: false, error: data.error?.message, data });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

waInboxRouter.post('/wa-inbox/api/create-template', async (req: Request, res: Response): Promise<void> => {
  const { name, category, language, components } = req.body;
  const token = process.env.WA_CLOUD_TOKEN;
  const wabaId = process.env.WABA_ID;

  if (!name || !components) {
    res.status(400).json({ error: 'name and components required' });
    return;
  }

  try {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/message_templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        category: category || 'MARKETING',
        language: language || 'he',
        components,
      }),
    });
    const data = await resp.json() as any;
    if (data.id) {
      res.json({ success: true, id: data.id });
    } else {
      res.json({ success: false, error: data.error, data });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Costs / API Usage ───────────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/costs', (req: Request, res: Response): void => {
  const rawDays = parseInt(req.query.days as string);
  const days = (!isNaN(rawDays) && rawDays >= 1 && rawDays <= 365) ? rawDays : 30;
  const daysParam = `-${days} days`;
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    const tenantFilter = tenantId !== null ? ' AND tenant_id = ?' : '';
    const params = tenantId !== null ? [tenantId] : [];
    const today = new Date().toISOString().slice(0, 10);

    // Claude costs today
    const todayUsage = db.prepare(`
      SELECT model, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cost_usd) as cost_usd, COUNT(*) as calls
      FROM api_usage WHERE DATE(created_at) = ?${tenantFilter}
      GROUP BY model
    `).all(today, ...params);

    // Total costs
    const totals = db.prepare(`
      SELECT SUM(cost_usd) as total_cost, COUNT(*) as total_calls
      FROM api_usage WHERE created_at >= DATE('now', ?)${tenantFilter}
    `).get(daysParam, ...params) as any;

    // Daily breakdown
    const daily = db.prepare(`
      SELECT DATE(created_at) as day, model,
             SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
             SUM(cost_usd) as cost_usd, COUNT(*) as calls
      FROM api_usage WHERE created_at >= DATE('now', ?)${tenantFilter}
      GROUP BY DATE(created_at), model ORDER BY day DESC
    `).all(daysParam, ...params);

    // WA message counts for cost estimation
    const waToday = db.prepare(`
      SELECT COUNT(DISTINCT phone) as conversations,
             SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) as outgoing_msgs
      FROM messages WHERE DATE(created_at) = ?${tenantFilter}
    `).get(today, ...params) as any;

    const waDaily = db.prepare(`
      SELECT DATE(created_at) as day,
             COUNT(DISTINCT phone) as conversations,
             SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) as incoming_msgs,
             SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) as outgoing_msgs
      FROM messages WHERE created_at >= DATE('now', ?)${tenantFilter}
      GROUP BY DATE(created_at) ORDER BY day DESC
    `).all(daysParam, ...params);

    res.json({ today: todayUsage, totals: totals || {}, daily, waToday: waToday || {}, waDaily });
  } catch (err: any) {
    log.error({ err }, 'GET /costs: error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Chatbot Flows CRUD ──────────────────────────────────────────────────────

waInboxRouter.get('/wa-inbox/api/flows', (req: Request, res: Response): void => {
  const tenantId = getTenantId(req);
  try {
    const db = getDb();
    const rows = tenantId !== null
      ? db.prepare('SELECT * FROM chatbot_flows WHERE tenant_id = ? ORDER BY id').all(tenantId)
      : db.prepare('SELECT * FROM chatbot_flows ORDER BY id').all();
    res.json({ success: true, flows: rows });
  } catch (err: any) {
    res.json({ success: false, flows: [] });
  }
});

waInboxRouter.post('/wa-inbox/api/flows', (req: Request, res: Response): void => {
  const { name, trigger_type, trigger_value, steps } = req.body;
  const tenantId = getTenantId(req);
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const db = getDb();
    const info = db.prepare(
      'INSERT INTO chatbot_flows (name, trigger_type, trigger_value, steps, tenant_id) VALUES (?, ?, ?, ?, ?)'
    ).run(name, trigger_type || 'keyword', trigger_value || '*', steps || '[]', tenantId);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

waInboxRouter.patch('/wa-inbox/api/flows/:id', (req: Request, res: Response): void => {
  const id = req.params.id;
  const updates = req.body;
  try {
    const db = getDb();
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (['name', 'trigger_type', 'trigger_value', 'steps', 'enabled'].includes(key)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }
    if (!fields.length) { res.json({ success: true }); return; }
    values.push(id);
    db.prepare(`UPDATE chatbot_flows SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

waInboxRouter.delete('/wa-inbox/api/flows/:id', (req: Request, res: Response): void => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM chatbot_flows WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Backward-compatible routes (old API paths used by tests) ────────────────

// Old: GET /wa-inbox/api/conversations?tenant_id=X → leads list
waInboxRouter.get('/wa-inbox/api/conversations', (req: Request, res: Response): void => {
  const tenantIdRaw = req.query.tenant_id as string | undefined;
  if (!tenantIdRaw) { res.status(400).json({ error: 'tenant_id is required' }); return; }
  const tenantId = parseInt(tenantIdRaw, 10);
  if (isNaN(tenantId)) { res.status(400).json({ error: 'tenant_id must be a number' }); return; }
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT l.phone, l.name, l.status, l.interest, l.updated_at,
        (SELECT content FROM messages WHERE phone = l.phone ORDER BY id DESC LIMIT 1) as last_msg,
        (SELECT created_at FROM messages WHERE phone = l.phone ORDER BY id DESC LIMIT 1) as last_msg_at
      FROM leads l WHERE l.tenant_id = ? ORDER BY l.updated_at DESC LIMIT 100
    `).all(tenantId);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Old: GET /wa-inbox/api/messages?phone=X → messages for a phone
waInboxRouter.get('/wa-inbox/api/messages', (req: Request, res: Response): void => {
  const phone = req.query.phone as string | undefined;
  if (!phone) { res.status(400).json({ error: 'phone is required' }); return; }
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT direction, content, created_at FROM messages
      WHERE phone = ? ORDER BY created_at ASC LIMIT 200
    `).all(phone);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /wa-inbox/api/bulk-import — import leads + messages from another instance ──

waInboxRouter.post('/wa-inbox/api/bulk-import', (req: Request, res: Response): void => {
  const { leads, messages } = req.body;
  if (!leads && !messages) {
    res.status(400).json({ error: 'leads or messages required' });
    return;
  }

  try {
    const db = getDb();
    let importedLeads = 0;
    let importedMessages = 0;

    if (leads?.length) {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO leads (phone, name, source, status, interest, tenant_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of leads) {
        const result = stmt.run(l.phone, l.name, l.source, l.status, l.interest || '', l.tenant_id, l.created_at, l.updated_at);
        if (result.changes > 0) importedLeads++;
      }
    }

    if (messages?.length) {
      const stmt = db.prepare(`
        INSERT INTO messages (phone, direction, content, tenant_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const checkStmt = db.prepare('SELECT 1 FROM messages WHERE phone=? AND content=? AND created_at=?');
      for (const m of messages) {
        if (checkStmt.get(m.phone, m.content, m.created_at)) continue;
        stmt.run(m.phone, m.direction, m.content, m.tenant_id, m.created_at);
        importedMessages++;
      }
    }

    log.info({ importedLeads, importedMessages }, 'bulk-import complete');
    res.json({ success: true, importedLeads, importedMessages });
  } catch (err: any) {
    log.error({ err }, 'POST /bulk-import: error');
    res.status(500).json({ error: err.message });
  }
});
