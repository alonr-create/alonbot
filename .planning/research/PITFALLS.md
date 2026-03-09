# Domain Pitfalls

**Domain:** WhatsApp Sales Bot (Baileys + Claude AI + Monday.com)
**Researched:** 2026-03-09
**Confidence:** HIGH (based on real-world AlonBot Baileys integration + domain expertise)

---

## Critical Pitfalls

Mistakes that cause project failure, account bans, or major rewrites.

### Pitfall 1: WhatsApp Account Ban from Automated Outbound Messages

**What goes wrong:** WhatsApp actively detects and bans accounts that send unsolicited messages at scale. The bot proactively messages new leads (people who filled a form but did NOT message the WhatsApp number first). WhatsApp classifies this as spam. The account gets temporarily restricted, then permanently banned.

**Why it happens:** WhatsApp's anti-spam system flags accounts that: (a) send first messages to numbers that never messaged them, (b) send many messages in a short window, (c) get blocked/reported by recipients, (d) send similar templated messages to multiple contacts. A sales bot does ALL of these.

**Consequences:** Permanent ban of the phone number. Loss of all WhatsApp contacts and history. If using Alon's personal number (054-630-0783), this is catastrophic -- it kills personal and business communications.

**Prevention:**
1. **NEVER use Alon's personal number.** Get a separate SIM card dedicated to the bot. If it gets banned, only the bot number is lost.
2. **Warm up the number gradually.** Start with 2-3 outbound messages per day for the first 2 weeks, then slowly increase. Never send more than 20 new conversations per day.
3. **Add randomized delays between messages.** Minimum 30-60 seconds between any two outbound messages. Add jitter (random 10-30 second variance) so timing patterns look human.
4. **Track block/report signals.** If a user blocks the bot or a message fails with a 403/spam error, immediately stop messaging that contact and reduce overall sending rate.
5. **Make opt-out trivial.** First message should include "reply STOP to opt out." Honor it instantly.
6. **Personalize every message.** Never send identical text to multiple contacts. Use the lead's name, their specific interest from Monday.com, and vary phrasing via Claude.

**Detection:** Watch for: messages failing silently, "not on WhatsApp" errors for numbers that ARE on WhatsApp, connection drops increasing in frequency, WhatsApp showing "this number is not allowed to use WhatsApp" on the phone.

**Phase relevance:** Phase 1 (WhatsApp connection) must enforce rate limits from day one. This is not an optimization -- it is survival.

---

### Pitfall 2: Baileys Session Loss on Deployment

**What goes wrong:** Baileys stores authentication state in a local `whatsapp-session/` directory (creds.json + multiple key files). When deploying to Railway/Render with Docker, each deploy creates a fresh container. The session directory is wiped. The bot disconnects and requires re-pairing via QR code or pairing code -- which requires manual intervention from a phone.

**Why it happens:** Docker containers are ephemeral by design. Without a persistent volume mount, all filesystem state is lost on redeploy. AlonBot's existing code stores sessions at `${config.dataDir}/whatsapp-session` -- if `dataDir` is inside the container filesystem, redeployment kills the session.

**Consequences:** Bot goes offline after every deployment. Requires Alon to manually re-pair by opening WhatsApp > Linked Devices > Link. During downtime, leads get no response. If the bot is deployed frequently during development, this becomes a constant interruption.

**Prevention:**
1. **Mount a persistent volume on Railway.** Use Railway's volume mount (e.g., `/data`) and store the session directory there. AlonBot already uses this pattern.
2. **Separate session storage from application code.** Use a path like `/data/whatsapp-session/` that survives container restarts.
3. **Add session health monitoring.** On startup, check if `creds.json` exists and is valid. Log clearly whether this is a fresh connection (needs pairing) or a reconnection (automatic).
4. **Implement pairing code flow (not QR).** AlonBot already does this: `sock.requestPairingCode(PHONE_NUMBER)`. This is better than QR for headless servers -- the code can be logged and entered from the phone without scanning a screen.
5. **Add a Telegram notification when session is lost.** Alert Alon immediately so re-pairing happens fast.

