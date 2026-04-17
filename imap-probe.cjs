const { ImapFlow } = require("imapflow");
const user = "alonr@dprisha.co.il";
const pass = "rohprioszkzhbzzb";
const c = new ImapFlow({
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  auth: { user, pass },
  logger: {
    info: () => {},
    warn: (o) => console.error("WARN:", JSON.stringify(o).slice(0, 300)),
    error: (o) => console.error("ERR:", JSON.stringify(o).slice(0, 500)),
    debug: () => {},
  },
});
(async () => {
  try {
    await c.connect();
    console.log("CONNECTED");
    await c.mailboxOpen("INBOX");
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    for (const q of [
      { from: "grow" },
      { from: "meshulam" },
      { from: "grow.security" },
      { subject: "חשבונית" },
      { subject: "invoice" },
    ]) {
      const uids = await c.search({ ...q, since });
      console.log(JSON.stringify(q), "->", uids.length);
    }
    await c.logout();
  } catch (e) {
    console.error(
      "CATCH:",
      e.message,
      "code:",
      e.code || "",
      "auth:",
      e.authenticationFailed,
    );
    process.exit(1);
  }
})();
