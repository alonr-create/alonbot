import { config } from './config.js';
import { db } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('commission');

const COMMISSIONS_BOARD_ID = 1513673310;
const SALARIES_BOARD_ID = 1444238467;

const FORMULA_COMMISSIONS = 'formula_mktbc475';
const FORMULA_SALARIES = 'formula_mkpsw4vt';
const DATE_COL_COMMISSIONS = 'date4';
const DROPDOWN_MONTH_SALARIES = 'dropdown3__1';

const MONTHLY_TARGET_NIS = 142_000;
const ALERT_THRESHOLD_NIS = 1_500;

const ALON_PHONE = '972546300783';
const DEKEL_PHONE = '972526252521';
const RECIPIENTS = [ALON_PHONE, DEKEL_PHONE];

const TEMPLATE_NAME = 'dprisha_general_v1';
const TEMPLATE_LANG = 'he';

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const DPRISHA_PHONE_ID = '1080047101853955'; // sends from 0559566148 (Dekel WABA, has approved templates)

const HEBREW_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

export function todayInIsrael(): Date {
  const iso = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' });
  return new Date(iso.replace(' ', 'T') + '+03:00');
}

function currentMonthBoundaries(): { start: Date; end: Date; year: number; month1: number } {
  const now = todayInIsrael();
  const y = now.getFullYear();
  const m = now.getMonth();
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 1));
  return { start, end, year: y, month1: m + 1 };
}

function hebrewMonthLabel(): string {
  const { year, month1 } = currentMonthBoundaries();
  const yy = String(year).slice(-2);
  return `${HEBREW_MONTHS[month1 - 1]} ${yy}`;
}

interface MondayItem {
  id: string;
  name: string;
  created_at: string;
  date4: string;
  formulaValue: number;
  status: string;
}

async function gqlFetch(query: string): Promise<any> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: config.mondayApiKey },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

function num(v: any): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export interface CommissionTotals {
  monthCommissions: number;
  monthSalaries: number;
  monthTotal: number;
  targetNis: number;
  progressPct: number;
  daysInMonth: number;
  dayOfMonth: number;
  daysLeft: number;
  remainingNis: number;
  perDayNeeded: number;
  monthLabelHe: string;
  last7daysCommissions: number;
  last7daysSalaries: number;
  last7daysTotal: number;
  last7daysItemCount: number;
  prevMonthCommissions: number;
  prevMonthSalaries: number;
  prevMonthTotal: number;
}

export async function fetchCommissionTotals(): Promise<CommissionTotals> {
  const { start, end, month1, year } = currentMonthBoundaries();
  const todayIsrael = todayInIsrael();
  const sevenDaysAgo = new Date(todayIsrael.getTime() - 7 * 86400_000);
  const monthStartIso = start.toISOString().slice(0, 10);
  const monthEndIso = end.toISOString().slice(0, 10);

  // === Commissions board ===
  const commissionsItems = await fetchAllItems(COMMISSIONS_BOARD_ID, [DATE_COL_COMMISSIONS, FORMULA_COMMISSIONS]);

  let monthCommissions = 0;
  let last7Commissions = 0;
  let last7Count = 0;
  let prevMonthCommissions = 0;
  const prevMonthStart = new Date(Date.UTC(year, month1 - 2, 1));
  const prevMonthEnd = new Date(Date.UTC(year, month1 - 1, 1));
  const prevStartIso = prevMonthStart.toISOString().slice(0, 10);
  const prevEndIso = prevMonthEnd.toISOString().slice(0, 10);

  for (const it of commissionsItems) {
    const d = it.column_values.find((c: any) => c.id === DATE_COL_COMMISSIONS)?.date || '';
    const v = num(it.column_values.find((c: any) => c.id === FORMULA_COMMISSIONS)?.display_value);
    if (d >= monthStartIso && d < monthEndIso) monthCommissions += v;
    if (d >= prevStartIso && d < prevEndIso) prevMonthCommissions += v;
    if (d) {
      const di = new Date(d + 'T00:00:00Z');
      if (di >= sevenDaysAgo && v > 0) {
        last7Commissions += v;
        last7Count += 1;
      }
    }
  }

  // === Salaries board (filter by dropdown "בגין חודש") ===
  const salariesItems = await fetchAllItems(SALARIES_BOARD_ID, [DROPDOWN_MONTH_SALARIES, DATE_COL_COMMISSIONS, FORMULA_SALARIES]);
  const monthLabel = hebrewMonthLabel();

  // Match also previous month label
  const prevMonthIdx = month1 === 1 ? 12 : month1 - 1;
  const prevYearIdx = month1 === 1 ? year - 1 : year;
  const prevYY = String(prevYearIdx).slice(-2);
  const prevLabel = `${HEBREW_MONTHS[prevMonthIdx - 1]} ${prevYY}`;

  let monthSalaries = 0;
  let last7Salaries = 0;
  let prevMonthSalaries = 0;

  for (const it of salariesItems) {
    const ddCol = it.column_values.find((c: any) => c.id === DROPDOWN_MONTH_SALARIES);
    const ddLabel = (ddCol?.values?.[0]?.label || ddCol?.text || '').trim();
    const v = num(it.column_values.find((c: any) => c.id === FORMULA_SALARIES)?.display_value);
    const d = it.column_values.find((c: any) => c.id === DATE_COL_COMMISSIONS)?.date || '';

    if (ddLabel === monthLabel) monthSalaries += v;
    if (ddLabel === prevLabel) prevMonthSalaries += v;
    if (d) {
      const di = new Date(d + 'T00:00:00Z');
      if (di >= sevenDaysAgo && v > 0) last7Salaries += v;
    }
  }

  const monthTotal = monthCommissions + monthSalaries;
  const dayOfMonth = todayIsrael.getDate();
  const daysInMonth = new Date(year, month1, 0).getDate();
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth);
  const remainingNis = Math.max(0, MONTHLY_TARGET_NIS - monthTotal);
  const perDayNeeded = daysLeft > 0 ? remainingNis / daysLeft : 0;

  return {
    monthCommissions,
    monthSalaries,
    monthTotal,
    targetNis: MONTHLY_TARGET_NIS,
    progressPct: Math.round((monthTotal / MONTHLY_TARGET_NIS) * 100),
    daysInMonth,
    dayOfMonth,
    daysLeft,
    remainingNis,
    perDayNeeded,
    monthLabelHe: monthLabel,
    last7daysCommissions: last7Commissions,
    last7daysSalaries: last7Salaries,
    last7daysTotal: last7Commissions + last7Salaries,
    last7daysItemCount: last7Count,
    prevMonthCommissions,
    prevMonthSalaries,
    prevMonthTotal: prevMonthCommissions + prevMonthSalaries,
  };
}

