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
  try {
    await c.connect();
    console.log(`✅ ${user} — CONNECTED`);
    await c.mailboxOpen("INBOX");
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    for (const q of [
      { from: "grow" },
      { from: "meshulam" },
      { from: "support@grow" },
      { subject: "חשבונית" },
      { subject: "invoice" },
    ]) {
      const uids = await c.search({ ...q, since });
      console.log(`  ${JSON.stringify(q)} -> ${uids.length}`);
    }
    const uids = await c.search({ from: "grow", since });
    console.log(`\n--- recent ${uids.length} emails from grow* ---`);
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
            filename: bs.dispositionParameters?.filename || bs.parameters?.name,
            size: bs.size,
            part: bs.part,
          });
        if (bs.childNodes) bs.childNodes.forEach(walk);
      };
      walk(msg.bodyStructure);
      console.log(
        `  uid:${uid} ${msg.envelope.date?.toISOString?.()?.slice(0, 10)} from:${msg.envelope.from?.[0]?.address} subj:${msg.envelope.subject} atts:${atts.length} ${atts.map((a) => a.filename).join(",")}`,
      );
    }
    await c.logout();
  } catch (e) {
    console.error("ERR:", e.message, "auth:", e.authenticationFailed);
    process.exit(1);
  }
})();
