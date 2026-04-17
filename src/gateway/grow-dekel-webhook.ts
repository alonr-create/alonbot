// Grow webhook for Dekel L'Prisha — transactions + invoices
// Separate from /api/grow-webhook (Alon.dev orders) to avoid cross-contamination.
//
// Flow:
//   1. Transaction webhook arrives → notify Alon (WhatsApp + Telegram) → search Monday
//      lead by phone → update payment columns → cache itemId by transactionCode.
//   2. Invoice webhook arrives (seconds later) → look up cached itemId by transactionCode
//      → attach invoiceUrl + invoiceNumber to same lead.

import type { Express, Request, Response } from "express";
import crypto from "crypto";
import { db } from "../utils/db.js";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("grow-dekel-webhook");

// ── DB ──
db.exec(`
  CREATE TABLE IF NOT EXISTS grow_dekel_transactions (
    transaction_code TEXT PRIMARY KEY,
    monday_item_id TEXT,
    payer_phone TEXT,
    payer_email TEXT,
    full_name TEXT,
    payment_sum REAL,
    asmachta TEXT,
    payment_desc TEXT,
    payment_date TEXT,
    invoice_url TEXT,
    invoice_number TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+3 hours')),
    updated_at TEXT
  );
`);

// Monday.com — leads board for Dekel
const LEADS_BOARD_ID = 1443236269;
const COLS = {
  phone: "phone",
  email: "email",
  paidStatus: "color_mm2g554q", // שילם דרך Grow
  paymentSum: "numeric_mm2g7mxp", // סכום תשלום Grow
  asmachta: "text_mm2gge0k", // אסמכתא Grow
  paymentDate: "date_mm2g3bjh", // תאריך תשלום Grow
  paymentDesc: "text_mm2gxpcy", // תיאור שירות Grow
  invoiceUrl: "link_mm2gh2mr", // חשבונית Grow (link)
  invoiceNumber: "text_mm2gb630", // מספר חשבונית Grow
};

const ALON_TG_CHAT = "546585625";
const ALON_WA_PHONE = process.env.ALON_PHONE || "972559566148";

// ── helpers ──
function normalizePhone(raw: string): string[] {
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  const candidates = new Set<string>();
  candidates.add(digits);
  if (digits.startsWith("972")) {
    candidates.add("0" + digits.slice(3));
    candidates.add(digits.slice(3));
  } else if (digits.startsWith("0")) {
    candidates.add(digits.slice(1));
    candidates.add("972" + digits.slice(1));
  } else if (digits.length === 9) {
    candidates.add("0" + digits);
    candidates.add("972" + digits);
  }
  return [...candidates].filter(Boolean);
}

async function mondayQuery(query: string): Promise<any> {
  if (!config.mondayApiKey) throw new Error("MONDAY_API_KEY not configured");
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.mondayApiKey,
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query }),
  });
  const data: any = await res.json();
  if (data.errors)
    log.warn({ errors: data.errors, q: query.slice(0, 100) }, "monday error");
  return data;
}

async function findLeadItemId(
  phone: string,
  email: string,
  name: string,
): Promise<string | null> {
  const phoneCandidates = normalizePhone(phone);

  // Try each phone format
  for (const p of phoneCandidates) {
    const q = `query { items_page_by_column_values(board_id: ${LEADS_BOARD_ID}, limit: 1, columns: [{column_id: "${COLS.phone}", column_values: ["${p}"]}]) { items { id name } } }`;
    const data = await mondayQuery(q);
    const itemId = data?.data?.items_page_by_column_values?.items?.[0]?.id;
    if (itemId) {
      log.info({ phone: p, itemId }, "lead matched by phone");
      return itemId;
    }
  }

  // Fallback: email
  if (email) {
    const q = `query { items_page_by_column_values(board_id: ${LEADS_BOARD_ID}, limit: 1, columns: [{column_id: "${COLS.email}", column_values: ["${email.toLowerCase()}"]}]) { items { id name } } }`;
    const data = await mondayQuery(q);
    const itemId = data?.data?.items_page_by_column_values?.items?.[0]?.id;
    if (itemId) {
      log.info({ email, itemId }, "lead matched by email");
      return itemId;
    }
  }

  // Fallback: name
  if (name) {
    const q = `query { items_page_by_column_values(board_id: ${LEADS_BOARD_ID}, limit: 1, columns: [{column_id: "name", column_values: ["${name.replace(/"/g, '\\"')}"]}]) { items { id name } } }`;
    const data = await mondayQuery(q);
    const itemId = data?.data?.items_page_by_column_values?.items?.[0]?.id;
    if (itemId) {
      log.info({ name, itemId }, "lead matched by name");
      return itemId;
    }
  }

  return null;
}

