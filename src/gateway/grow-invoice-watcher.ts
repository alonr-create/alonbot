// Watches alonra@gmail.com for new Grow invoice emails.
// When an email arrives with PDF attachment from @grow.security,
// extract transaction details, match to a transaction in our SQLite bridge table,
// upload the PDF to the matching Monday lead's file column.

import { ImapFlow } from "imapflow";
// @ts-ignore - mailparser lacks types; we only use simpleParser runtime
import { simpleParser } from "mailparser";
import { db } from "../utils/db.js";
import { config } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("grow-invoice-watcher");

const LEADS_BOARD_ID = 1443236269;
const INVOICE_FILE_COL = "file_mm2g3bcb";
const INVOICE_URL_COL = "link_mm2gh2mr";
const INVOICE_NUMBER_COL = "text_mm2gb630";

db.exec(`
  CREATE TABLE IF NOT EXISTS grow_imap_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_uid INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+3 hours'))
  );
  INSERT OR IGNORE INTO grow_imap_state (id, last_uid) VALUES (1, 0);
`);

function getLastUid(): number {
  const row: any = db
    .prepare(`SELECT last_uid FROM grow_imap_state WHERE id = 1`)
    .get();
  return row?.last_uid || 0;
}
function setLastUid(uid: number): void {
  db.prepare(
    `UPDATE grow_imap_state SET last_uid = ?, updated_at = datetime('now', '+3 hours') WHERE id = 1`,
  ).run(uid);
}

// Extract transaction details from Grow HTML email
function extractFromHtml(html: string): {
  asmachta?: string;
  fullName?: string;
  payerPhone?: string;
  paymentSum?: string;
  invoiceNumber?: string;
  invoiceUrl?: string;
} {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const out: any = {};
  const asmachta = text.match(/אסמכתא[:\s]*(\d+)/);
  if (asmachta) out.asmachta = asmachta[1];
  const sum = text.match(/(\d[\d,]*\.?\d*)\s*ש["״]?ח|₪\s*(\d[\d,]*\.?\d*)/);
  if (sum) out.paymentSum = (sum[1] || sum[2]).replace(/,/g, "");
  const name = text.match(/שם:\s*([^\s](?:[^\n]{0,50}?))\s+(?:טלפון|מייל)/);
  if (name) out.fullName = name[1].trim();
  const phone = text.match(/טלפון:\s*(\d[\d\-+]*)/);
  if (phone) out.payerPhone = phone[1].replace(/[^\d+]/g, "");
  const invNum =
    text.match(/חשבונית\s*(?:מס)?[.:#\s]*(\d+)/i) ||
    text.match(/עסקה\s+(\d+)/i);
  if (invNum) out.invoiceNumber = invNum[1];

  // Find candidate invoice URLs. Grow emails embed many image URLs (logos,
  // mail decorations) on the same domains, so we filter image extensions
  // and prefer URLs that contain /openInvoice or /api/invoice.
  const allUrls = [
    ...html.matchAll(
      /https?:\/\/[^\s"'<>]*(?:meshulam\.co\.il|grow\.link|grow\.website|grow\.business)[^\s"'<>]*/gi,
    ),
  ].map((m) => m[0]);
  const isImage = (u: string) =>
    /\.(png|jpg|jpeg|gif|svg|webp|ico)(\?|$)/i.test(u);
  const candidates = allUrls.filter((u) => !isImage(u));
  const preferred =
    candidates.find((u) => /openInvoice/i.test(u)) ||
    candidates.find((u) => /\/api\/invoice/i.test(u)) ||
    candidates.find((u) => /receipt|חשבונית/i.test(u)) ||
    candidates[0];
  if (preferred) out.invoiceUrl = preferred;
  return out;
}

// Download bytes from a URL, return PDF buffer if response is actually a PDF.
async function tryDownloadPdf(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      log.warn({ url, status: res.status }, "invoice URL fetch failed");
      return null;
    }
    const ct = res.headers.get("content-type") || "";
    const arr = await res.arrayBuffer();
    const buf = Buffer.from(arr);
    if (buf.slice(0, 4).toString() === "%PDF" || ct.includes("pdf")) return buf;
    log.warn(
      { url, contentType: ct, firstBytes: buf.slice(0, 8).toString("hex") },
      "URL did not return PDF",
    );
    return null;
  } catch (e: any) {
    log.warn({ url, err: e.message }, "PDF download error");
    return null;
  }
}

async function mondayQuery(query: string): Promise<any> {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: config.mondayApiKey,
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query }),
  });
  return await res.json();
}

function normalizePhone(raw: string): string[] {
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  const s = new Set<string>([digits]);
  if (digits.startsWith("972")) {
    s.add("0" + digits.slice(3));
    s.add(digits.slice(3));
  } else if (digits.startsWith("0")) {
    s.add(digits.slice(1));
    s.add("972" + digits.slice(1));
  }
  return [...s].filter(Boolean);
}