**Detection:** Bot stops receiving messages. Health check shows WhatsApp as disconnected. Logs show `connection: 'close'` with `loggedOut` reason.

**Phase relevance:** Must be solved in Phase 1. Deploy once, test that session survives a redeploy before building any other features.

---

### Pitfall 3: AI Hallucinating Prices, Commitments, or Capabilities

**What goes wrong:** Claude generates a price quote that is wildly wrong (e.g., "a full app for 2,000 NIS" when the real price is 15,000+). Or it commits to a delivery timeline ("ready in 3 days") that is impossible. Or it claims Alon can build something he cannot. The lead then holds Alon to the AI's promise, creating an awkward and potentially damaging business situation.

**Why it happens:** LLMs generate plausible text, not verified facts. Without strict guardrails, Claude will extrapolate pricing from its training data (which reflects different markets and different years) or simply make up numbers that sound reasonable. In Hebrew, the problem is worse because there is less Hebrew pricing data in training.

**Consequences:** Loss of credibility with leads. Awkward conversations explaining the AI was wrong. Potential legal issues if a lead considers an AI-generated quote as a binding offer. Worst case: Alon is forced to honor an unprofitable price to maintain reputation.

**Prevention:**
1. **Define explicit price ranges in the system prompt.** For each service type, provide minimum and maximum prices. Example: "Website: 5,000-15,000 NIS. App: 15,000-50,000 NIS. Never quote below the minimum."
2. **Make quotes preliminary, not final.** System prompt must instruct Claude to always say "this is an initial estimate" and "final pricing will be confirmed by Alon after a discovery call."
3. **Never let the AI commit to timelines.** The prompt should say "timelines are determined after the discovery meeting." No exceptions.
4. **Maintain a services knowledge base.** A structured JSON/markdown file listing each service, what it includes, what it does NOT include, price range, and typical timeline. Load this into the system prompt.
5. **Add a quote review step.** Before sending a quote message, flag it for Alon's approval (or at minimum, log it separately so Alon can review all quotes sent).
6. **Test with adversarial prompts.** "Can you make me a full app for 500 NIS?" -- the bot must decline clearly.

**Detection:** Review conversation logs for any message containing numbers + "NIS" or "shekel" patterns. Weekly audit of all quotes generated.

**Phase relevance:** Must be addressed in the AI conversation phase. The system prompt and knowledge base must be built BEFORE enabling automated conversations.

---

### Pitfall 4: Using Alon's Personal WhatsApp Number

**What goes wrong:** The project uses Alon's personal number (054-630-0783) for the bot. Baileys connects as a "linked device" to the existing WhatsApp account. The bot and Alon share the same WhatsApp account. Alon's personal messages are visible to the bot. The bot might accidentally respond to personal messages. If WhatsApp bans the account for bot activity, Alon loses his personal WhatsApp.

**Why it happens:** It is the path of least resistance -- no need to get a new SIM, the number is already known to leads, and it seems simpler. AlonBot's existing code even uses `config.allowedWhatsApp` to filter, but in a sales bot that must talk to ANY new lead, you cannot whitelist numbers.

**Consequences:** Privacy violation (bot processes personal messages). Risk of personal WhatsApp ban. Bot responding to Alon's mom. Mixing personal and business conversations in logs. No way to "turn off" the bot without disconnecting the linked device.

**Prevention:**
1. **Get a dedicated SIM card for the bot.** A prepaid SIM costs 30-50 NIS. This is non-negotiable.
2. **Register it on WhatsApp using a separate phone** (even a cheap one). Once registered, the phone can be put away -- Baileys operates as a linked device.
3. **Use the business number in Monday.com forms** so leads know to expect messages from it.
4. **Never share the bot's session credentials** or store them in git.

**Detection:** If the bot is receiving messages from contacts NOT in Monday.com leads -- it is probably seeing personal messages.

**Phase relevance:** Phase 0 (setup). Must have a dedicated number BEFORE writing any code.