function toIsoDate(raw: string): string {
  if (!raw) return new Date().toISOString().slice(0, 10);
  const m = raw.match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    let yy = m[3];
    if (yy.length === 2) yy = "20" + yy;
    return `${yy}-${mm}-${dd}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

async function updateLeadPayment(itemId: string, tx: any): Promise<void> {
  const values: Record<string, any> = {
    [COLS.paidStatus]: { label: "שולם" },
    [COLS.paymentSum]: String(tx.paymentSum ?? ""),
    [COLS.asmachta]: String(tx.asmachta ?? tx.transactionCode ?? ""),
    [COLS.paymentDate]: { date: toIsoDate(tx.paymentDate) },
    [COLS.paymentDesc]: String(tx.paymentDesc ?? "").slice(0, 200),
  };
  const valuesJson = JSON.stringify(JSON.stringify(values));
  const mutation = `mutation { change_multiple_column_values(board_id: ${LEADS_BOARD_ID}, item_id: ${itemId}, column_values: ${valuesJson}, create_labels_if_missing: true) { id } }`;
  const res = await mondayQuery(mutation);
  if (res.errors)
    log.warn({ errors: res.errors, itemId }, "monday update failed");
}

async function attachInvoice(
  itemId: string,
  invoiceUrl: string,
  invoiceNumber: string,
): Promise<void> {
  const linkValue = {
    url: invoiceUrl,
    text: `חשבונית ${invoiceNumber || ""}`.trim(),
  };
  const values: Record<string, any> = {
    [COLS.invoiceUrl]: linkValue,
    [COLS.invoiceNumber]: String(invoiceNumber || ""),
  };
  const valuesJson = JSON.stringify(JSON.stringify(values));
  const mutation = `mutation { change_multiple_column_values(board_id: ${LEADS_BOARD_ID}, item_id: ${itemId}, column_values: ${valuesJson}) { id } }`;
  await mondayQuery(mutation);

  await mondayQuery(
    `mutation { create_update(item_id: ${itemId}, body: "🧾 חשבונית ${invoiceNumber || ""}: ${invoiceUrl}") { id } }`,
  );
}

async function sendTelegram(
  text: string,
  inlineUrl?: { label: string; url: string },
): Promise<void> {
  if (!config.telegramBotToken) return;
  const body: any = {
    chat_id: ALON_TG_CHAT,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  if (inlineUrl) {
    body.reply_markup = {
      inline_keyboard: [[{ text: inlineUrl.label, url: inlineUrl.url }]],
    };
  }
  try {
    await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
  } catch (e: any) {
    log.warn({ err: e.message }, "telegram send failed");
  }
}

async function sendWhatsAppCloud(text: string): Promise<void> {
  const token = config.waCloudToken;
  const phoneId = config.waCloudPhoneId;
  if (!token || !phoneId) return;
  try {
    await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: ALON_WA_PHONE,
        type: "text",
        text: { body: text, preview_url: true },
      }),
    });
  } catch (e: any) {
    log.warn({ err: e.message }, "whatsapp send failed");
  }
}

function verifyWebhookAuth(req: Request): boolean {
  const secret = process.env.GROW_DEKEL_WEBHOOK_SECRET;
  if (!secret) return true; // unprotected mode — warn-only

  const incoming =
    (req.headers["x-webhook-token"] as string) ||
    (req.query?.token as string) ||
    (req.body?.webhookKey as string) ||
    "";
  if (!incoming) return false;
  const a = Buffer.from(incoming);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── route registration ──
export function registerGrowDekelWebhook(app: Express): void {
  app.post("/api/grow-dekel-webhook", async (req: Request, res: Response) => {
    try {
      if (!verifyWebhookAuth(req)) {
        log.warn({ ip: req.ip }, "unauthorized grow-dekel webhook");
        res.status(401).json({ ok: false });
        return;
      }

      const data = req.body || {};
      log.info(
        { keys: Object.keys(data), transactionCode: data.transactionCode },
        "grow-dekel webhook received",
      );

      res.status(200).json({ ok: true }); // ACK fast — Grow may retry otherwise

      // Process async after ACK
      setImmediate(() =>
        processWebhook(data).catch((e) =>
          log.error({ err: e.message }, "processing failed"),
        ),
      );
    } catch (e: any) {
      log.error({ err: e.message }, "grow-dekel webhook error");
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  log.info("registered POST /api/grow-dekel-webhook");
}

async function processWebhook(data: any): Promise<void> {
  const transactionCode: string = data.transactionCode || "";

  // Invoice event — has invoiceUrl
  if (data.invoiceUrl) {
    await handleInvoice(data);
    return;
  }

  // Transaction event
  await handleTransaction(data);

  // Safety net: some Grow accounts send invoice in same payload
  if (data.invoiceUrl) await handleInvoice(data);
}

async function handleTransaction(tx: any): Promise<void> {
  const transactionCode = tx.transactionCode || "";
  const fullName = tx.fullName || "";
  const payerPhone = tx.payerPhone || "";
  const payerEmail = tx.payerEmail || "";
  const paymentSum = tx.paymentSum || tx.sum || 0;
  const asmachta = tx.asmachta || "";
  const paymentDesc = tx.paymentDesc || "";

  log.info(
    { transactionCode, fullName, payerPhone, paymentSum },
    "transaction received",
  );

  // Monday lookup + update
  let itemId: string | null = null;
  try {
    itemId = await findLeadItemId(payerPhone, payerEmail, fullName);
    if (itemId) {
      await updateLeadPayment(itemId, tx);
    } else {
      log.warn(
        { payerPhone, payerEmail, fullName },
        "no matching lead found in Monday",
      );
    }
  } catch (e: any) {
    log.error({ err: e.message }, "monday lookup/update failed");
  }

  // Persist for invoice bridging
  try {
    db.prepare(
      `INSERT OR REPLACE INTO grow_dekel_transactions
      (transaction_code, monday_item_id, payer_phone, payer_email, full_name, payment_sum, asmachta, payment_desc, payment_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transactionCode,
      itemId,
      payerPhone,
      payerEmail,
      fullName,
      paymentSum,
      asmachta,
      paymentDesc,
      tx.paymentDate || "",
    );
  } catch (e: any) {
    log.error({ err: e.message }, "db insert failed");
  }

  // Notifications
  const monEmoji = itemId ? "✅" : "⚠️";
  const monLine = itemId
    ? `${monEmoji} עודכן בלידים (item ${itemId})`
    : `${monEmoji} לא נמצא ליד במאנדיי לפי ${payerPhone}`;

  const tgText =
    `💰 *תשלום נכנס — Grow*\n\n` +
    `👤 ${fullName}\n` +
    `📱 ${payerPhone}\n` +
    `📧 ${payerEmail}\n` +
    `💵 ₪${paymentSum}\n` +
    `🧾 אסמכתא: ${asmachta}\n` +
    `📝 ${paymentDesc}\n\n` +
    monLine;

  const itemUrl = itemId
    ? `https://alonr-7280s-projects.monday.com/boards/${LEADS_BOARD_ID}/pulses/${itemId}`
    : "";
  await sendTelegram(
    tgText,
    itemId ? { label: "👁 פתח ליד", url: itemUrl } : undefined,
  );

  const waText =
    `💰 תשלום נכנס - Grow\n\n` +
    `${fullName} | ${payerPhone}\n` +
    `₪${paymentSum} | אסמכתא ${asmachta}\n` +
    `${paymentDesc}\n\n` +
    (itemId
      ? `✅ עודכן בלידים\n${itemUrl}`
      : `⚠️ לא נמצא ליד — יש להוסיף ידנית`);
  await sendWhatsAppCloud(waText);
}

