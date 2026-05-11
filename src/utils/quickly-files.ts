import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('quickly-files');

const DEKEL_LEADS_BOARD_ID = 1443236269;
const FILES_COLUMN_ID = 'file_mm34mxvy'; // "קבצים מ-WhatsApp"
const PHONE_COLUMN_ID = 'phone';
const DEFAULT_GROUP_ID = 'topics'; // "חדשים (פייסבוק/יו טיוב)"
const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_FILE_API = 'https://api.monday.com/v2/file';

// Names that mean "we don't know who this is yet" — created by inbound voice
// agent (Camille), Quickly first-touch, or other auto-capture paths. Always
// prefer a real named lead over these when both exist for the same phone.
const PLACEHOLDER_NAME_RE = /^(unknown|whatsapp\s|לא ידוע|אנונימי)/i;

function scoreCandidate(item: { id: string; name: string; column_values?: any[] }): number {
  let score = 0;
  if (item.name && !PLACEHOLDER_NAME_RE.test(item.name.trim())) score += 100;
  const email = item.column_values?.find((c: any) => c.id === 'email')?.text;
  if (email) score += 20;
  const status = item.column_values?.find((c: any) => c.id === 'status')?.text;
  // Any status assigned (not blank/"new") is a sign of human triage
  if (status && status.trim() && status !== 'חדש') score += 10;
  return score;
}

export async function findDekelLeadByPhone(phone: string): Promise<string | null> {
  if (!config.mondayApiKey) return null;
  const variants = new Set<string>();
  variants.add(phone);
  variants.add('+' + phone);
  if (phone.startsWith('972')) variants.add('0' + phone.slice(3));

  // Collect ALL candidates across phone variants, then pick the best match.
  // Avoids the prior bug where limit:1 + non-deterministic order returned an
  // "unknown" placeholder lead while a real named lead existed for the same phone.
  const candidates = new Map<string, { id: string; name: string; column_values?: any[] }>();
  for (const v of variants) {
    const query = `query { items_page_by_column_values(board_id: ${DEKEL_LEADS_BOARD_ID}, columns: [{column_id: "${PHONE_COLUMN_ID}", column_values: ["${v}"]}], limit: 25) { items { id name column_values(ids: ["email","status"]) { id text } } } }`;
    try {
      const res = await fetch(MONDAY_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
        body: JSON.stringify({ query }),
      });
      const data = await res.json() as any;
      const items = data?.data?.items_page_by_column_values?.items ?? [];
      for (const it of items) candidates.set(it.id, it);
    } catch (e: any) {
      log.warn({ err: e.message, variant: v }, 'phone search failed');
    }
  }

  if (candidates.size === 0) return null;

  const ranked = [...candidates.values()].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  const winner = ranked[0];
  if (candidates.size > 1) {
    log.info({ phone, picked: winner.id, pickedName: winner.name, total: candidates.size, all: ranked.map(r => ({ id: r.id, name: r.name, score: scoreCandidate(r) })) }, 'multiple lead candidates — picked best');
  } else {
    log.debug({ phone, itemId: winner.id, name: winner.name }, 'lead matched');
  }
  return winner.id;
}

export async function createDekelLeadFromPhone(phone: string, name: string): Promise<string | null> {
  if (!config.mondayApiKey) return null;
  const itemName = name && name !== phone ? name : `WhatsApp ${phone}`;
  // Phone column value: Monday accepts {"phone":"...", "countryShortName":"IL"}
  const columnValues = JSON.stringify({
    [PHONE_COLUMN_ID]: { phone, countryShortName: 'IL' },
  });
  const mutation = `mutation { create_item(board_id: ${DEKEL_LEADS_BOARD_ID}, group_id: "${DEFAULT_GROUP_ID}", item_name: ${JSON.stringify(itemName)}, column_values: ${JSON.stringify(columnValues)}) { id } }`;
  try {
    const res = await fetch(MONDAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
      body: JSON.stringify({ query: mutation }),
    });
    const data = await res.json() as any;
    if (data.errors) {
      log.error({ errors: data.errors, phone }, 'Dekel lead creation failed');
      return null;
    }
    const itemId = data?.data?.create_item?.id ?? null;
    if (itemId) log.info({ phone, name: itemName, itemId }, 'Dekel lead auto-created from Quickly file');
    return itemId;
  } catch (e: any) {
    log.error({ err: e.message, phone }, 'Dekel lead create threw');
    return null;
  }
}

