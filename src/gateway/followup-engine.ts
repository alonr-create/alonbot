import { db } from '../utils/db.js';
import { config } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const log = createLogger('followup-engine');

interface FollowupTemplate {
  id: number;
  name: string;
  day_offset: number;
  message: string;
  message_type: 'text' | 'voice' | 'image';
  sort_order: number;
  enabled: number;
}

interface FollowupConfig {
  auto_enabled: boolean;
  send_hour: number;
  max_followups: number;
  skip_statuses: string[];
  skip_replied: boolean;
}

// ── Slug Mapping ──
// Load slug_mapping.json for accurate preview site URLs
let slugMapping: Record<string, string> = {};
try {
  const mappingPath = join(config.dataDir, 'slug_mapping.json');
  if (existsSync(mappingPath)) {
    slugMapping = JSON.parse(readFileSync(mappingPath, 'utf-8'));
    log.info({ count: Object.keys(slugMapping).length }, 'loaded slug mapping');
  }
} catch { /* slug mapping not available */ }

// Reload slug mapping (called from API)
export function reloadSlugMapping() {
  try {
    const mappingPath = join(config.dataDir, 'slug_mapping.json');
    if (existsSync(mappingPath)) {
      slugMapping = JSON.parse(readFileSync(mappingPath, 'utf-8'));
      return Object.keys(slugMapping).length;
    }
  } catch {}
  return 0;
}

// Get follow-up config from DB
export function getFollowupConfig(): FollowupConfig {
  const rows = db.prepare('SELECT key, value FROM followup_config').all() as { key: string; value: string }[];
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;
  return {
    auto_enabled: cfg.auto_enabled !== 'false',
    send_hour: parseInt(cfg.send_hour || '10', 10),
    max_followups: parseInt(cfg.max_followups || '3', 10),
    skip_statuses: (cfg.skip_statuses || 'closed,refused,not_relevant,done').split(',').map(s => s.trim()),
    skip_replied: cfg.skip_replied !== 'false',
  };
}

// Get all templates sorted by sort_order
export function getFollowupTemplates(): FollowupTemplate[] {
  return db.prepare('SELECT * FROM followup_templates ORDER BY sort_order ASC, id ASC').all() as FollowupTemplate[];
}

// Get leads that need follow-up today
export function getPendingFollowups(): any[] {
  const cfg = getFollowupConfig();
  const skipStatusPlaceholders = cfg.skip_statuses.map(() => '?').join(',');

  const sql = `
    SELECT l.phone, l.name, l.source, l.lead_status, l.followup_count, l.next_followup, l.created_at,
      (SELECT COUNT(*) FROM messages WHERE sender_id = l.phone AND role = 'user' AND channel IN ('whatsapp','whatsapp-inbound')) as user_replies,
      (SELECT content FROM messages WHERE sender_id = l.phone ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages WHERE sender_id = l.phone ORDER BY created_at DESC LIMIT 1) as last_message_at
    FROM leads l
    WHERE l.next_followup IS NOT NULL
      AND l.next_followup <= date('now')
      AND l.followup_count < ?
      ${skipStatusPlaceholders ? `AND (l.lead_status IS NULL OR l.lead_status NOT IN (${skipStatusPlaceholders}))` : ''}
      ${cfg.skip_replied ? `AND (SELECT COUNT(*) FROM messages WHERE sender_id = l.phone AND role = 'user' AND channel IN ('whatsapp','whatsapp-inbound')) = 0` : ''}
    ORDER BY l.next_followup ASC
  `;

  const params = [cfg.max_followups, ...cfg.skip_statuses];
  return db.prepare(sql).all(...params) as any[];
}

// Get the right template for a lead's current followup_count
function getTemplateForCount(count: number): FollowupTemplate | null {
  const templates = db.prepare('SELECT * FROM followup_templates WHERE enabled = 1 ORDER BY sort_order ASC').all() as FollowupTemplate[];
  if (!templates.length) return null;
  return templates[Math.min(count, templates.length - 1)] || null;
}

