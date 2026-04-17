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
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Find emails with "חשבונית" in subject
  const uids = await c.search({ subject: "חשבונית", since });
  console.log(`Found ${uids.length} emails with "חשבונית"`);
  console.log("\n--- recent 8 ---");
  for (const uid of uids.slice(-8)) {
    const msg = await c.fetchOne(uid, { envelope: true, bodyStructure: true });
    const atts = [];
    const walk = (bs) => {
      if (!bs) return;
      if (bs.disposition === "attachment" || bs.type === "application/pdf")
        atts.push({
          filename: bs.dispositionParameters?.filename || bs.parameters?.name,
          size: bs.size,
          part: bs.part,
          type: bs.type,
        });
      if (bs.childNodes) bs.childNodes.forEach(walk);
    };
    walk(msg.bodyStructure);
    console.log(
      `uid:${uid} ${msg.envelope.date?.toISOString?.()?.slice(0, 10)} from:${msg.envelope.from?.[0]?.address}`,
    );
    console.log(`  subj: ${msg.envelope.subject}`);
    console.log(
      `  atts: ${atts.length} ${atts.map((a) => `${a.filename}(${a.type},${a.size}b)`).join(",")}`,
    );
  }
  await c.logout();
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