async function findLeadByDetails(
  phone: string,
  asmachta: string,
): Promise<string | null> {
  // 1. Try SQLite cache (from previous transaction webhook)
  if (asmachta) {
    const row: any = db
      .prepare(
        `SELECT monday_item_id FROM grow_dekel_transactions WHERE asmachta = ? AND monday_item_id IS NOT NULL`,
      )
      .get(asmachta);
    if (row?.monday_item_id) return row.monday_item_id;
  }
  // 2. Search Monday by phone — pick most recently updated when duplicates exist
  if (!config.mondayApiKey) return null;
  for (const p of normalizePhone(phone)) {
    const q = `query { items_page_by_column_values(board_id: ${LEADS_BOARD_ID}, limit: 25, columns: [{column_id: "phone", column_values: ["${p}"]}]) { items { id updated_at } } }`;
    const data = await mondayQuery(q);
    const items: any[] = data?.data?.items_page_by_column_values?.items || [];
    if (items.length === 0) continue;
    const sorted = [...items].sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
    return sorted[0].id;
  }
  return null;
}

async function uploadPdfToMonday(
  itemId: string,
  pdf: Buffer,
  filename: string,
): Promise<boolean> {
  if (!config.mondayApiKey) return false;
  try {
    const form = new FormData();
    form.append(
      "query",
      `mutation ($file: File!) { add_file_to_column(item_id: ${itemId}, column_id: "${INVOICE_FILE_COL}", file: $file) { id } }`,
    );
    form.append("map", '{"fileToUpload":"variables.file"}');
    form.append(
      "fileToUpload",
      new Blob([new Uint8Array(pdf)], { type: "application/pdf" }),
      filename,
    );
    const res = await fetch("https://api.monday.com/v2/file", {
      method: "POST",
      headers: { Authorization: config.mondayApiKey },
      body: form as any,
    });
    const data: any = await res.json();
    return Boolean(data?.data?.add_file_to_column?.id);
  } catch (e: any) {
    log.warn({ err: e.message }, "monday PDF upload failed");
    return false;
  }
}

async function sendTelegram(text: string): Promise<void> {
  if (!config.telegramBotToken) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.ALON_TG_CHAT_ID || "1584581543",
          text,
          parse_mode: "Markdown",
        }),
      },
    );
  } catch {}
}