---

### Pitfall 5: Baileys Breaking Changes and Library Instability

**What goes wrong:** Baileys (`@whiskeysockets/baileys`) is an unofficial, reverse-engineered WhatsApp Web library. WhatsApp regularly changes their protocol. When WhatsApp pushes a protocol update, Baileys breaks. The library may stop connecting, messages may fail silently, or the session may become invalid. The maintainers update the library, but there can be days or weeks of downtime.

**Why it happens:** WhatsApp does not provide an official API for personal accounts. Baileys reverse-engineers the WhatsApp Web protocol (Signal Protocol + Noise Pipes). WhatsApp has every incentive to break unofficial clients and does so regularly. The Baileys maintainer community is small and volunteer-driven.

**Consequences:** Bot goes completely offline with no fix available until the library is updated. Leads get no response for days. No workaround exists -- you cannot "fix" a protocol-level break yourself.

**Prevention:**
1. **Accept this as a known risk.** Document it for Alon. Baileys WILL break periodically.
2. **Pin the Baileys version.** Do not auto-update. Only update when you have tested the new version.
3. **Build a fallback notification system.** When the bot cannot connect for >30 minutes, notify Alon via Telegram so he can handle leads manually.
4. **Monitor the Baileys GitHub repo** for issues and releases. Protocol breaks are usually reported within hours.
5. **Consider the WhatsApp Business API as a future migration path.** It costs money but is officially supported and will not randomly break. For a sales bot that generates revenue, the cost may be justified later.
6. **Design the system so the bot is helpful but not critical.** Leads should still land in Monday.com regardless of bot status. The bot accelerates response, it does not replace human follow-up.

**Detection:** Connection status monitoring. If `connection.update` shows repeated `close` events with non-loggedOut reasons across Baileys GitHub issues, it is likely a protocol break.

**Phase relevance:** All phases. Must have monitoring from Phase 1, fallback notification from Phase 2.

---

## Moderate Pitfalls

### Pitfall 6: Follow-Up Messages Becoming Harassment

**What goes wrong:** The 3-message follow-up series (day 1, day 3, day 7) crosses the line from persistence to harassment. Leads who are not interested get annoyed. They block the number or report it as spam, which feeds back into Pitfall 1 (account ban risk).

**Prevention:**
1. **Stop follow-ups immediately if the lead replies at all** -- even with "not interested." Any response means the conversation should be handled, not automated.
2. **Never follow up more than 3 times total.** After 3 unanswered messages, mark the lead as "cold" and stop.
3. **Make each follow-up genuinely different.** Not "just checking in" three times. First: value proposition. Second: case study or portfolio link. Third: "last message, no pressure."
4. **Respect Israeli business hours.** Never send messages before 9:00 or after 20:00. Never on Shabbat (Friday evening to Saturday evening). This is both legally and culturally important.
5. **Track and monitor the block rate.** If more than 10% of leads block the bot, the messaging is too aggressive.

**Phase relevance:** Phase 3 (follow-up system). Must include business hours logic and opt-out handling.

---

### Pitfall 7: Conversation State Loss Between Restarts

**What goes wrong:** The bot restarts (deployment, crash, Baileys reconnect) and loses track of where each conversation was. A lead who was mid-discussion about pricing suddenly gets the intro message again. Or the bot forgets what service the lead was interested in and asks again.

**Prevention:**
1. **Store conversation state in a database, not in memory.** Every message sent and received must be persisted to SQLite/PostgreSQL.
2. **Load conversation history when a message arrives.** Before responding, fetch the last N messages for this lead from the DB. Pass them to Claude as conversation context.
3. **Store structured lead state.** Not just messages, but also: current stage (intro / discussing / quoting / scheduling / follow-up), service interest, last interaction timestamp, quote details.
4. **Test the restart scenario explicitly.** Start a conversation, restart the bot, send another message, verify continuity.

**Phase relevance:** Phase 1 (must set up DB persistence from the start). Phase 2 (conversation history loading for Claude context).

---

