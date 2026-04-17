const { ImapFlow } = require("imapflow");
const pass = "qowiwnxnecolhtln";
(async () => {
  for (const user of [
    "alonr@dprisha.co.il",
    "alon12@gmail.com",
    "servicedprisha@gmail.com",
  ]) {
    const c = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user, pass },
      logger: false,
    });
    try {
      await c.connect();
      console.log(`✅ ${user} — auth OK`);
      await c.mailboxOpen("INBOX");
      const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
      for (const q of [
        { from: "grow" },
        { from: "meshulam" },
        { subject: "חשבונית" },
      ]) {
        const uids = await c.search({ ...q, since });
        console.log(`  ${JSON.stringify(q)} -> ${uids.length}`);
      }
      await c.logout();
      return;
    } catch (e) {
      console.log(
        `❌ ${user} — ${e.authenticationFailed ? "auth failed" : e.message}`,
      );
    }
  }
})();