// Meta template mapping: followup_count → approved template name
const META_TEMPLATE_MAP: Record<number, string> = {
  0: 'lead_followup_day3',
  1: 'lead_followup_day5',
  2: 'lead_followup_day8',
};

// Build preview site URL using slug_mapping.json for accuracy
function getLeadSiteUrl(lead: any): string {
  const name = lead.name || '';

  // First try exact match in slug mapping
  if (slugMapping[name]) {
    return `https://lead-previews.vercel.app/${slugMapping[name]}`;
  }

  // Try case-insensitive / partial match
  const nameLower = name.toLowerCase();
  for (const [key, slug] of Object.entries(slugMapping)) {
    if (key.toLowerCase() === nameLower) {
      return `https://lead-previews.vercel.app/${slug}`;
    }
  }

  // Fallback: generate slug from name (may not match actual page)
  const slug = name.toLowerCase().replace(/[^a-z0-9\s]/gi, '').replace(/\s+/g, '-').slice(0, 50) || lead.phone;
  return `https://lead-previews.vercel.app/${slug}`;
}

// ── Lead Scoring ──
export function calculateLeadScore(phone: string): { score: number; factors: string[] } {
  const factors: string[] = [];
  let score = 0;

  const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone) as any;
  if (!lead) return { score: 0, factors: ['ליד לא נמצא'] };

  // Replied to messages (+30)
  const replies = db.prepare("SELECT COUNT(*) as c FROM messages WHERE sender_id = ? AND role = 'user' AND channel IN ('whatsapp','whatsapp-inbound')").get(phone) as any;
  if (replies.c > 0) { score += 30; factors.push(`ענה ${replies.c} פעמים`); }

  // Has booking (+40)
  if (lead.was_booked) { score += 40; factors.push('נקבעה פגישה'); }

  // Status is interested/vip (+20)
  if (lead.lead_status === 'interested') { score += 20; factors.push('סטטוס: מעוניין'); }
  if (lead.lead_status === 'vip') { score += 30; factors.push('סטטוס: VIP'); }

  // Has tags indicating engagement (+10 each)
  const tags = db.prepare('SELECT tag FROM lead_tags WHERE phone = ?').all(phone) as any[];
  const engagementTags = tags.filter(t => ['welcome_sent', 'followup_sent', 'hot'].some(et => t.tag.includes(et)));
  if (engagementTags.length) { score += engagementTags.length * 5; factors.push(`${engagementTags.length} תגיות מעורבות`); }

  // Called (+15)
  if (lead.last_call_summary) { score += 15; factors.push('היתה שיחה'); }

  // Positive sentiment (+10)
  if (lead.last_call_sentiment === 'positive') { score += 10; factors.push('סנטימנט חיובי'); }

  // Recent activity (+10)
  const lastMsg = db.prepare("SELECT created_at FROM messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT 1").get(phone) as any;
  if (lastMsg) {
    const daysSince = (Date.now() - new Date(lastMsg.created_at).getTime()) / 86400000;
    if (daysSince < 3) { score += 10; factors.push('פעילות אחרונה ב-3 ימים'); }
  }

  // Base score for being a lead (+10)
  score += 10;

  return { score: Math.min(score, 100), factors };
}