async function fetchAllItems(boardId: number, columnIds: string[]): Promise<any[]> {
  const cols = columnIds.map(c => `"${c}"`).join(',');
  let cursor: string | null = null;
  const out: any[] = [];
  while (true) {
    const q: string = cursor === null
      ? `query { boards(ids: [${boardId}]) { items_page(limit: 200) { cursor items { id name created_at column_values(ids: [${cols}]) { id text ... on FormulaValue { display_value } ... on DateValue { date } ... on DropdownValue { values { label } } ... on StatusValue { label } } } } } }`
      : `query { next_items_page(cursor: "${cursor}", limit: 200) { cursor items { id name created_at column_values(ids: [${cols}]) { id text ... on FormulaValue { display_value } ... on DateValue { date } ... on DropdownValue { values { label } } ... on StatusValue { label } } } } }`;
    const data = await gqlFetch(q);
    const page: any = cursor === null ? data?.data?.boards?.[0]?.items_page : data?.data?.next_items_page;
    if (!page) break;
    out.push(...(page.items || []));
    cursor = page.cursor;
    if (!cursor) break;
  }
  return out;
}

function fmtNis(n: number): string {
  return '₪' + Math.round(n).toLocaleString('en-US');
}

// Meta WhatsApp templates reject \n and 4+ consecutive spaces in {{1}} — must be single-line with bullet separators.
const SEP = '  •  ';
export function formatWeeklyReport(t: CommissionTotals): string {
  const dateStr = todayInIsrael().toLocaleDateString('he-IL');
  const onTrack = t.progressPct >= (t.dayOfMonth / t.daysInMonth) * 100;
  const status = onTrack ? '✅ בקצב טוב' : '⚠️ צריך להאיץ';
  const parts = [
    `📊 דוח שבועי עמלות — ${t.monthLabelHe}`,
    `📅 ${dateStr} (יום ${t.dayOfMonth}/${t.daysInMonth})`,
    `🎯 יעד: ${fmtNis(t.targetNis)}`,
    `💰 הושג: ${fmtNis(t.monthTotal)} (${t.progressPct}%) ${status}`,
    `עמלות: ${fmtNis(t.monthCommissions)}`,
    `שכ״ט: ${fmtNis(t.monthSalaries)}`,
  ];
  if (t.last7daysTotal > 0) parts.push(`📈 השבוע: ${fmtNis(t.last7daysTotal)} (${t.last7daysItemCount} עסקאות)`);
  if (t.prevMonthTotal > 0) parts.push(`חודש קודם: ${fmtNis(t.prevMonthTotal)}`);
  parts.push(`🔥 חסר: ${fmtNis(t.remainingNis)} ב-${t.daysLeft} ימים = ${fmtNis(t.perDayNeeded)}/יום`);
  return parts.join(SEP);
}