async function processMessage(c: any, uid: number): Promise<void> {
  const msg = await c.fetchOne(uid, { envelope: true, source: true });
  const fromAddr = msg.envelope.from?.[0]?.address || "";
  const subject = msg.envelope.subject || "";

  log.info({ uid, from: fromAddr, subject }, "processing Grow email");

  // Grow sends 2 emails per payment: support@grow.security (payment notice,
  // invoiceUrl is just "https://grow.business") and invoice@grow.security
  // (the real invoice with openInvoice URL serving the PDF). Only act on
  // the invoice email; the support one would just write a bad placeholder
  // URL and 403 on download.
  if (!fromAddr.toLowerCase().includes("invoice@grow.security")) {
    log.info({ uid, from: fromAddr }, "skipping non-invoice Grow email");
    return;
  }

  // Parse full email with attachments
  const parsed: any = await simpleParser(msg.source);
  const pdfAtt = (parsed.attachments || []).find(
    (a: any) =>
      a.contentType?.includes("pdf") ||
      a.filename?.toLowerCase().endsWith(".pdf"),
  );

  const html = parsed.html || "";
  const details = extractFromHtml(typeof html === "string" ? html : "");

  // The invoice email subject contains the invoice number even when the
  // body extractor missed it (e.g. "...עבור עסקה 41035 ב- ...").
  if (!details.invoiceNumber) {
    const subjMatch = subject.match(/עסקה\s+(\d+)/);
    if (subjMatch) details.invoiceNumber = subjMatch[1];
  }

  log.info({ uid, hasPdf: Boolean(pdfAtt), details }, "extracted details");

  // Find matching lead. Tries (in order): asmachta cache → phone search →
  // invoice_number cache (set by webhook flow). The invoice email itself
  // usually has neither phone nor asmachta — only invoice number + URL.
  let itemId = await findLeadByDetails(
    details.payerPhone || "",
    details.asmachta || "",
  );
  let matchSource: string = itemId ? "phone-or-asmachta" : "";

  // Match by invoice_number cached from webhook (handleInvoice in
  // grow-dekel-webhook.ts writes the number when the JSON webhook fires).
  if (!itemId && details.invoiceNumber) {
    const byNumber: any = db
      .prepare(
        `SELECT monday_item_id, full_name, asmachta FROM grow_dekel_transactions
         WHERE invoice_number = ? AND monday_item_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(details.invoiceNumber);
    if (byNumber?.monday_item_id) {
      itemId = byNumber.monday_item_id;
      details.asmachta = details.asmachta || byNumber.asmachta;
      details.fullName = details.fullName || byNumber.full_name;
      matchSource = "invoice-number";
      log.info(
        { uid, itemId, invoiceNumber: details.invoiceNumber },
        "matched invoice email by cached invoice_number",
      );
    }
  }

  // Tight-window single-candidate fallback. The previous logic picked the
  // OLDEST unattached transaction in the last 24h — that misattributed
  // invoices when an earlier transaction's invoice email was missed/lost
  // and a later transaction's invoice arrived. Now we only auto-attach
  // if (a) exactly ONE unattached candidate exists, AND (b) it was created
  // in the last 10 minutes (matches typical Grow invoice email lag).
  if (!itemId) {
    const candidates: any[] = db
      .prepare(
        `SELECT monday_item_id, full_name, asmachta, payment_sum,
                datetime(created_at) AS created_at
         FROM grow_dekel_transactions
         WHERE monday_item_id IS NOT NULL
           AND (invoice_url IS NULL OR invoice_url = '')
           AND created_at > datetime('now', '+3 hours', '-10 minutes')
         ORDER BY created_at DESC`,
      )
      .all();

    if (candidates.length === 1) {
      const only = candidates[0];
      itemId = only.monday_item_id;
      details.asmachta = details.asmachta || only.asmachta;
      details.fullName = details.fullName || only.full_name;
      matchSource = "single-recent-candidate";
      log.info(
        { uid, itemId, fullName: details.fullName },
        "matched invoice email to single recent unattached transaction",
      );
    } else if (candidates.length > 1) {
      // Ambiguous — multiple unattached transactions in the window.
      // Surface the candidates to Alon and stop. Manual decision required.
      const list = candidates
        .slice(0, 5)
        .map(
          (c) =>
            `• ${c.full_name || "—"} (₪${c.payment_sum}, אסמכתא ${c.asmachta}, ${c.created_at})`,
        )
        .join("\n");
      await sendTelegram(
        `⚠️ חשבונית ${details.invoiceNumber} הגיעה במייל אבל יש ${candidates.length} עסקאות פתוחות בלי חשבונית ב-10 דק׳ האחרונות:\n${list}\n\n*לא צירפתי אוטומטית* — צרף ידנית לליד הנכון.`,
      );
      log.warn(
        { uid, candidateCount: candidates.length, invoiceNumber: details.invoiceNumber },
        "ambiguous invoice match — skipped auto-attach",
      );
      return;
    }
  }

  if (!itemId) {
    log.warn(
      { uid, phone: details.payerPhone, asmachta: details.asmachta },
      "no matching lead found",
    );
    await sendTelegram(
      `📧 חשבונית ${details.invoiceNumber || ""} מ-Grow התקבלה — לא נמצא ליד תואם (אין עסקה פתוחה ב-10 דק׳ האחרונות, ולא הצלחתי להצליב לפי טלפון/אסמכתא/מס׳ חשבונית). צרף ידנית.`,
    );
    return;
  }
  log.info({ uid, itemId, matchSource }, "invoice → lead match resolved");

  // Resolve PDF buffer — prefer email attachment, fallback to Meshulam URL
  let pdfBuf: Buffer | null = null;
  const filename = `חשבונית-${details.invoiceNumber || details.asmachta || "grow"}.pdf`;
  if (pdfAtt?.content) {
    pdfBuf = pdfAtt.content as Buffer;
  } else if (details.invoiceUrl) {
    pdfBuf = await tryDownloadPdf(details.invoiceUrl);
  }

  // Upload to Files column (so it shows under the lead's Files folder)
  const uploaded = pdfBuf
    ? await uploadPdfToMonday(itemId, pdfBuf, filename)
    : false;
  log.info(
    { itemId, invoiceNumber: details.invoiceNumber, uploaded },
    "PDF upload result",
  );

  // Mark the matched transaction as attached so the next invoice email in
  // this poll does not re-match the same lead. Prefer asmachta to target a
  // single row; otherwise scope by monday_item_id + empty invoice_url.
  if (uploaded) {
    const markerUrl =
      details.invoiceUrl ||
      `attached:${details.invoiceNumber || details.asmachta || "unknown"}`;
    if (details.asmachta) {
      db.prepare(
        `UPDATE grow_dekel_transactions SET invoice_url = ? WHERE asmachta = ?`,
      ).run(markerUrl, details.asmachta);
    } else {
      db.prepare(
        `UPDATE grow_dekel_transactions SET invoice_url = ?
         WHERE monday_item_id = ?
           AND (invoice_url IS NULL OR invoice_url = '')`,
      ).run(markerUrl, itemId);
    }
  }

  // Update invoice number + URL link columns
  if (details.invoiceNumber || details.invoiceUrl) {
    const values: Record<string, any> = {};
    if (details.invoiceNumber)
      values[INVOICE_NUMBER_COL] = details.invoiceNumber;
    if (details.invoiceUrl)
      values[INVOICE_URL_COL] = {
        url: details.invoiceUrl,
        text: `חשבונית ${details.invoiceNumber || ""}`.trim(),
      };
    const valuesJson = JSON.stringify(JSON.stringify(values));
    await mondayQuery(
      `mutation { change_multiple_column_values(board_id: ${LEADS_BOARD_ID}, item_id: ${itemId}, column_values: ${valuesJson}) { id } }`,
    );
  }

  // Create a human-readable Update on the lead and attach the same PDF
  // there so it's visible inline in the conversation thread.
  const sumLine = details.paymentSum ? `על סך ₪${details.paymentSum}` : "";
  const updateBody = `💰 התקבל תשלום ${sumLine}\\n🧾 חשבונית ${details.invoiceNumber || details.asmachta || ""} ${uploaded ? "מצורפת כאן + שמורה ב-Files של הליד" : "לינק: " + (details.invoiceUrl || "")}`;
  const updateRes = await mondayQuery(
    `mutation { create_update(item_id: ${itemId}, body: "${updateBody.replace(/"/g, '\\"')}") { id } }`,
  );
  const updateId: string | undefined = updateRes?.data?.create_update?.id;
  if (updateId && pdfBuf) {
    try {
      const form = new FormData();
      form.append(
        "query",
        `mutation ($file: File!) { add_file_to_update(update_id: ${updateId}, file: $file) { id } }`,
      );
      form.append("map", '{"fileToUpload":"variables.file"}');
      form.append(
        "fileToUpload",
        new Blob([new Uint8Array(pdfBuf)], { type: "application/pdf" }),
        filename,
      );
      await fetch("https://api.monday.com/v2/file", {
        method: "POST",
        headers: {
          Authorization: config.mondayApiKey,
          "API-Version": "2024-01",
        },
        body: form as any,
      });
    } catch (e: any) {
      log.warn({ err: e.message }, "attach PDF to update failed");
    }
  }

  const tgText = uploaded
    ? `📎 חשבונית ${details.invoiceNumber || details.asmachta} הועלתה לליד של *${details.fullName}* (Files + Update)`
    : `📧 מייל חשבונית (${details.fullName}) — ליד עודכן${pdfAtt ? "" : ", אבל אין PDF נגיש"}`;
  await sendTelegram(tgText);
}

let running = false;

export async function runImapPoll(): Promise<void> {
  if (running) return;
  running = true;

  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS?.replace(/\s/g, "");
  if (!user || !pass) {
    log.debug("IMAP_USER/IMAP_PASS not set — skipping poll");
    running = false;
    return;
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    // Search across all mail (covers cases where Gmail filters skip INBOX or
    // a label routes the message away). All Mail UIDs are stable and unique.
    const mailbox = process.env.IMAP_MAILBOX || "[Gmail]/All Mail";
    await client.mailboxOpen(mailbox);
    const lastUid = getLastUid();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // last 24h
    const searchResult = await client.search({ from: "grow.security", since });
    const uids: number[] = Array.isArray(searchResult) ? searchResult : [];
    log.info(
      { mailbox, lastUid, totalFound: uids.length, uids: uids.slice(-10) },
      "IMAP search result",
    );
    const newUids = uids.filter((u: number) => u > lastUid);
    if (newUids.length > 0) {
      log.info({ count: newUids.length, newUids }, "found new Grow emails");
      for (const uid of newUids) {
        try {
          await processMessage(client, uid);
          setLastUid(uid);
        } catch (e: any) {
          log.error({ err: e.message, uid }, "failed to process email");
        }
      }
    }
    await client.logout();
  } catch (e: any) {
    log.warn({ err: e.message }, "IMAP poll error");
  } finally {
    running = false;
  }
}

// Reset last_uid so next poll reprocesses everything in the search window.
export function resetLastUid(): void {
  db.prepare(
    `UPDATE grow_imap_state SET last_uid = 0, updated_at = datetime('now', '+3 hours') WHERE id = 1`,
  ).run();
  log.info("reset grow_imap_state.last_uid to 0");
}

export function startImapWatcher(intervalMs = 60_000): void {
  log.info({ intervalMs }, "starting Grow invoice IMAP watcher");
  // Initial run after 30s (let server boot)
  setTimeout(() => runImapPoll(), 30_000);
  setInterval(() => runImapPoll(), intervalMs);
}