### Pitfall 8: Monday.com Webhook Reliability

**What goes wrong:** Monday.com webhooks are not 100% reliable. They can: (a) fire multiple times for the same event (duplicates), (b) fail silently and not retry, (c) arrive out of order, (d) have a different payload structure than documented. The bot creates a new lead from each webhook, so duplicates mean duplicate outreach -- messaging the same person twice.

**Prevention:**
1. **Implement idempotency.** Store the Monday.com item ID in the database. Before creating a new lead, check if it already exists. Use the item ID as the deduplication key.
2. **Add webhook signature verification.** Monday.com signs webhooks -- verify the signature to prevent spoofed events.
3. **Handle the "challenge" handshake.** Monday.com sends a verification request when setting up a webhook. The endpoint must respond with the challenge value. This is documented but easy to miss.
4. **Use polling as a fallback.** If the webhook endpoint was down, missed leads will never be retried by Monday.com. Run a periodic check (every 30 minutes) for new leads that were not processed.
5. **Monday.com formula/mirror columns return null via API.** This is a known issue (documented in AlonBot's CLAUDE.md). If lead data is in formula columns, you will get null values and think the data is missing.

**Phase relevance:** Phase 2 (Monday.com integration). Idempotency must be built in from the first webhook handler.

---

### Pitfall 9: Hebrew Text Handling Edge Cases

**What goes wrong:** Hebrew text in WhatsApp messages creates subtle bugs: (a) mixed Hebrew/English text (e.g., "אני רוצה אתר WordPress") has bidirectional text issues in logs and databases, (b) Hebrew numbers vs. Arabic numerals cause parsing confusion, (c) Claude sometimes responds in English when the Hebrew context is insufficient, (d) phone numbers in Hebrew format ("054-630-0783") vs. international format ("+972546300783") cause matching failures.

**Prevention:**
1. **Normalize phone numbers on input.** Strip dashes, spaces, leading zeros. Convert "054" to "+97254". Use a consistent format everywhere (E.164: +972546300783).
2. **Force Claude to respond in Hebrew.** System prompt must explicitly state: "Always respond in Hebrew. Never switch to English even if the user writes in English."
3. **Test with real Hebrew conversations.** Not just "shalom" -- test with long Hebrew text, mixed language, emojis, and Hebrew numbers.
4. **Store all text as UTF-8.** Ensure the database, logs, and all string handling use UTF-8. Node.js handles this well by default, but verify when writing to files or external systems.

**Phase relevance:** Phase 2 (AI conversation). Phone number normalization in Phase 1.

---

### Pitfall 10: Google Calendar Time Zone Bugs

**What goes wrong:** The bot suggests a meeting time in one timezone but creates the calendar event in another. Israel has DST transitions that differ from US/EU schedules. A meeting booked for "Tuesday at 10:00" in Israel time might show up as 3:00 AM on the calendar if the timezone is wrong.

**Prevention:**
1. **Always use `Asia/Jerusalem` timezone explicitly.** Never rely on system timezone or UTC offsets.
2. **Use a date library that handles DST correctly.** `date-fns-tz` or `luxon` -- not raw `Date` objects.
3. **Include the timezone in calendar event creation.** Google Calendar API accepts timezone in the request body -- always include it.
4. **Display times in 24-hour format in Hebrew.** "10:00" not "10:00 AM" -- Hebrew speakers expect 24-hour format.
5. **Test around DST transitions.** Israel's DST changes are on different dates than Europe/US. Test booking a meeting across a DST boundary.

**Phase relevance:** Phase 3 (calendar integration).

---

## Minor Pitfalls

### Pitfall 11: Message Type Blindness

**What goes wrong:** Leads send images, voice messages, documents, or location pins. The bot only handles text messages (as AlonBot's current WhatsApp adapter does -- lines 82-84 of `whatsapp.ts` only extract `conversation` and `extendedTextMessage`). Non-text messages are silently ignored. The lead thinks the bot received their voice note and is waiting for a response.

**Prevention:**
1. **Detect non-text message types and respond gracefully.** "I received your voice message but I can only read text. Could you type your question?"
2. **At minimum handle:** text, images (with a polite "I can see you sent an image"), voice notes, documents, and contacts.
3. **Log all message types received** for future feature planning.

**Phase relevance:** Phase 2 (message handling). Add non-text detection even before supporting non-text content.

---

### Pitfall 12: Concurrent Lead Processing Race Conditions

**What goes wrong:** Two leads message at the same time. Both conversations hit Claude API simultaneously. If conversation state is managed in memory (not per-lead in DB), responses can get mixed up -- Lead A gets Lead B's quote.

**Prevention:**
1. **Isolate conversation state per lead.** Each lead has their own conversation history in the DB, keyed by phone number.
2. **Use per-lead locking for state updates.** When processing a message from lead X, lock lead X's state until the response is sent.
3. **Pass the full conversation history to Claude on each turn.** Do not rely on in-memory state that could be corrupted by concurrent requests.

**Phase relevance:** Phase 2 (AI conversation).

---

### Pitfall 13: Overloading Claude API Context with Long Conversations

**What goes wrong:** A lead has a long conversation (20+ messages). Each turn, the full conversation history is sent to Claude. The context window fills up, costs increase, and response time degrades. Eventually, the conversation exceeds the context limit and fails.

**Prevention:**
1. **Limit conversation history to the last 20 messages.** Summarize older messages into a brief context note.
2. **Use a system prompt that is concise.** Every token in the system prompt is repeated on every turn. Keep it under 1,000 tokens.
3. **Track API costs per lead.** Set a cost ceiling per conversation (e.g., $0.50). After that, escalate to Alon.

**Phase relevance:** Phase 2 (AI conversation). Must be designed into the conversation management from the start.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| WhatsApp connection (Phase 1) | Session loss on deploy (#2), using personal number (#4) | Persistent volume + dedicated SIM |
| Monday.com webhooks (Phase 2) | Duplicate events (#8), formula columns returning null | Idempotency key + polling fallback |
| AI conversations (Phase 2) | Price hallucination (#3), English responses (#9) | Strict system prompt + price ranges + Hebrew enforcement |
| Follow-up system (Phase 3) | Harassment/ban risk (#1, #6) | Rate limits, business hours, opt-out, block tracking |
| Calendar integration (Phase 3) | Timezone bugs (#10) | Explicit Asia/Jerusalem, date-fns-tz, DST testing |
| Scaling/maintenance (ongoing) | Baileys breaking (#5), context overflow (#13) | Monitoring, fallback notifications, conversation trimming |

---

## Sources

- **AlonBot codebase** (HIGH confidence): `/Users/oakhome/קלוד עבודות/alonbot/src/channels/whatsapp.ts` -- real-world Baileys integration with session management, reconnection logic, and message handling. Direct evidence of text-only handling limitation (line 82-84) and max retry pattern (line 62-67).
- **AlonBot concerns analysis** (HIGH confidence): `/Users/oakhome/קלוד עבודות/alonbot/.planning/codebase/CONCERNS.md` -- documented issues with `execSync` blocking, no error retry logic, WhatsApp adapter limitations, session persistence requirements.
- **AlonBot config** (HIGH confidence): `/Users/oakhome/קלוד עבודות/alonbot/src/utils/config.ts` -- shows `allowedWhatsApp` pattern which will NOT work for a sales bot that must talk to unknown numbers.
- **Baileys library patterns** (MEDIUM confidence): Based on `@whiskeysockets/baileys` usage patterns observed in AlonBot and general knowledge of the library's architecture. Protocol instability claims based on library's history of breaking changes.
- **WhatsApp anti-spam behavior** (MEDIUM confidence): Based on known WhatsApp policies and community reports. Exact thresholds for ban triggers are not publicly documented by WhatsApp.
- **Monday.com webhook behavior** (MEDIUM confidence): Based on Monday.com API documentation patterns and the null-formula-column issue documented in AlonBot's CLAUDE.md.
