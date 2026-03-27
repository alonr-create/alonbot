import { db } from '../utils/db.js';
import { LEAD_STATUS } from '../utils/lead-status.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';

const log = createLogger('flow-engine');

function nowIsrael(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).replace(' ', 'T');
}

interface FlowStep {
  type: 'send_message' | 'send_voice' | 'wait' | 'condition' | 'add_tag' | 'update_status';
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
        case 'send_voice': {
          const voiceText = (step.params.text || '').replace(/\{name\}/g, getLeadName(phone));
          const voicePreset = step.params.voice || 'yael';
          if (voiceText) await sendWhatsAppVoice(phone, voiceText, voicePreset);
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
  db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)").run(phone, text, nowIsrael());
}

async function sendWhatsAppVoice(phone: string, text: string, voice: string) {
  const elevenLabsKey = config.elevenlabsApiKey;
  const waToken = config.waCloudToken;
  const waPhoneId = config.waCloudPhoneId;
  if (!elevenLabsKey || !waToken || !waPhoneId) {
    log.warn('voice or Cloud API not configured for flow voice');
    return;
  }

  try {
    // Import voice presets
    const { VOICE_PRESETS } = await import('../tools/handlers/send-voice.js');
    const preset = VOICE_PRESETS[voice] || VOICE_PRESETS.yael;

    // Generate TTS via ElevenLabs
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${preset.id}?output_format=ogg_opus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': elevenLabsKey },
      body: JSON.stringify({ text, model_id: 'eleven_v3', voice_settings: preset.settings }),
    });
    if (!ttsRes.ok) { log.warn({ status: ttsRes.status }, 'ElevenLabs TTS failed in flow'); return; }
    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());

    // Upload audio to WhatsApp Media API
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', 'audio/ogg');
    formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg; codecs=opus' }), 'voice.ogg');

    const uploadRes = await fetch(`https://graph.facebook.com/v21.0/${waPhoneId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waToken}` },
      body: formData,
    });
    if (!uploadRes.ok) { log.warn({ status: uploadRes.status }, 'WA media upload failed in flow'); return; }
    const { id: mediaId } = await uploadRes.json() as any;

    // Send voice note
    const to = phone.replace(/\D/g, '');
    await fetch(`https://graph.facebook.com/v21.0/${waPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${waToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'audio', audio: { id: mediaId } }),
    });

    db.prepare("INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-outbound', ?, 'assistant', ?, ?)").run(phone, `[הודעה קולית — ${voice}] ${text}`, nowIsrael());
    log.info({ phone, voice, textLen: text.length }, 'flow: voice message sent');
  } catch (e: any) {
    log.error({ phone, err: e.message }, 'flow: voice send failed');
  }
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

  // Flow 1: Welcome new lead — voice + text + tag
  const welcomeSteps: FlowStep[] = [
    { type: 'send_voice', params: { text: 'היי {name}! כאן יעל מ-Alon.dev. ראיתי את העסק שלך ורציתי להציע לך משהו שיכול לעזור. אם יש לך דקה, שלח לי הודעה ואני אספר!', voice: 'yael' }, delay_ms: 0 },
    { type: 'send_message', params: { message: 'מה דעתך? אם יש שאלות אני כאן 😊' }, delay_ms: 3000 },
    { type: 'add_tag', params: { tag: 'welcome_sent' }, delay_ms: 0 },
    { type: 'update_status', params: { status: LEAD_STATUS.CONTACTED }, delay_ms: 0 },
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

// One-time migration: update existing welcome flow to include voice message
export function migrateFlowsAddVoice() {
  try {
    const welcomeFlow = db.prepare("SELECT id, steps FROM chatbot_flows WHERE name LIKE '%קבלת פנים%' OR name LIKE '%welcome%' LIMIT 1").get() as any;
    if (!welcomeFlow) return;
    const steps: FlowStep[] = JSON.parse(welcomeFlow.steps);
    // Check if already has send_voice
    if (steps.some(s => s.type === 'send_voice')) return;
    // Replace text-only welcome with voice + text
    const newSteps: FlowStep[] = [
      { type: 'send_voice', params: { text: 'היי {name}! כאן יעל מ-Alon.dev. ראיתי את העסק שלך ורציתי להציע לך משהו שיכול לעזור. אם יש לך דקה, שלח לי הודעה ואני אספר!', voice: 'yael' }, delay_ms: 0 },
      { type: 'send_message', params: { message: 'מה דעתך? אם יש שאלות אני כאן 😊' }, delay_ms: 3000 },
      { type: 'add_tag', params: { tag: 'welcome_sent' }, delay_ms: 0 },
      { type: 'update_status', params: { status: LEAD_STATUS.CONTACTED }, delay_ms: 0 },
    ];
    db.prepare('UPDATE chatbot_flows SET steps = ? WHERE id = ?').run(JSON.stringify(newSteps), welcomeFlow.id);
    log.info({ flowId: welcomeFlow.id }, 'migrated welcome flow to include voice');
  } catch (e: any) {
    log.warn({ err: e.message }, 'flow voice migration skipped');
  }
}