export async function uploadToFilesColumn(itemId: string, filename: string, content: Buffer, mimeType: string): Promise<string | null> {
  if (!config.mondayApiKey) return null;
  const query = `mutation ($file: File!) { add_file_to_column(item_id: ${itemId}, column_id: "${FILES_COLUMN_ID}", file: $file) { id } }`;
  const fd = new FormData();
  fd.append('query', query);
  fd.append('map', JSON.stringify({ image: 'variables.file' }));
  fd.append('image', new Blob([new Uint8Array(content)], { type: mimeType }), filename);
  try {
    const res = await fetch(MONDAY_FILE_API, {
      method: 'POST',
      headers: { Authorization: config.mondayApiKey },
      body: fd,
    });
    const data = await res.json() as any;
    if (data.errors) {
      log.error({ errors: data.errors, itemId, filename }, 'Monday upload failed');
      return null;
    }
    return data?.data?.add_file_to_column?.id ?? null;
  } catch (e: any) {
    log.error({ err: e.message, itemId, filename }, 'Monday upload threw');
    return null;
  }
}

async function notifyAlon(text: string): Promise<void> {
  if (!config.telegramBotToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.ALON_TG_CHAT_ID || '1584581543',
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
  } catch (e: any) {
    log.warn({ err: e.message }, 'Telegram notify failed');
  }
}

// Sapir gets a WA template ping for every Quickly upload batch so she can
// verify the docs in Monday. Uses dprisha_internal_report_v1 (UTILITY) — works
// outside the 24h window. Meta forbids newlines/tabs/4+ spaces in template
// params; caller must pass a single-line, pre-sanitised string.
const SAPIR_WA = process.env.SAPIR_WA || '972522281914';
const DEKEL_WA_PHONE_ID = process.env.DEKEL_WA_PHONE_ID || '1080047101853955';
const FB_TOKEN = process.env.FB_ACCESS_TOKEN || process.env.WA_CLOUD_TOKEN || '';

async function notifySapirWA(line: string): Promise<void> {
  if (!FB_TOKEN || !SAPIR_WA) return;
  // Hard sanitize for Meta template constraints (error 132018).
  const safe = line.replace(/[\n\t]/g, ' ').replace(/ {2,}/g, ' ').slice(0, 1000);
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${DEKEL_WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${FB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: SAPIR_WA,
        type: 'template',
        template: {
          name: 'dprisha_internal_report_v1',
          language: { code: 'he' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: safe }] }],
        },
      }),
    });
    if (!r.ok) {
      const err = await r.text();
      log.warn({ status: r.status, err: err.slice(0, 200) }, 'Sapir WA notify failed');
    } else {
      log.info({ to: SAPIR_WA }, 'Sapir WA notify sent');
    }
  } catch (e: any) {
    log.warn({ err: e.message }, 'Sapir WA notify threw');
  }
}

interface QuicklyMediaInput {
  phone: string;
  senderName: string;
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

// Per-phone debounce: aggregate all files from same sender, send a single
// Telegram summary 15 min after the last upload. Resets on every new file.
// In-memory only — Render restart drops pending timers (acceptable).
const DEBOUNCE_MS = parseInt(process.env.QUICKLY_NOTIFY_DEBOUNCE_MS || '900000', 10); // 15 min

interface PendingNotification {
  phone: string;
  senderName: string;
  itemId: string;
  isNewLead: boolean;
  files: { name: string; sizeKb: number }[];
  timer: NodeJS.Timeout;
}
const pending = new Map<string, PendingNotification>();

function scheduleSummary(phone: string): void {
  const entry = pending.get(phone);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pending.delete(phone);
    sendSummary(entry).catch(e => log.error({ err: e.message, phone }, 'summary send threw'));
  }, DEBOUNCE_MS);
}