// Auto-tag leads based on behavior
export function autoTagLead(phone: string) {
  const { score } = calculateLeadScore(phone);

  // Hot lead: score > 50
  if (score > 50) {
    db.prepare('INSERT OR IGNORE INTO lead_tags (phone, tag) VALUES (?, ?)').run(phone, 'hot');
  }

  // Check for negative keywords in messages
  const lastUserMsg = db.prepare("SELECT content FROM messages WHERE sender_id = ? AND role = 'user' AND channel IN ('whatsapp','whatsapp-inbound') ORDER BY created_at DESC LIMIT 1").get(phone) as any;
  if (lastUserMsg?.content) {
    const text = lastUserMsg.content.toLowerCase();
    const negativeWords = ['לא מעוניין', 'לא רלוונטי', 'הסר', 'תפסיק', 'spam', 'ספאם', 'לא צריך', 'עזוב'];
    if (negativeWords.some(w => text.includes(w))) {
      db.prepare('INSERT OR IGNORE INTO lead_tags (phone, tag) VALUES (?, ?)').run(phone, 'not_interested');
      db.prepare("UPDATE leads SET lead_status = 'not_relevant', next_followup = NULL, updated_at = datetime('now') WHERE phone = ?").run(phone);
      log.info({ phone }, 'auto-tagged as not_interested, cancelled follow-ups');
    }

    const positiveWords = ['מעוניין', 'כן', 'אני רוצה', 'בוא נדבר', 'שלח', 'תתקשר'];
    if (positiveWords.some(w => text.includes(w))) {
      db.prepare('INSERT OR IGNORE INTO lead_tags (phone, tag) VALUES (?, ?)').run(phone, 'interested');
      db.prepare("UPDATE leads SET lead_status = 'interested', updated_at = datetime('now') WHERE phone = ?").run(phone);
      log.info({ phone }, 'auto-tagged as interested');
    }
  }
}

// Send a single follow-up to a lead
export async function sendFollowup(phone: string, templateId?: number) {
  const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone) as any;
  if (!lead) throw new Error(`Lead ${phone} not found`);

  const template = templateId
    ? db.prepare('SELECT * FROM followup_templates WHERE id = ?').get(templateId) as FollowupTemplate
    : getTemplateForCount(lead.followup_count || 0);

  if (!template) throw new Error('No follow-up template available');

  const name = lead.name || '';
  const text = template.message.replace(/\{name\}/g, name);
  const siteUrl = getLeadSiteUrl(lead);

  // Try to send via Meta template first (works outside 24h window)
  const metaTemplateName = META_TEMPLATE_MAP[lead.followup_count || 0];
  let sentViaTemplate = false;

  if (metaTemplateName) {
    try {
      await sendWhatsAppTemplate(phone, metaTemplateName, [name || 'שלום', siteUrl]);
      sentViaTemplate = true;
      log.info({ phone, template: metaTemplateName }, 'follow-up sent via Meta template');
    } catch (e: any) {
      log.warn({ phone, template: metaTemplateName, err: e.message }, 'Meta template failed, falling back to text');
    }
  }

  // Fallback to regular text (works inside 24h window)
  if (!sentViaTemplate) {
    await sendWhatsAppText(phone, text);
  }

  // Update lead: increment followup_count, set next follow-up
  const nextTemplate = getTemplateForCount((lead.followup_count || 0) + 1);
  const cfg = getFollowupConfig();

  if ((lead.followup_count || 0) + 1 >= cfg.max_followups || !nextTemplate) {
    db.prepare('UPDATE leads SET followup_count = followup_count + 1, next_followup = NULL, updated_at = datetime(\'now\') WHERE phone = ?').run(phone);
  } else {
    const daysUntilNext = nextTemplate.day_offset - template.day_offset;
    const nextDate = daysUntilNext > 0 ? daysUntilNext : 2;
    db.prepare(`UPDATE leads SET followup_count = followup_count + 1, next_followup = date('now', '+${nextDate} days'), updated_at = datetime('now') WHERE phone = ?`).run(phone);
  }

  // Add tag
  db.prepare('INSERT OR IGNORE INTO lead_tags (phone, tag) VALUES (?, ?)').run(phone, `followup_${(lead.followup_count || 0) + 1}`);

  log.info({ phone, name, template: template.name, followupNum: (lead.followup_count || 0) + 1 }, 'follow-up sent');

  return { phone, name, template: template.name, followupNum: (lead.followup_count || 0) + 1 };
}

