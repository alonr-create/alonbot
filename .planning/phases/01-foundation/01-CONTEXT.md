# Phase 1: Foundation - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

WhatsApp connection via Baileys with session persistence, SQLite database, rate limiting, typing indicator simulation, Docker deployment to Railway with persistent volume, health endpoint, and structured logging (pino). This phase delivers a running bot that can connect to WhatsApp, receive and respond to messages (with test responses), and survive restarts and redeploys.

</domain>

<decisions>
## Implementation Decisions

### WhatsApp Number
- Dedicated new SIM card — NOT Alon's personal number (054-630-0783)
- Alon must obtain a prepaid SIM before development begins
- WhatsApp profile name: "אלון - שירותי טכנולוגיה"
- Bot introduces itself apologetically if unknown numbers message it: "היי, הגעת לאלון מ-Alon.dev. אם אתה מעוניין בשירותי טכנולוגיה, אשמח לעזור!"

### Bot Personality & Tone
- Aggressive sales style — pushy but not rude
- Proactive about closing deals, offering promotions, creating urgency
- Hebrew-first, informal/friendly but business-oriented
- Uses emojis strategically (not excessively)

### QR Code Scanning
- Both: QR in terminal console on first launch + web page at /qr showing QR + connection status
- Web QR page allows scanning from phone without terminal access (important for Railway)

### Rate Limiting & Typing
- 3-5 second minimum delay between outbound messages
- Typing indicator simulation: 1-3 seconds scaled by response length
- No bulk sending, one message at a time

### Deployment
- Railway with Docker + persistent volume for WhatsApp session (auth_info) and SQLite DB
- Auto-deploy from GitHub on push
- GitHub repo name: Claude's discretion (e.g., alon-dev-whatsapp-bot or similar)

### Notifications
- Telegram notification to Alon for critical events (disconnection, errors, reconnection failures)
- Also notify via WhatsApp to Alon's personal number (054-630-0783) as backup

### Health Endpoint
- Full status: WhatsApp connected?, DB OK?, uptime, active leads count, memory usage
- JSON response at /health
- Suitable for Railway health checks

### Logging
- pino for structured logging (JSON with level, msg, module, time)
- Log all WhatsApp events (connect, disconnect, message in, message out)

### Claude's Discretion
- Profile picture choice (logo vs personal photo)
- Exact GitHub repo name
- Session storage format (file vs DB)
- Express server port
- Dockerfile structure

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- AlonBot has a working Baileys adapter at `/Users/oakhome/קלוד עבודות/alonbot/src/channels/whatsapp.ts` — patterns for connection, auth, reconnection, message handling
- AlonBot uses better-sqlite3 with a similar schema pattern
- AlonBot has pino installed (recently wired in Phase 3 hardening)

### Established Patterns
- TypeScript ESM with `.js` import extensions (AlonBot convention)
- Express v5 for HTTP endpoints
- Docker deployment with persistent volume at /data
- Environment variables via .env (dotenv)

### Integration Points
- Monday.com API (Phase 2) — webhook receiver will use the Express server from this phase
- Claude API (Phase 2) — conversation engine connects to the message handler from this phase
- Google Calendar (Phase 3) — scheduling service uses the same Express server

</code_context>

<specifics>
## Specific Ideas

- Web QR page is important for Railway — can't access terminal easily for QR scan
- Bot should handle gracefully when WhatsApp kicks the session (re-show QR, notify Alon)
- Warm-up period after connecting: start with slow message rate, gradually increase

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 01-foundation*
*Context gathered: 2026-03-09*