async function sendSummary(entry: PendingNotification): Promise<void> {
  const { phone, senderName, itemId, isNewLead, files } = entry;
  const fileList = files.map(f => `  • ${f.name} (${f.sizeKb} KB)`).join('\n');
  const link = `[פתח ב-Monday](https://palm530671.monday.com/boards/${DEKEL_LEADS_BOARD_ID}/pulses/${itemId})`;
  const headline = isNewLead
    ? `🆕 *ליד חדש מ-Quickly*\nשם: ${senderName}\nטלפון: \`${phone}\``
    : `📎 *מסמכים חדשים מ-Quickly*\nשם: ${senderName}\nטלפון: \`${phone}\``;
  const text = `${headline}\n\n${files.length} מסמכים עלו לליד:\n${fileList}\n\n${link}`;
  await notifyAlon(text);

  // Sapir parallel ping — single-line WA template so she can verify in Monday.
  const sapirHead = isNewLead ? 'ליד חדש מ-Quickly' : 'מסמכים חדשים מ-Quickly';
  const sapirLine = `${sapirHead} | ${senderName} (${phone}) | ${files.length} קבצים: ` +
    files.map(f => f.name).join(', ') +
    ` | פתח: https://palm530671.monday.com/boards/${DEKEL_LEADS_BOARD_ID}/pulses/${itemId}`;
  await notifySapirWA(sapirLine);

  log.info({ phone, itemId, count: files.length, isNewLead }, 'Quickly summary notification sent');
}

export async function handleQuicklyIncomingMedia(input: QuicklyMediaInput): Promise<void> {
  const { phone, senderName, filename, buffer, mimeType } = input;
  const sizeKb = Math.round(buffer.byteLength / 1024);

  let itemId = await findDekelLeadByPhone(phone);
  let createdNew = false;

  if (!itemId) {
    itemId = await createDekelLeadFromPhone(phone, senderName);
    createdNew = !!itemId;
    if (!itemId) {
      await notifyAlon(`❌ *Quickly file capture* — לא הצלחתי ליצור ליד\nטלפון: \`${phone}\`\nשם: ${senderName}\nקובץ: ${filename} (${sizeKb} KB)\n\nהקובץ לא הועלה ל-Monday.`);
      return;
    }
  }

  const newAssetId = await uploadToFilesColumn(itemId, filename, buffer, mimeType);
  if (!newAssetId) {
    await notifyAlon(`❌ *Quickly file capture* — העלאה ל-Monday נכשלה\nליד: \`${itemId}\`\nטלפון: \`${phone}\`\nקובץ: ${filename} (${sizeKb} KB)`);
    return;
  }

  log.info({ phone, itemId, filename, newAssetId, createdNew }, 'WhatsApp media uploaded to Monday Files column');

  // Buffer the success — single Telegram summary will fire 15 min after the last file.
  let entry = pending.get(phone);
  if (!entry) {
    entry = {
      phone,
      senderName,
      itemId,
      isNewLead: createdNew,
      files: [],
      timer: setTimeout(() => {}, 0),
    };
    pending.set(phone, entry);
  } else {
    // If somehow the lead changed mid-burst (shouldn't), prefer the latest itemId
    entry.itemId = itemId;
    if (createdNew) entry.isNewLead = true;
    if (senderName && senderName !== phone) entry.senderName = senderName;
  }
  entry.files.push({ name: filename, sizeKb });
  scheduleSummary(phone);
}
