const { ImapFlow } = require("imapflow");
const pass = "ohexrgdpqphuvrnv";
const user = "alonra@gmail.com";
(async () => {
  const c = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await c.connect();
  await c.mailboxOpen("INBOX");
  // All grow emails ever (no date limit)
  const uids = await c.search({ from: "grow" });
  console.log(`Total Grow emails: ${uids.length}`);

  // Count how many have attachments
  let withAttachments = 0;
  const pdfEmails = [];
  for (const uid of uids) {
    const msg = await c.fetchOne(uid, { envelope: true, bodyStructure: true });
    let hasPdf = false;
    const walk = (bs) => {
      if (!bs) return;
      if (bs.type === "application/pdf" || bs.disposition === "attachment")
        hasPdf = true;
      if (bs.childNodes) bs.childNodes.forEach(walk);
    };
    walk(msg.bodyStructure);
    if (hasPdf) {
      withAttachments++;
      pdfEmails.push({
        uid,
        date: msg.envelope.date?.toISOString?.()?.slice(0, 10),
        from: msg.envelope.from?.[0]?.address,
        subject: msg.envelope.subject,
      });
    }
  }
  console.log(`\nGrow emails WITH attachments: ${withAttachments}`);
  if (pdfEmails.length > 0) {
    console.log("Examples:");
    pdfEmails
      .slice(-10)
      .forEach((e) =>
        console.log(`  uid:${e.uid} ${e.date} | ${e.from} | ${e.subject}`),
      );
  }

  // Also check for specific sender variations
  for (const q of [
    { from: "support@grow" },
    { from: "noreply@grow" },
    { from: "no-reply@grow" },
    { from: "invoice@grow" },
    { from: "documents@grow" },
    { from: "billing@grow" },
  ]) {
    const r = await c.search(q);
    if (r.length > 0) console.log(`${JSON.stringify(q)}: ${r.length}`);
  }

  await c.logout();
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