// Run the daily auto follow-up job
export async function runAutoFollowups(): Promise<{ sent: number; errors: number; details: any[] }> {
  const cfg = getFollowupConfig();
  if (!cfg.auto_enabled) {
    log.info('auto follow-up disabled');
    return { sent: 0, errors: 0, details: [] };
  }

  const pending = getPendingFollowups();
  log.info({ count: pending.length }, 'starting auto follow-ups');

  const details: any[] = [];
  let sent = 0;
  let errors = 0;

  for (const lead of pending) {
    try {
      const result = await sendFollowup(lead.phone);
      details.push({ ...result, success: true });
      sent++;
      // Small delay between sends (2-5 seconds)
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    } catch (e: any) {
      log.error({ phone: lead.phone, err: e.message }, 'follow-up failed');
      details.push({ phone: lead.phone, name: lead.name, error: e.message, success: false });
      errors++;
    }
  }

  log.info({ sent, errors }, 'auto follow-ups completed');
  return { sent, errors, details };
}

// ── Morning Report ──
export function generateMorningReport(): string {
  const pending = getPendingFollowups();
  const cfg = getFollowupConfig();

  // Total leads stats
  const totalLeads = (db.prepare('SELECT COUNT(*) as c FROM leads').get() as any).c;
  const newLeads = (db.prepare("SELECT COUNT(*) as c FROM leads WHERE lead_status = 'new' OR lead_status IS NULL").get() as any).c;
  const contacted = (db.prepare("SELECT COUNT(*) as c FROM leads WHERE lead_status = 'contacted'").get() as any).c;
  const interested = (db.prepare("SELECT COUNT(*) as c FROM leads WHERE lead_status = 'interested'").get() as any).c;
  const replied = (db.prepare("SELECT COUNT(DISTINCT sender_id) as c FROM messages WHERE role = 'user' AND channel IN ('whatsapp','whatsapp-inbound')").get() as any).c;

  // Hot leads (score > 50)
  const allLeads = db.prepare('SELECT phone FROM leads').all() as any[];
  let hotCount = 0;
  for (const l of allLeads) {
    const { score } = calculateLeadScore(l.phone);
    if (score > 50) hotCount++;
  }

  // Messages last 24h
  const msgs24h = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE created_at > datetime('now', '-1 day') AND channel IN ('whatsapp','whatsapp-inbound','whatsapp-outbound')").get() as any).c;

  const lines = [
    `📊 דוח בוקר — ${new Date().toLocaleDateString('he-IL')}`,
    ``,
    `📋 לידים: ${totalLeads} סה"כ`,
    `   חדשים: ${newLeads} | פנו: ${contacted} | מעוניינים: ${interested}`,
    `   ענו: ${replied} | חמים: ${hotCount}`,
    ``,
    `📨 הודעות 24 שעות: ${msgs24h}`,
    `🔄 פולואפים היום: ${pending.length}`,
    `⚙️ אוטומטי: ${cfg.auto_enabled ? 'פעיל' : 'כבוי'} (שעה ${cfg.send_hour}:00)`,
  ];

  if (pending.length > 0) {
    lines.push(``, `📋 ממתינים:`);
    for (const p of pending.slice(0, 10)) {
      lines.push(`   • ${p.name || p.phone} (#${(p.followup_count || 0) + 1})`);
    }
    if (pending.length > 10) lines.push(`   ... ועוד ${pending.length - 10}`);
  }

  return lines.join('\n');
}

// Schedule next_followup for a lead (called after first contact)
export function scheduleFirstFollowup(phone: string) {
  const templates = db.prepare('SELECT * FROM followup_templates WHERE enabled = 1 ORDER BY sort_order ASC LIMIT 1').get() as FollowupTemplate | undefined;
  if (!templates) return;

  db.prepare(`UPDATE leads SET next_followup = date('now', '+${templates.day_offset} days'), followup_count = 0, updated_at = datetime('now') WHERE phone = ? AND next_followup IS NULL`).run(phone);
}

