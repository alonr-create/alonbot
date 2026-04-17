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
  const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const uids = await c.search({ from: "grow.security", since });
  console.log(`Grow emails last 3 days: ${uids.length}`);
  // Fetch latest 3 with full body
  for (const uid of uids.slice(-3)) {
    const msg = await c.fetchOne(uid, {
      envelope: true,
      source: true,
      bodyStructure: true,
    });
    console.log("\n======= uid", uid, "=======");
    console.log("date:", msg.envelope.date?.toISOString?.());
    console.log("from:", msg.envelope.from?.[0]?.address);
    console.log("subject:", msg.envelope.subject);
    // BodyStructure
    const parts = [];
    const walk = (bs, depth = 0) => {
      if (!bs) return;
      parts.push({
        depth,
        type: bs.type,
        subtype: bs.subtype,
        part: bs.part,
        size: bs.size,
        disposition: bs.disposition,
        filename: bs.dispositionParameters?.filename || bs.parameters?.name,
      });
      if (bs.childNodes) bs.childNodes.forEach((n) => walk(n, depth + 1));
    };
    walk(msg.bodyStructure);
    console.log("parts:", JSON.stringify(parts, null, 2));

    // Get text body to extract URLs
    const textPart = parts.find(
      (p) =>
        (p.type === "text" || !p.type) &&
        (p.subtype === "plain" || p.subtype === "html"),
    );
    if (textPart) {
      const body = await c.download(uid, textPart.part || "1");
      const chunks = [];
      for await (const chunk of body.content) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      // Extract URLs
      const urls = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
      console.log("URLs:", urls.slice(0, 10));
      // Look for invoice patterns
      const invoiceMatch = text.match(/invoice|חשבונית|פתיחת.{1,50}חשבונית/gi);
      console.log("invoice mentions:", invoiceMatch?.slice(0, 5));
    }
  }
  await c.logout();
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
