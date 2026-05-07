import { config } from '../utils/config.js';
import { db } from '../utils/db.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('commission-report');

const COMMISSIONS_BOARD_ID = 1513673310; // עמלות
const SALARIES_BOARD_ID = 1444238467; // משכורות/שכ״ט
const COMMISSION_FORMULA = 'formula_mktbc475'; // טוטאל עמלה דקל לפרישה (דורית עם רישיון)
const COMMISSION_DATE = 'date4'; // תאריך
const SALARY_FORMULA = 'formula_mkpsw4vt'; // טוטאל דקל לפרישה
const SALARY_DROPDOWN = 'dropdown3__1'; // בגין חודש

const MONTHLY_TARGET = 142_000;
const ANNUAL_TARGET = MONTHLY_TARGET * 12;
const ALERT_THRESHOLD = 1500;

const ALON_PHONE = process.env.ALON_PHONE || '972546300783';
const DEKEL_PHONE = process.env.DEKEL_PHONE || '972526252521';

const HE_MONTH_LABELS: Record<number, string> = {
  1: 'ינואר', 2: 'פברואר', 3: 'מרץ', 4: 'אפריל', 5: 'מאי', 6: 'יוני',
  7: 'יולי', 8: 'אוגוסט', 9: 'ספטמבר', 10: 'אוקטובר', 11: 'נובמבר', 12: 'דצמבר',
};

interface MonthlyData {
  month: string; // "2026-05"
  monthLabel: string; // "מאי 2026"
  monthLabelShort: string; // "מאי 26"
  commissionsTotal: number;
  salariesTotal: number;
  total: number;
  target: number;
  progressPct: number;
  remaining: number;
  daysLeft: number;
  dailyNeeded: number;
}

async function gql<T = any>(query: string): Promise<T> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
    body: JSON.stringify({ query }),
  });
  const data = await res.json() as any;
  if (data.errors) throw new Error(`GraphQL: ${JSON.stringify(data.errors)}`);
  return data.data;
}

async function pageItems<T = any>(boardId: number, fieldsList: string): Promise<T[]> {
  let cursor: string | null = null;
  const out: T[] = [];
  while (true) {
    const q = cursor === null
      ? `{ boards(ids: [${boardId}]) { items_page(limit: 200) { cursor items ${fieldsList} } } }`
      : `{ next_items_page(cursor: "${cursor}", limit: 200) { cursor items ${fieldsList} } }`;
    const data = await gql<any>(q);
    const page: any = cursor === null ? data.boards[0].items_page : data.next_items_page;
    out.push(...(page.items as T[]));
    cursor = page.cursor;
    if (!cursor) break;
  }
  return out;
}

