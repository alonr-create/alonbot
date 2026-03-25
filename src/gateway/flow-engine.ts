import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';

const log = createLogger('flow-engine');

interface FlowStep {
  type: 'send_message' | 'wait' | 'condition' | 'add_tag' | 'update_status';
  params: Record<string, any>;
  delay_ms?: number;
}

// Execute a flow for a phone number
export async function executeFlow(flowId: number, phone: string) {
  const flow = db.prepare('SELECT * FROM chatbot_flows WHERE id = ? AND enabled = 1').get(flowId) as any;
  if (!flow) return;

  const steps: FlowStep[] = JSON.parse(flow.steps);
  if (!steps.length) return;

  // Check if already running this flow for this phone
  const existing = db.prepare('SELECT * FROM flow_runs WHERE flow_id = ? AND phone = ? AND status = \'active\'').get(flowId, phone) as any;
  if (existing) return;

  // Create flow run
  const run = db.prepare('INSERT INTO flow_runs (flow_id, phone) VALUES (?, ?)').run(flowId, phone);
  const runId = run.lastInsertRowid;

  log.info({ flowId, phone, runId, flowName: flow.name }, 'starting flow');

  // Execute steps sequentially
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Update current step
    db.prepare('UPDATE flow_runs SET current_step = ?, updated_at = datetime(\'now\') WHERE id = ?').run(i, runId);

    // Wait if delay specified
    if (step.delay_ms && step.delay_ms > 0) {
      await new Promise(resolve => setTimeout(resolve, Math.min(step.delay_ms!, 300000))); // max 5 min
    }

    try {
      switch (step.type) {
        case 'send_message': {
          const text = (step.params.message || '').replace(/\{name\}/g, getLeadName(phone));
          if (text) await sendWhatsAppMessage(phone, text);
          break;
        }
        case 'add_tag': {
          const tag = step.params.tag;
          if (tag) {
            db.prepare('INSERT OR IGNORE INTO lead_tags (phone, tag) VALUES (?, ?)').run(phone, tag);
          }
          break;
        }
        case 'update_status': {
          const status = step.params.status;
          if (status) {
            db.prepare('UPDATE leads SET lead_status = ?, updated_at = datetime(\'now\') WHERE phone = ?').run(status, phone);
          }
          break;
        }
        case 'wait': {
          // For longer waits, we just pause the flow (would need a scheduler for production multi-hour waits)
          const waitMs = step.params.duration_ms || 5000;
          await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 300000)));
          break;
        }
        case 'condition': {
          // Simple condition: check if lead replied
          if (step.params.check === 'has_replied') {
            const replied = db.prepare("SELECT COUNT(*) as c FROM messages WHERE sender_id = ? AND role = 'user' AND channel IN ('whatsapp','whatsapp-inbound')").get(phone) as any;
            if (replied.c === 0 && step.params.skip_to !== undefined) {
              // Skip to end if condition not met
              break;
            }
          }
          break;
        }
      }
    } catch (e: any) {
      log.error({ flowId, phone, step: i, err: e.message }, 'flow step error');
    }
  }

  // Mark flow as completed
  db.prepare('UPDATE flow_runs SET status = \'completed\', current_step = ?, updated_at = datetime(\'now\') WHERE id = ?').run(steps.length, runId);
  log.info({ flowId, phone, runId }, 'flow completed');
}

function getLeadName(phone: string): string {
  const lead = db.prepare('SELECT name FROM leads WHERE phone = ?').get(phone) as any;
  return lead?.name || '';
}

async function sendWhatsAppMessage(phone: string, text: string) {
  const token = config.waCloudToken;
  const phoneId = config.waCloudPhoneId;
  if (!token || !phoneId) {
    log.warn('Cloud API not configured for flow message');
    return;
  }
  const to = phone.replace(/\D/g, '');
  await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
  // Log outbound message
  db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, datetime('now'))").run(phone, text);
}

// Trigger flows by event (called from router)
export function triggerFlows(triggerType: string, triggerValue: string, phone: string) {
  try {
    const flows = db.prepare('SELECT * FROM chatbot_flows WHERE trigger_type = ? AND enabled = 1').all(triggerType) as any[];
    for (const flow of flows) {
      if (triggerType === 'keyword') {
        const keywords = (flow.trigger_value || '').split(',').map((k: string) => k.trim().toLowerCase());
        if (!keywords.some((kw: string) => triggerValue.toLowerCase().includes(kw))) continue;
      } else if (triggerType === 'new_lead' || triggerType === 'status_change') {
        // These match all flows of that trigger_type
      }
      // Fire and forget
      executeFlow(flow.id, phone).catch(e => log.error({ err: e.message, flowId: flow.id }, 'flow execution failed'));
    }
  } catch (e: any) {
    log.debug({ err: e.message }, 'triggerFlows error');
  }
}

// Seed example flows (called once)
export function seedExampleFlows() {
  const existing = db.prepare('SELECT COUNT(*) as c FROM chatbot_flows').get() as any;
  if (existing.c > 0) return; // Don't seed if flows already exist

  // Flow 1: Welcome new lead — greet + ask for details + tag
  const welcomeSteps: FlowStep[] = [
    { type: 'send_message', params: { message: 'היי {name}! 👋 תודה שפנית אלינו.\nאני יעל, העוזרת הדיגיטלית של Alon.dev — אשמח לעזור לך.' }, delay_ms: 0 },
    { type: 'send_message', params: { message: 'ב-48 שעות אני בונה אתר מקצועי ומותאם אישית לעסק שלך.\n\nמה סוג העסק שלך? 🏪' }, delay_ms: 3000 },
    { type: 'add_tag', params: { tag: 'welcome_sent' }, delay_ms: 0 },
    { type: 'update_status', params: { status: 'contacted' }, delay_ms: 0 },
  ];
  db.prepare('INSERT INTO chatbot_flows (name, trigger_type, trigger_value, steps) VALUES (?, ?, ?, ?)').run(
    '👋 קבלת פנים לליד חדש', 'new_lead', '', JSON.stringify(welcomeSteps)
  );

  // Flow 2: Follow-up for leads who didn't respond
  const followupSteps: FlowStep[] = [
    { type: 'send_message', params: { message: 'היי {name}, ראיתי שעדיין לא הספקנו לדבר 🙂\nיש לי הצעה מיוחדת בשבילך — אתר מקצועי ב-48 שעות!' }, delay_ms: 0 },
    { type: 'send_message', params: { message: 'תשלח לי "מעוניין" ואני אחזור אליך עם דוגמאות 🚀' }, delay_ms: 5000 },
    { type: 'add_tag', params: { tag: 'followup_sent' }, delay_ms: 0 },
  ];
  db.prepare('INSERT INTO chatbot_flows (name, trigger_type, trigger_value, steps) VALUES (?, ?, ?, ?)').run(
    '🔄 פולואפ ללידים שלא ענו', 'keyword', 'מעוניין,אני רוצה,כן', JSON.stringify(followupSteps)
  );

  log.info('seeded 2 example chatbot flows');
}
