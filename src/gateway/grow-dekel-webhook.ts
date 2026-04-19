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
  invoiceFile: "file_mm2g3bcb", // חשבונית Grow PDF
  initialPlanningPaid: "status48__1", // שולם עבור ת.ראשוני
};

// Map payment sum → label index in COLS.initialPlanningPaid
// 397 → 4, 547 → 6, 635 → 7  (per board settings 2026-04-19)
const INITIAL_PLANNING_LABEL: Record<number, number> = {
  397: 4,
  547: 6,
  635: 7,
};

const ALON_TG_CHAT = process.env.ALON_TG_CHAT_ID || "1584581543"; // @AliClawIsrael_bot private chat
const ALON_WA_PHONE = process.env.ALON_PHONE || "972546300783";
const DEKEL_WA_PHONE = process.env.DEKEL_PHONE || "972526252521"; // partner

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

// When multiple leads match (duplicates from Meta forms etc), pick the one
// updated most recently — that's the active record the user works on.
function pickMostRecent(items: any[]): string | null {
  if (!items?.length) return null;
  const sorted = [...items].sort((a, b) =>
    String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
  );
  return sorted[0].id;
}

async function findLeadItemId(
  phone: string,
  email: string,
  name: string,
): Promise<string | null> {
  const phoneCandidates = normalizePhone(phone);

  // Try each phone format. Pull up to 25 matches and pick the most recently
  // updated one, since duplicates are common (Meta form sync + manual entry).
  for (const p of phoneCandidates) {
    const q = `query { items_page_by_column_values(board_id: ${LEADS_BOARD_ID}, limit: 25, columns: [{column_id: "${COLS.phone}", column_values: ["${p}"]}]) { items { id name updated_at } } }`;
    const data = await mondayQuery(q);
    const items = data?.data?.items_page_by_column_values?.items || [];
    const itemId = pickMostRecent(items);
    if (itemId) {
      log.info(
        { phone: p, itemId, totalMatches: items.length },
        items.length > 1
          ? "lead matched by phone (picked most recent of duplicates)"
          : "lead matched by phone",
      );
      return itemId;
    }
  }

  // Fallback: email
  if (email) {
    const q = `query { items_page_by_column_values(board_id: ${LEADS_BOARD_ID}, limit: 25, columns: [{column_id: "${COLS.email}", column_values: ["${email.toLowerCase()}"]}]) { items { id name updated_at } } }`;
    const data = await mondayQuery(q);
    const items = data?.data?.items_page_by_column_values?.items || [];
    const itemId = pickMostRecent(items);
    if (itemId) {
      log.info(
        { email, itemId, totalMatches: items.length },
        "lead matched by email",
      );
      return itemId;
    }
  }

  // Fallback: name
  if (name) {
    const q = `query { items_page_by_column_values(board_id: ${LEADS_BOARD_ID}, limit: 25, columns: [{column_id: "name", column_values: ["${name.replace(/"/g, '\\"')}"]}]) { items { id name updated_at } } }`;
    const data = await mondayQuery(q);
    const items = data?.data?.items_page_by_column_values?.items || [];
    const itemId = pickMostRecent(items);
    if (itemId) {
      log.info(
        { name, itemId, totalMatches: items.length },
        "lead matched by name",
      );
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

async function getLeadName(itemId: string): Promise<string> {
  try {
    const q = `query { items(ids: [${itemId}]) { name } }`;
    const data = await mondayQuery(q);
    return data?.data?.items?.[0]?.name || "";
  } catch {
    return "";
  }
}

async function renameLead(itemId: string, newName: string): Promise<void> {
  const safe = newName.replace(/"/g, '\\"').slice(0, 200);
  const mutation = `mutation { change_simple_column_value(board_id: ${LEADS_BOARD_ID}, item_id: ${itemId}, column_id: "name", value: "${safe}") { id } }`;
  const res = await mondayQuery(mutation);
  if (res.errors)
    log.warn({ errors: res.errors, itemId, newName }, "monday rename failed");
  else log.info({ itemId, newName }, "lead renamed");
}

async function updateLeadPayment(itemId: string, tx: any): Promise<void> {
  const sum = Number(tx.paymentSum ?? tx.sum ?? 0);
  const values: Record<string, any> = {
    [COLS.paidStatus]: { label: "שולם" },
    [COLS.paymentSum]: String(tx.paymentSum ?? ""),
    [COLS.asmachta]: String(tx.asmachta ?? tx.transactionCode ?? ""),
    [COLS.paymentDate]: { date: toIsoDate(tx.paymentDate) },
    [COLS.paymentDesc]: String(tx.paymentDesc ?? "").slice(0, 200),
  };

  // Auto-mark "שולם עבור ת.ראשוני" if amount matches initial-planning tier
  const planningLabelIdx = INITIAL_PLANNING_LABEL[sum];
  if (planningLabelIdx !== undefined) {
    values[COLS.initialPlanningPaid] = { index: planningLabelIdx };
    log.info(
      { itemId, sum, labelIdx: planningLabelIdx },
      "auto-marking initial-planning paid",
    );
  }

  const valuesJson = JSON.stringify(JSON.stringify(values));
  const mutation = `mutation { change_multiple_column_values(board_id: ${LEADS_BOARD_ID}, item_id: ${itemId}, column_values: ${valuesJson}, create_labels_if_missing: true) { id } }`;
  const res = await mondayQuery(mutation);
  if (res.errors)
    log.warn({ errors: res.errors, itemId }, "monday update failed");
}

async function tryDownloadPdf(
  url: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      log.warn({ url, status: res.status }, "invoice fetch failed");
      return null;
    }
    const contentType = res.headers.get("content-type") || "";
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    // Check for PDF magic bytes (%PDF)
    if (buf.slice(0, 4).toString() !== "%PDF" && !contentType.includes("pdf")) {
      log.warn(
        { url, contentType, firstBytes: buf.slice(0, 20).toString("hex") },
        "invoice URL did not return PDF (likely auth page)",
      );
      return null;
    }
    return { buffer: buf, contentType };
  } catch (e: any) {
    log.warn({ err: e.message }, "invoice download error");
    return null;
  }
}

async function uploadPdfToMondayFileColumn(
  itemId: string,
  columnId: string,
  pdf: Buffer,
  filename: string,
): Promise<boolean> {
  if (!config.mondayApiKey) return false;
  try {
    const form = new FormData();
    const query = `mutation ($file: File!) { add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) { id } }`;
    form.append("query", query);
    form.append("map", '{"fileToUpload":"variables.file"}');
    form.append(
      "fileToUpload",
      new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      filename,
    );
    const res = await fetch("https://api.monday.com/v2/file", {
      method: "POST",
      headers: { Authorization: config.mondayApiKey, "API-Version": "2024-01" },
      body: form as any,
    });
    const data: any = await res.json();
    if (data.errors) {
      log.warn({ errors: data.errors }, "file upload failed");
      return false;
    }
    return Boolean(data?.data?.add_file_to_column?.id);
  } catch (e: any) {
    log.warn({ err: e.message }, "file upload error");
    return false;
  }
}

// Attach a file to a Monday Update (the conversation thread on a lead).
// Different mutation than file-column upload — uses add_file_to_update.
async function uploadPdfToUpdate(
  updateId: string,
  pdf: Buffer,
  filename: string,
): Promise<boolean> {
  if (!config.mondayApiKey) return false;
  try {
    const form = new FormData();
    form.append(
      "query",
      `mutation ($file: File!) { add_file_to_update(update_id: ${updateId}, file: $file) { id } }`,
    );
    form.append("map", '{"fileToUpload":"variables.file"}');
    form.append(
      "fileToUpload",
      new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      filename,
    );
    const res = await fetch("https://api.monday.com/v2/file", {
      method: "POST",
      headers: { Authorization: config.mondayApiKey, "API-Version": "2024-01" },
      body: form as any,
    });
    const data: any = await res.json();
    return Boolean(data?.data?.add_file_to_update?.id);
  } catch (e: any) {
    log.warn({ err: e.message }, "update file upload error");
    return false;
  }
}

async function attachInvoice(
  itemId: string,
  invoiceUrl: string,
  invoiceNumber: string,
): Promise<{ fileUploaded: boolean }> {
  // Save link + number to columns (always — even if PDF download fails)
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

  // Try download + upload PDF
  let fileUploaded = false;
  let pdfBuf: Buffer | null = null;
  const pdfData = await tryDownloadPdf(invoiceUrl);
  if (pdfData) {
    pdfBuf = pdfData.buffer;
    const filename = `חשבונית-${invoiceNumber || "grow"}.pdf`;
    fileUploaded = await uploadPdfToMondayFileColumn(
      itemId,
      COLS.invoiceFile,
      pdfBuf,
      filename,
    );
    log.info({ itemId, invoiceNumber, fileUploaded }, "PDF upload result");
  }

  // Always create an Update on the lead. Attach the PDF to it as well so
  // it's visible inline in the conversation thread (not just under Files).
  const updateBody = fileUploaded
    ? `🧾 חשבונית ${invoiceNumber || ""} הועלתה — מצורפת כאן ושמורה גם בעמודת Files של הליד.\\nקישור Meshulam: ${invoiceUrl}`
    : `🧾 חשבונית ${invoiceNumber || ""} (לינק בלבד — PDF לא נגיש ללא login): ${invoiceUrl}`;
  const updateRes = await mondayQuery(
    `mutation { create_update(item_id: ${itemId}, body: "${updateBody.replace(/"/g, '\\"')}") { id } }`,
  );
  const updateId: string | undefined = updateRes?.data?.create_update?.id;
  if (updateId && pdfBuf) {
    await uploadPdfToUpdate(
      updateId,
      pdfBuf,
      `חשבונית-${invoiceNumber || "grow"}.pdf`,
    );
  }

  return { fileUploaded };
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

// Send WhatsApp text via Cloud API. Returns true on accepted send.
// Tries each (token, phoneId) pair until one succeeds. Used to notify Alon.
async function sendWhatsAppText(
  to: string,
  text: string,
  channels: Array<{ token: string; phoneId: string; label: string }>,
): Promise<boolean> {
  for (const ch of channels) {
    if (!ch.token || !ch.phoneId) continue;
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${ch.phoneId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ch.token}`,
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body: text, preview_url: true },
          }),
        },
      );
      const data: any = await res.json().catch(() => ({}));
      if (res.ok && data?.messages?.[0]?.id) {
        log.info(
          { channel: ch.label, to, msgId: data.messages[0].id },
          "whatsapp sent",
        );
        return true;
      }
      log.warn(
        {
          channel: ch.label,
          to,
          status: res.status,
          err: data?.error?.message || data?.error?.code || "no msg id",
        },
        "whatsapp send rejected — trying next channel",
      );
    } catch (e: any) {
      log.warn({ channel: ch.label, err: e.message }, "whatsapp send error");
    }
  }
  return false;
}

// Notify Alon via WhatsApp. Try Alon.dev first (he chats with it daily, so
// the 24h customer-message window stays open), then fall back to Dekel.
async function sendWhatsAppCloud(text: string): Promise<void> {
  await sendWhatsAppText(ALON_WA_PHONE, text, [
    {
      token: config.waCloudToken2,
      phoneId: config.waCloudPhoneId2,
      label: "alon-dev",
    },
    {
      token: config.waCloudToken,
      phoneId: config.waCloudPhoneId,
      label: "dekel",
    },
  ]);
}

// Send a WhatsApp template via Dekel's Cloud API number. Templates bypass
// the 24h customer-message window so they always deliver — this is the
// primary notification channel for payment events.
async function sendWaTemplate(args: {
  to: string;
  templateName: string;
  parameters: string[];
}): Promise<boolean> {
  const token = config.waCloudToken;
  const phoneId = config.waCloudPhoneId;
  if (!token || !phoneId) return false;
  const body = {
    messaging_product: "whatsapp",
    to: args.to,
    type: "template",
    template: {
      name: args.templateName,
      language: { code: "he" },
      components: [
        {
          type: "body",
          parameters: args.parameters.map((t) => ({
            type: "text",
            text: String(t).slice(0, 60),
          })),
        },
      ],
    },
  };
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${phoneId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.messages?.[0]?.id) {
      log.info(
        {
          template: args.templateName,
          to: args.to,
          msgId: data.messages[0].id,
        },
        "WA template sent",
      );
      return true;
    }
    log.warn(
      {
        template: args.templateName,
        to: args.to,
        status: res.status,
        err: data?.error?.message || data?.error?.code,
      },
      "WA template send failed",
    );
  } catch (e: any) {
    log.warn(
      { template: args.templateName, err: e.message },
      "WA template send error",
    );
  }
  return false;
}

async function sendGrowPaymentAlertTemplate(args: {
  fullName: string;
  paymentSum: string | number;
  paymentDesc: string;
  mondayStatus: string;
}): Promise<boolean> {
  return sendWaTemplate({
    to: ALON_WA_PHONE,
    templateName: "grow_payment_alert",
    parameters: [
      args.fullName || "—",
      String(args.paymentSum),
      args.paymentDesc || "תכנון",
      args.mondayStatus,
    ],
  });
}

// Notify Dekel (the partner) via his own template. Doesn't mention Telegram
// since Dekel doesn't use the Telegram bot. Template is PENDING Meta review
// until approved — sends will fail silently with a 132xxx error and we log
// the rejection. Once approved, this starts working automatically.
async function sendDekelPaymentAlert(args: {
  fullName: string;
  paymentSum: string | number;
  paymentDesc: string;
}): Promise<boolean> {
  return sendWaTemplate({
    to: DEKEL_WA_PHONE,
    templateName: "grow_payment_alert_dekel",
    parameters: [
      args.fullName || "—",
      String(args.paymentSum),
      args.paymentDesc || "תכנון",
    ],
  });
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

      // Debug mode: process synchronously and return result (query ?debug=1)
      if (req.query?.debug === "1") {
        try {
          const result = await processWebhook(data);
          res.status(200).json({ ok: true, debug: true, result });
        } catch (e: any) {
          res
            .status(500)
            .json({ ok: false, debug: true, error: e.message, stack: e.stack });
        }
        return;
      }

      res.status(200).json({ ok: true }); // ACK fast — Grow may retry otherwise

      // Process async after ACK
      setImmediate(() =>
        processWebhook(data).catch((e) =>
          log.error({ err: e.message, stack: e.stack }, "processing failed"),
        ),
      );
    } catch (e: any) {
      log.error({ err: e.message }, "grow-dekel webhook error");
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  log.info("registered POST /api/grow-dekel-webhook");
}

async function processWebhook(data: any): Promise<any> {
  const transactionCode: string = data.transactionCode || "";

  // Invoice event — has invoiceUrl
  if (data.invoiceUrl) {
    return await handleInvoice(data);
  }

  // Transaction event
  const txResult = await handleTransaction(data);

  // Safety net: some Grow accounts send invoice in same payload
  if (data.invoiceUrl) await handleInvoice(data);
  return txResult;
}

async function handleTransaction(tx: any): Promise<any> {
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
  let lookupError: string | null = null;
  try {
    itemId = await findLeadItemId(payerPhone, payerEmail, fullName);
    if (itemId) {
      // If lead row was created with a placeholder name (common when Meta
      // form sync ran without name), replace with the payer's real name so
      // it shows up in Monday search.
      if (fullName) {
        const currentName = await getLeadName(itemId);
        const placeholders = ["unknown", "Unknown", "—", "-", "N/A", ""];
        if (placeholders.includes((currentName || "").trim())) {
          await renameLead(itemId, fullName);
        }
      }
      await updateLeadPayment(itemId, tx);
    } else {
      log.warn(
        { payerPhone, payerEmail, fullName },
        "no matching lead found in Monday",
      );
    }
  } catch (e: any) {
    lookupError = `${e.message}\n${e.stack}`;
    log.error(
      { err: e.message, stack: e.stack },
      "monday lookup/update failed",
    );
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

  // WhatsApp via approved `grow_payment_alert` template (UTILITY, he).
  // Templates bypass the 24h customer-message window so they always deliver.
  const templateOk = await sendGrowPaymentAlertTemplate({
    fullName,
    paymentSum,
    paymentDesc,
    mondayStatus: itemId
      ? `עודכן בהצלחה - https://alonr-7280s-projects.monday.com/boards/${LEADS_BOARD_ID}/pulses/${itemId}`
      : `לא נמצא ליד לפי ${payerPhone}`,
  });
  // Notify Dekel (partner) on every payment via his own template.
  await sendDekelPaymentAlert({ fullName, paymentSum, paymentDesc });
  // If alon's template fails for any reason, try free-form text via Alon.dev/Dekel as fallback.
  if (!templateOk) {
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

  return { itemId, transactionCode, lookupError, payerPhone, fullName };
}

async function handleInvoice(inv: any): Promise<any> {
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
    const { fileUploaded } = await attachInvoice(
      row.monday_item_id,
      invoiceUrl,
      invoiceNumber,
    );
    db.prepare(
      `UPDATE grow_dekel_transactions SET invoice_url = ?, invoice_number = ?, updated_at = datetime('now', '+3 hours') WHERE transaction_code = ?`,
    ).run(invoiceUrl, invoiceNumber, transactionCode);

    const statusLine = fileUploaded
      ? "📎 PDF הועלה לליד"
      : "🔗 לינק לליד (PDF דורש login)";
    await sendTelegram(
      `🧾 חשבונית ${invoiceNumber} לליד של *${row.full_name}*\n${statusLine}`,
      { label: "פתח חשבונית", url: invoiceUrl },
    );
    return { fileUploaded };
  } catch (e: any) {
    log.error({ err: e.message, transactionCode }, "attach invoice failed");
  }
}