// Postpone a lead's follow-up by N days
export function postponeFollowup(phone: string, days: number = 1) {
  db.prepare(`UPDATE leads SET next_followup = date('now', '+${Math.max(1, Math.min(days, 30))} days'), updated_at = datetime('now') WHERE phone = ?`).run(phone);
}

// Cancel all follow-ups for a lead
export function cancelFollowup(phone: string) {
  db.prepare('UPDATE leads SET next_followup = NULL, updated_at = datetime(\'now\') WHERE phone = ?').run(phone);
}

async function sendWhatsAppTemplate(phone: string, templateName: string, params: string[]) {
  const token = config.waCloudToken;
  const phoneId = config.waCloudPhoneId;
  if (!token || !phoneId) throw new Error('Cloud API not configured');

  const to = phone.replace(/\D/g, '');
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'he' },
        components: [
          {
            type: 'body',
            parameters: params.map(p => ({ type: 'text', text: p }))
          }
        ]
      }
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Template API error: ${resp.status} ${err}`);
  }

  const bodyText = `[Template: ${templateName}] ${params.join(' | ')}`;
  db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, datetime('now'))").run(phone, bodyText);
}

async function sendWhatsAppText(phone: string, text: string) {
  const token = config.waCloudToken;
  const phoneId = config.waCloudPhoneId;
  if (!token || !phoneId) throw new Error('Cloud API not configured');

  const to = phone.replace(/\D/g, '');
  const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`WhatsApp API error: ${resp.status} ${err}`);
  }

  db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, datetime('now'))").run(phone, text);
}

// Setup daily cron (called from server startup)
export function setupFollowupCron() {
  const cfg = getFollowupConfig();
  const hour = cfg.send_hour;

  // Check every 15 minutes if it's time to run
  setInterval(async () => {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const currentHour = israelTime.getHours();
    const currentMinute = israelTime.getMinutes();

    // Morning report — 30 mins before follow-up hour
    const reportHour = hour > 0 ? hour - 1 : 23;
    if (currentHour === reportHour && currentMinute >= 30 && currentMinute < 45) {
      const today = israelTime.toISOString().split('T')[0];
      const lastReport = db.prepare("SELECT value FROM followup_config WHERE key = 'last_morning_report'").get() as any;
      if (lastReport?.value !== today) {
        db.prepare("INSERT OR REPLACE INTO followup_config (key, value, updated_at) VALUES ('last_morning_report', ?, datetime('now'))").run(today);
        const report = generateMorningReport();
        try {
          const { sendPushNotification } = await import('./server.js');
          sendPushNotification({
            title: '📊 דוח בוקר',
            body: report.split('\n').slice(2, 5).join(' | '),
            tag: 'morning-report',
          });
        } catch { /* push not available */ }
        log.info('morning report sent');
      }
    }

    // Run at configured hour, first 15-minute window
    if (currentHour === hour && currentMinute < 15) {
      const today = israelTime.toISOString().split('T')[0];
      const lastRun = db.prepare("SELECT value FROM followup_config WHERE key = 'last_auto_run'").get() as any;
      if (lastRun?.value === today) return;

      db.prepare("INSERT OR REPLACE INTO followup_config (key, value, updated_at) VALUES ('last_auto_run', ?, datetime('now'))").run(today);

      log.info('running daily auto follow-ups');
      const result = await runAutoFollowups();

      if (result.sent > 0 || result.errors > 0) {
        try {
          const { sendPushNotification } = await import('./server.js');
          sendPushNotification({
            title: 'פולואפ אוטומטי',
            body: `נשלחו ${result.sent} הודעות פולואפ${result.errors > 0 ? ` (${result.errors} שגיאות)` : ''}`,
            tag: 'auto-followup',
          });
        } catch { /* push not available */ }
      }
    }
  }, 15 * 60 * 1000);

  log.info({ hour }, 'follow-up cron scheduled (with morning report)');
}