function parseNum(s: string | undefined | null): number {
  if (!s) return 0;
  const cleaned = String(s).replace(/,/g, '').replace(/[^\d.\-]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

export async function computeMonthlyData(now = new Date()): Promise<MonthlyData> {
  const yyyy = now.getFullYear();
  const mm = now.getMonth() + 1;
  const monthKey = `${yyyy}-${String(mm).padStart(2, '0')}`;
  const monthLabel = `${HE_MONTH_LABELS[mm]} ${yyyy}`;
  const monthLabelShort = `${HE_MONTH_LABELS[mm]} ${String(yyyy).slice(-2)}`;

  log.info({ monthKey }, 'fetching commissions data');

  const commItems = await pageItems<any>(
    COMMISSIONS_BOARD_ID,
    `{ id column_values(ids: ["${COMMISSION_DATE}", "${COMMISSION_FORMULA}"]) { id text ... on FormulaValue { display_value } ... on DateValue { date } } }`,
  );
  let commissionsTotal = 0;
  for (const it of commItems) {
    const cv: Record<string, any> = {};
    for (const c of it.column_values) cv[c.id] = c;
    const d = cv[COMMISSION_DATE]?.date ?? '';
    if (typeof d === 'string' && d.startsWith(monthKey)) {
      commissionsTotal += parseNum(cv[COMMISSION_FORMULA]?.display_value);
    }
  }

  const salItems = await pageItems<any>(
    SALARIES_BOARD_ID,
    `{ id column_values(ids: ["${SALARY_DROPDOWN}", "${SALARY_FORMULA}"]) { id text ... on FormulaValue { display_value } ... on DropdownValue { values { label } } } }`,
  );
  let salariesTotal = 0;
  for (const it of salItems) {
    const cv: Record<string, any> = {};
    for (const c of it.column_values) cv[c.id] = c;
    const labels: string[] = (cv[SALARY_DROPDOWN]?.values || []).map((v: any) => v.label);
    if (labels.some(l => l === monthLabelShort)) {
      salariesTotal += parseNum(cv[SALARY_FORMULA]?.display_value);
    }
  }

  const total = commissionsTotal + salariesTotal;
  const progressPct = (total / MONTHLY_TARGET) * 100;
  const remaining = Math.max(0, MONTHLY_TARGET - total);
  const lastDay = new Date(yyyy, mm, 0).getDate();
  const daysLeft = Math.max(1, lastDay - now.getDate());
  const dailyNeeded = remaining / daysLeft;

  return {
    month: monthKey,
    monthLabel,
    monthLabelShort,
    commissionsTotal,
    salariesTotal,
    total,
    target: MONTHLY_TARGET,
    progressPct,
    remaining,
    daysLeft,
    dailyNeeded,
  };
}

function fmtIls(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Single-line format — Meta WhatsApp templates reject \n and 4+ consecutive spaces in {{1}}. */
export function buildWeeklyReportText(d: MonthlyData): string {
  const pct = d.progressPct.toFixed(1);
  const SEP = '  •  ';
  return [
    `📊 דוח שבועי עמלות — ${d.monthLabel}`,
    `🎯 יעד חודשי: ₪${fmtIls(d.target)}`,
    `✅ הושג: ₪${fmtIls(d.total)} (${pct}%)`,
    `🔥 חסר: ₪${fmtIls(d.remaining)} ב-${d.daysLeft} ימים = ₪${fmtIls(d.dailyNeeded)}/יום`,
    `עמלות: ₪${fmtIls(d.commissionsTotal)}`,
    `שכ״ט: ₪${fmtIls(d.salariesTotal)}`,
  ].join(SEP);
}

// ─────────────────────────────────────────────────────────────────────────
// WhatsApp send
// ─────────────────────────────────────────────────────────────────────────

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const WA_PHONE_ID = process.env.WA_CLOUD_PHONE_ID || '1080047101853955'; // Dekel bot 0559566148

async function waSendTemplate(toPhone: string, body: string): Promise<boolean> {
  const token = config.waCloudToken || config.fbAccessToken;
  if (!token) { log.error('no WA token'); return false; }
  try {
    const res = await fetch(`${GRAPH_API}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'template',
        template: {
          name: 'dprisha_general_v1',
          language: { code: 'he' },
          components: [{
            type: 'body',
            parameters: [{ type: 'text', text: body }],
          }],
        },
      }),
    });
    const data = await res.json() as any;
    if (!res.ok || data.error) {
      log.error({ status: res.status, data }, 'WA template send failed');
      return false;
    }
    log.info({ to: toPhone, msgId: data.messages?.[0]?.id }, 'WA template sent');
    return true;
  } catch (e: any) {
    log.error({ err: e.message }, 'WA template send threw');
    return false;
  }
}

async function waSendImage(toPhone: string, imageUrl: string, caption?: string): Promise<boolean> {
  const token = config.waCloudToken || config.fbAccessToken;
  if (!token) return false;
  try {
    const res = await fetch(`${GRAPH_API}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toPhone,
        type: 'image',
        image: { link: imageUrl, caption: caption || undefined },
      }),
    });
    const data = await res.json() as any;
    if (!res.ok || data.error) {
      log.warn({ status: res.status, data }, 'WA image send failed (likely outside 24h window)');
      return false;
    }
    log.info({ to: toPhone }, 'WA image sent');
    return true;
  } catch (e: any) {
    log.error({ err: e.message }, 'WA image send threw');
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────

export async function sendWeeklyCommissionReport(toPhones: string[], imageUrl?: string): Promise<void> {
  const data = await computeMonthlyData();
  const body = buildWeeklyReportText(data);
  log.info({ phones: toPhones, total: data.total, target: data.target }, 'sending weekly commission report');
  for (const phone of toPhones) {
    const ok = await waSendTemplate(phone, body);
    if (ok && imageUrl) {
      await waSendImage(phone, imageUrl, `${data.monthLabel} — ${data.progressPct.toFixed(0)}% מהיעד`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Threshold alert: new commission item with value > 1500
// ─────────────────────────────────────────────────────────────────────────

function ensureCommissionAlertTable(): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS commission_alerts_seen (
    item_id TEXT PRIMARY KEY,
    notified_at TEXT NOT NULL
  )`).run();
}

export async function checkNewCommissionsAndAlert(toPhones: string[]): Promise<void> {
  ensureCommissionAlertTable();
  const items = await pageItems<any>(
    COMMISSIONS_BOARD_ID,
    `{ id name created_at column_values(ids: ["${COMMISSION_DATE}", "${COMMISSION_FORMULA}"]) { id text ... on FormulaValue { display_value } ... on DateValue { date } } }`,
  );

  const since = Date.now() - 30 * 60_000; // last 30 min window
  let alertCount = 0;

  for (const it of items) {
    const createdMs = it.created_at ? Date.parse(it.created_at) : 0;
    if (createdMs < since) continue;

    const cv: Record<string, any> = {};
    for (const c of it.column_values) cv[c.id] = c;
    const amount = parseNum(cv[COMMISSION_FORMULA]?.display_value);
    if (amount <= ALERT_THRESHOLD) continue;

    const seen = db.prepare('SELECT 1 FROM commission_alerts_seen WHERE item_id = ?').get(String(it.id)) as any;
    if (seen) continue;

    const SEP = '  •  ';
    const body = [
      `💰 עמלה חדשה מעל ₪${fmtIls(ALERT_THRESHOLD)}`,
      `שם: ${it.name}`,
      `סכום: ₪${fmtIls(amount)}`,
      `https://palm530671.monday.com/boards/${COMMISSIONS_BOARD_ID}/pulses/${it.id}`,
    ].join(SEP);

    for (const phone of toPhones) await waSendTemplate(phone, body);

    db.prepare('INSERT OR IGNORE INTO commission_alerts_seen (item_id, notified_at) VALUES (?, ?)')
      .run(String(it.id), new Date().toISOString());
    alertCount++;
  }

  if (alertCount > 0) log.info({ alertCount }, 'commission alerts sent');
}