// === WhatsApp send ===
async function sendWhatsApp(to: string, body: string): Promise<boolean> {
  if (!config.fbAccessToken) {
    log.warn('FB_ACCESS_TOKEN missing; skipping WhatsApp send');
    return false;
  }
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: body }],
        },
      ],
    },
  };
  try {
    const res = await fetch(`${GRAPH_API}/${DPRISHA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.fbAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json() as any;
    if (!res.ok || data.error) {
      log.error({ to, status: res.status, error: data.error }, 'WhatsApp send failed');
      return false;
    }
    log.info({ to, messages: data.messages?.length }, 'WhatsApp sent');
    return true;
  } catch (e: any) {
    log.error({ err: e.message, to }, 'WhatsApp send threw');
    return false;
  }
}

// === Weekly cron job: Friday 09:00 ===
export async function runWeeklyReport(): Promise<void> {
  log.info('weekly commission report starting');
  let totals: CommissionTotals;
  try {
    totals = await fetchCommissionTotals();
  } catch (e: any) {
    log.error({ err: e.message }, 'fetch totals failed');
    return;
  }

  const body = formatWeeklyReport(totals);
  log.info({ monthTotal: totals.monthTotal, pct: totals.progressPct }, 'weekly report computed');
  for (const phone of RECIPIENTS) {
    await sendWhatsApp(phone, body);
  }
}

// === Threshold alert: poll every 10 min for new commissions > 1500 ===
function ensureAlertTable(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS commission_alerts_sent (
    item_id TEXT PRIMARY KEY,
    amount REAL,
    alerted_at TEXT NOT NULL
  )`);
}
ensureAlertTable();

const stmtSeen = db.prepare('SELECT 1 FROM commission_alerts_sent WHERE item_id = ?');
const stmtMark = db.prepare('INSERT OR IGNORE INTO commission_alerts_sent (item_id, amount, alerted_at) VALUES (?, ?, ?)');

export async function checkNewCommissionsForAlerts(): Promise<void> {
  log.debug('checking new commissions for >1500 alerts');
  let items;
  try {
    items = await fetchAllItems(COMMISSIONS_BOARD_ID, [DATE_COL_COMMISSIONS, FORMULA_COMMISSIONS]);
  } catch (e: any) {
    log.error({ err: e.message }, 'fetch failed in alert check');
    return;
  }

  // Only consider items created in the last 7 days — old items can't suddenly cross threshold without webhook anyway
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();

  for (const it of items) {
    if (it.created_at < cutoff) continue;
    const amount = num(it.column_values.find((c: any) => c.id === FORMULA_COMMISSIONS)?.display_value);
    if (amount <= ALERT_THRESHOLD_NIS) continue;
    if (stmtSeen.get(it.id)) continue;

    const dateStr = (it.column_values.find((c: any) => c.id === DATE_COL_COMMISSIONS)?.date) || '';
    const link = `https://palm530671.monday.com/boards/${COMMISSIONS_BOARD_ID}/pulses/${it.id}`;
    const parts = [
      `💰 עמלה חדשה מעל ${fmtNis(ALERT_THRESHOLD_NIS)}`,
      `שם: ${it.name}`,
      `סכום: ${fmtNis(amount)}`,
    ];
    if (dateStr) parts.push(`תאריך: ${dateStr}`);
    parts.push(link);
    const body = parts.join(SEP);

    log.info({ itemId: it.id, name: it.name, amount }, 'sending threshold alert');
    let ok = true;
    for (const phone of RECIPIENTS) {
      const sent = await sendWhatsApp(phone, body);
      if (!sent) ok = false;
    }
    if (ok) stmtMark.run(it.id, amount, new Date().toISOString());
  }
}

// On first run: snapshot existing items as already-alerted (so we don't blast the historical board)
export function bootstrapAlertHistory(): void {
  ensureAlertTable();
  const seenAny = (db.prepare('SELECT COUNT(*) as c FROM commission_alerts_sent').get() as any).c > 0;
  if (seenAny) return;
  log.info('bootstrapping commission alert history (snapshot all current items as seen)');
  fetchAllItems(COMMISSIONS_BOARD_ID, [FORMULA_COMMISSIONS]).then(items => {
    const now = new Date().toISOString();
    const insert = db.prepare('INSERT OR IGNORE INTO commission_alerts_sent (item_id, amount, alerted_at) VALUES (?, ?, ?)');
    const tx = db.transaction((rows: any[]) => {
      for (const it of rows) {
        const amt = num(it.column_values.find((c: any) => c.id === FORMULA_COMMISSIONS)?.display_value);
        insert.run(it.id, amt, now);
      }
    });
    tx(items);
    log.info({ count: items.length }, 'bootstrapped commission alert history');
  }).catch(e => log.error({ err: e.message }, 'bootstrap failed'));
}
