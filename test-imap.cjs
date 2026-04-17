const { ImapFlow } = require("imapflow");
(async () => {
  const c = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: process.env.IMAP_USER,
      pass: process.env.IMAP_PASS,
    },
    logger: false,
  });
  try {
    await c.connect();
    console.log("connected as", process.env.IMAP_USER);
    await c.mailboxOpen("INBOX");
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    for (const q of [
      { from: "grow" },
      { from: "meshulam" },
      { from: "support@grow" },
      { subject: "חשבונית" },
      { subject: "invoice" },
      { subject: "receipt" },
    ]) {
      const uids = await c.search({ ...q, since });
      console.log(JSON.stringify(q), "->", uids.length, "matches");
    }
    // Try from support@grow.security specifically
    const uids = await c.search({ from: "grow.security", since });
    console.log("\n--- recent emails from grow.security ---");
    for (const uid of uids.slice(-5)) {
      const msg = await c.fetchOne(uid, {
        envelope: true,
        bodyStructure: true,
      });
      const atts = [];
      const walk = (bs) => {
        if (!bs) return;
        if (bs.disposition === "attachment" || bs.type === "application/pdf")
          atts.push({
            type: bs.type,
            filename: bs.dispositionParameters?.filename || bs.parameters?.name,
            size: bs.size,
            part: bs.part,
          });
        if (bs.childNodes) bs.childNodes.forEach(walk);
      };
      walk(msg.bodyStructure);
      console.log(
        "uid:",
        uid,
        "| date:",
        msg.envelope.date?.toISOString?.()?.slice(0, 10),
        "| from:",
        msg.envelope.from?.[0]?.address,
        "| subject:",
        msg.envelope.subject,
        "| atts:",
        atts.length,
        atts.map((a) => a.filename).join(","),
      );
    }
    await c.logout();
  } catch (e) {
    console.error("ERR:", e.message, e.code || "");
    process.exit(1);
  }
})();