async function handleInvoice(inv: any): Promise<void> {
  const transactionCode = inv.transactionCode || "";
  const invoiceUrl = inv.invoiceUrl || "";
  const invoiceNumber = inv.invoiceNumber || "";

  log.info({ transactionCode, invoiceNumber, invoiceUrl }, "invoice received");

  // Look up cached transaction
  const row: any = db
    .prepare(
      `SELECT monday_item_id, full_name FROM grow_dekel_transactions WHERE transaction_code = ?`,
    )
    .get(transactionCode);

  if (!row?.monday_item_id) {
    log.warn(
      { transactionCode },
      "invoice received but no matching transaction cached",
    );
    // Still notify — user can attach manually
    await sendTelegram(
      `🧾 חשבונית ${invoiceNumber} התקבלה אבל לא נמצאה עסקה תואמת (code: ${transactionCode})\n${invoiceUrl}`,
    );
    return;
  }

  try {
    await attachInvoice(row.monday_item_id, invoiceUrl, invoiceNumber);
    db.prepare(
      `UPDATE grow_dekel_transactions SET invoice_url = ?, invoice_number = ?, updated_at = datetime('now', '+3 hours') WHERE transaction_code = ?`,
    ).run(invoiceUrl, invoiceNumber, transactionCode);

    await sendTelegram(
      `🧾 חשבונית ${invoiceNumber} צורפה לליד של *${row.full_name}*`,
      { label: "פתח חשבונית", url: invoiceUrl },
    );
  } catch (e: any) {
    log.error({ err: e.message, transactionCode }, "attach invoice failed");
  }
}
