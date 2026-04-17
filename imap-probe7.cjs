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

  // Get latest email full HTML
  const uid = uids[uids.length - 1];
  console.log("Fetching uid:", uid);
  const msg = await c.fetchOne(uid, { envelope: true });
  console.log("date:", msg.envelope.date?.toISOString?.());
  console.log("subj:", msg.envelope.subject);

  const dl = await c.download(uid, "1");
  const chunks = [];
  for await (const chunk of dl.content) chunks.push(chunk);
  const html = Buffer.concat(chunks).toString("utf8");

  // Extract URLs
  const urls = [...new Set(html.match(/https?:\/\/[^\s"'<>]+/g) || [])];
  console.log(`\nURLs (${urls.length}):`);
  urls.forEach((u) => console.log(" -", u.slice(0, 120)));

  // Look for transaction/invoice keywords
  const textStripped = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  console.log("\n--- BODY TEXT (first 2000 chars) ---");
  console.log(textStripped.slice(0, 2000));

  await c.logout();
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
