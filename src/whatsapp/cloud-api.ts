import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('cloud-api');

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedMessage {
  phoneNumberId: string;
  senderPhone: string;
  senderName: string;
  messageId: string;
  text: string;
  timestamp: number;
}

export interface SendCloudResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseWebhookPayload
// ─────────────────────────────────────────────────────────────────────────────

export function parseWebhookPayload(body: any): ParsedMessage[] {
  try {
    if (!body || !Array.isArray(body.entry)) return [];

    const result: ParsedMessage[] = [];

    for (const entry of body.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        const value = change?.value;
        if (!value) continue;

        const phoneNumberId: string = value.metadata?.phone_number_id ?? '';
        const messages: any[] = Array.isArray(value.messages) ? value.messages : [];
        if (messages.length === 0) continue;

        const contacts: any[] = Array.isArray(value.contacts) ? value.contacts : [];

        for (const msg of messages) {
          const senderPhone: string = msg.from ?? '';
          const messageId: string = msg.id ?? '';
          const timestamp: number = parseInt(msg.timestamp ?? '0', 10);

          // Resolve sender name from contacts by matching wa_id
          const contact = contacts.find((c: any) => c.wa_id === senderPhone);
          const senderName: string = contact?.profile?.name ?? '';

          // Extract text depending on message type
          let text: string;
          if (msg.type === 'text') {
            text = msg.text?.body ?? '';
          } else {
            text = `[${msg.type}]`;
          }

          result.push({ phoneNumberId, senderPhone, senderName, messageId, text, timestamp });
        }
      }
    }

    return result;
  } catch (err: any) {
    log.warn({ err }, 'parseWebhookPayload: error parsing payload, returning empty');
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendCloudMessage
// ─────────────────────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  let normalized = phone.replace(/[\s\-\(\)]/g, '');
  if (normalized.startsWith('+')) normalized = normalized.slice(1);
  if (normalized.startsWith('0')) normalized = '972' + normalized.slice(1);
  return normalized;
}

export async function sendCloudMessage(params: {
  to: string;
  message: string;
  phoneNumberId?: string;
}): Promise<SendCloudResult> {
  const { message, phoneNumberId } = params;
  const to = normalizePhone(params.to);
  // Read env vars directly at call time so tests can override them
  const pid = phoneNumberId || process.env.WA_CLOUD_PHONE_ID || config.waCloudPhoneId;
  const token = process.env.WA_CLOUD_TOKEN || config.waCloudToken;

  const url = `${GRAPH_API_BASE}/${pid}/messages`;

  log.info({ to, pid }, 'sendCloudMessage: sending');

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message },
      }),
    });

    const data = await response.json() as any;

    if (!response.ok) {
      const errorMsg = data?.error?.message ?? `HTTP ${response.status}`;
      log.warn({ to, pid, error: errorMsg }, 'sendCloudMessage: API error');
      return { success: false, error: errorMsg };
    }

    const messageId: string = data?.messages?.[0]?.id ?? '';
    log.info({ to, pid, messageId }, 'sendCloudMessage: sent successfully');
    return { success: true, messageId };
  } catch (err: any) {
    log.error({ to, pid, err }, 'sendCloudMessage: fetch error');
    return { success: false, error: err.message ?? String(err) };
  }
}
