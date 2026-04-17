const { ImapFlow } = require("imapflow");
const pass = "rohprioszkzhbzzb";
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
      await c.logout();
    } catch (e) {
      console.log(
        `❌ ${user} — ${e.authenticationFailed ? "auth failed" : e.message}`,
      );
    }
  }
})();
