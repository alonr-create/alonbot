# Phase 1: Foundation - Research

**Researched:** 2026-03-09
**Domain:** WhatsApp bot connection (Baileys), SQLite, Docker/Railway deployment
**Confidence:** HIGH

## Summary

Phase 1 establishes a WhatsApp bot using Baileys (the proven unofficial WhatsApp Web API) with session persistence, SQLite database, rate-limited message handling with typing simulation, a health endpoint, structured logging, and Docker deployment to Railway. AlonBot at `/Users/oakhome/קלוד עבודות/alonbot/` already implements most of these patterns -- the new bot reuses its Baileys connection, better-sqlite3 setup, pino logging, Express v5 server, and Dockerfile structure.

The key technical decisions are: stay on Baileys v6 stable (v7 is still RC), use `useMultiFileAuthState` for session persistence (acceptable for a single-bot deployment), serve QR code on a web page via the `qrcode` npm package for Railway accessibility, and send Telegram/WhatsApp notifications to Alon on critical events.

**Primary recommendation:** Clone AlonBot's proven patterns (Baileys connection, SQLite, pino, Docker) with modifications for sales bot requirements (QR web page, rate limiting, typing simulation, Telegram notifications).

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- Dedicated new SIM card -- NOT Alon's personal number (054-630-0783)
- Alon must obtain a prepaid SIM before development begins
- WhatsApp profile name: "אלון - שירותי טכנולוגיה"
- Bot introduces itself apologetically if unknown numbers message it
- Aggressive sales style -- pushy but not rude
- Hebrew-first, informal/friendly but business-oriented
- QR in terminal console on first launch + web page at /qr showing QR + connection status
- 3-5 second minimum delay between outbound messages
- Typing indicator simulation: 1-3 seconds scaled by response length
- No bulk sending, one message at a time
- Railway with Docker + persistent volume for WhatsApp session and SQLite DB
- Auto-deploy from GitHub on push
- Telegram notification to Alon for critical events (disconnection, errors, reconnection failures)
- WhatsApp notification to Alon's personal number (054-630-0783) as backup
- Full health endpoint: WhatsApp connected?, DB OK?, uptime, active leads count, memory usage
- pino for structured logging (JSON with level, msg, module, time)

### Claude's Discretion
- Profile picture choice (logo vs personal photo)
- Exact GitHub repo name
- Session storage format (file vs DB)
- Express server port
- Dockerfile structure

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| WA-01 | Bot connects to WhatsApp via Baileys with multi-device auth | Baileys v6 `makeWASocket` + `useMultiFileAuthState` -- pattern proven in AlonBot |
| WA-02 | WhatsApp session persists across restarts (file/DB storage) | `useMultiFileAuthState` writes creds to `/data/whatsapp-session/` on persistent volume |
| WA-03 | Bot auto-reconnects on disconnect without manual intervention | `connection.update` event handler with retry logic + exponential backoff -- pattern in AlonBot |
| WA-04 | Rate limiting enforces minimum 3-5 second delay between outbound messages | Simple queue with `setTimeout` -- no library needed |
| WA-05 | Typing indicator simulation (1-3 seconds scaled by message length) before each response | Baileys `sock.sendPresenceUpdate('composing', jid)` + delay before send |
| INF-01 | SQLite database for leads, conversations, follow-up schedule | better-sqlite3 with WAL mode -- pattern in AlonBot |
| INF-02 | Docker deployment to Railway with persistent volume for session + DB | Node 22 slim + Railway volume at `/data` -- pattern in AlonBot |
| INF-03 | Health endpoint with connection status, DB health, uptime | Express v5 GET `/health` returning JSON |
| INF-04 | Structured logging (pino) for all operations | pino with child loggers per module -- pattern in AlonBot |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @whiskeysockets/baileys | ^6.7.21 | WhatsApp Web socket API | Latest stable v6 -- v7 is still RC (rc.9). AlonBot uses 6.7.16 |
| better-sqlite3 | ^12.6.2 | SQLite database | Sync API, WAL mode, proven in AlonBot |
| express | ^5.2.1 | HTTP server (health, QR page) | Same as AlonBot, modern Express v5 |
| pino | ^10.3.1 | Structured JSON logging | Same as AlonBot, Baileys itself uses pino |
| dotenv | ^17.3.1 | Environment variables | Same as AlonBot |
| typescript | ^5.9.0 | Type safety | Same as AlonBot |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @hapi/boom | ^10.0.1 | Error classification for Baileys disconnect reasons | Required by Baileys disconnect handling |
| qrcode | ^1.5.4 | Generate QR code as data URL for web page | Serve QR at /qr route for Railway scanning |
| qrcode-terminal | ^0.12.0 | Print QR in terminal console | First-launch QR display |
| grammy | ^1.35.0 | Telegram bot for notifications to Alon | Critical event alerts (disconnect, errors) |

### Dev Dependencies
| Library | Version | Purpose |
|---------|---------|---------|
| @types/better-sqlite3 | * | Type definitions |
| @types/express | ^5.0.6 | Type definitions |
| @types/qrcode | * | Type definitions |
| tsx | ^4.19.0 | Dev mode with auto-reload |
| vitest | ^4.0.18 | Testing framework |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Baileys v6 | Baileys v7 RC | v7 has LID system changes, proto API changes, ACK behavior changes. Still RC -- not stable for production. Stay on v6 |
| useMultiFileAuthState | Custom DB auth state | DB auth is recommended for "production" multi-session systems. For single-bot, file auth on persistent volume is sufficient and simpler |
| grammy | node-telegram-bot-api | AlonBot already uses grammy. Consistency wins |
| better-sqlite3 | drizzle-orm | Unnecessary ORM overhead for simple schema. Direct SQL is clearer |

**Installation:**
```bash
npm install @whiskeysockets/baileys@^6.7.21 @hapi/boom better-sqlite3 express pino dotenv qrcode qrcode-terminal grammy
npm install -D typescript tsx vitest @types/better-sqlite3 @types/express @types/qrcode @types/node
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  index.ts              # Entry point -- start Express, connect WhatsApp
  config.ts             # Environment config (single object export)
  whatsapp/
    connection.ts       # Baileys socket, auth, reconnect logic
    qr.ts               # QR state management (latest QR string, connection status)
    message-handler.ts  # Incoming message router + typing simulation
    rate-limiter.ts     # Outbound message queue with delay enforcement
  db/
    index.ts            # better-sqlite3 init, WAL, schema creation
    schema.ts           # CREATE TABLE statements (leads, conversations, messages)
  http/
    server.ts           # Express app setup
    routes/
      health.ts         # GET /health
      qr.ts             # GET /qr (web page with QR code)
  notifications/
    telegram.ts         # Send alert to Alon's Telegram
    whatsapp.ts         # Send alert to Alon's WhatsApp (054-630-0783)
  utils/
    logger.ts           # pino with child logger factory
    delay.ts            # sleep/random delay helpers
data/                   # Persistent volume mount point (/data in Docker)
  whatsapp-session/     # Baileys auth files (creds.json, etc.)
  bot.db                # SQLite database
```

### Pattern 1: Baileys Connection with QR Web Page
**What:** Connect to WhatsApp, show QR in terminal AND on web page, handle reconnection
**When to use:** Initial connection and session recovery
**Example:**
```typescript
// Source: AlonBot whatsapp.ts + Baileys docs
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';

let currentQR: string | null = null;
let connectionStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,  // Also show in terminal
    browser: ['AlonDev Sales', 'Chrome', '22.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr); // For web page
      connectionStatus = 'connecting';
    }

    if (connection === 'open') {
      currentQR = null;
      connectionStatus = 'connected';
      retryCount = 0;
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        // Session invalidated -- clear session, re-show QR
        await notifyAlon('WhatsApp session logged out -- QR re-scan needed');
      } else {
        // Transient error -- reconnect with backoff
        const delay = Math.min(5000 * Math.pow(2, retryCount), 60000);
        setTimeout(connect, delay);
        retryCount++;
      }
    }
  });

  return sock;
}
```

### Pattern 2: Rate-Limited Message Sending with Typing Simulation
**What:** Queue outbound messages with minimum delay + composing indicator
**When to use:** Every outbound message
**Example:**
```typescript
// Rate limiter with typing simulation
const MIN_DELAY_MS = 3000; // 3 seconds minimum between messages
const MAX_DELAY_MS = 5000; // 5 seconds maximum
let lastSendTime = 0;

async function sendWithTyping(sock: WASocket, jid: string, text: string) {
  // Enforce rate limit
  const now = Date.now();
  const elapsed = now - lastSendTime;
  const minWait = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);

  if (elapsed < minWait) {
    await sleep(minWait - elapsed);
  }

  // Typing indicator scaled by message length
  const typingDuration = Math.min(1000 + (text.length * 20), 3000); // 1-3 seconds
  await sock.sendPresenceUpdate('composing', jid);
  await sleep(typingDuration);

  // Send message
  await sock.sendMessage(jid, { text });
  lastSendTime = Date.now();

  // Clear typing
  await sock.sendPresenceUpdate('paused', jid);
}
```

### Pattern 3: Health Endpoint
**What:** JSON status of all subsystems
**When to use:** Railway health checks + monitoring
**Example:**
```typescript
// GET /health
app.get('/health', (req, res) => {
  const dbHealthy = checkDbHealth();
  const waConnected = connectionStatus === 'connected';

  res.json({
    status: waConnected && dbHealthy ? 'ok' : 'degraded',
    whatsapp: { connected: waConnected, status: connectionStatus },
    database: { healthy: dbHealthy },
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});
```

### Anti-Patterns to Avoid
- **Bulk message sending:** WhatsApp bans accounts that send too many messages too fast. Always enforce rate limits.
- **Ignoring DisconnectReason.loggedOut:** This means the session was invalidated. Reconnecting will fail -- must clear session and re-scan QR.
- **Using Baileys v7 RC in production:** Still has breaking changes landing. v6 stable is safer.
- **Storing session outside persistent volume:** Railway redeploys wipe the filesystem. Session MUST be on the volume.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| QR code generation | Custom QR renderer | `qrcode` npm package | Handles error correction, multiple output formats |
| WhatsApp protocol | Custom WebSocket handler | `@whiskeysockets/baileys` | Reverse-engineered protocol, Signal encryption, multi-device support |
| Structured logging | console.log with formatting | `pino` | JSON output, log levels, child loggers, Baileys uses it internally |
| SQLite connection | Raw sqlite3 bindings | `better-sqlite3` | Sync API avoids callback hell, WAL mode, prepared statements |
| Telegram notifications | Raw HTTP to Telegram API | `grammy` | AlonBot already uses it, handles message formatting, error recovery |

**Key insight:** This entire bot is built on proven patterns from AlonBot. The only new elements are the QR web page and rate limiting -- everything else is a copy-adapt pattern.

## Common Pitfalls

### Pitfall 1: WhatsApp Session Loss on Redeploy
**What goes wrong:** Bot loses WhatsApp connection after Railway redeploy, requires manual QR re-scan
**Why it happens:** Session files stored in app directory instead of persistent volume
**How to avoid:** Store `whatsapp-session/` under `/data/` which is the Railway volume mount point
**Warning signs:** Bot works after QR scan but disconnects after `railway up`

### Pitfall 2: WhatsApp Ban from Aggressive Messaging
**What goes wrong:** WhatsApp temporarily or permanently bans the bot number
**Why it happens:** Sending messages too fast, sending to too many contacts, bulk patterns
**How to avoid:** Enforce 3-5 second minimum delay, never send bulk, use typing indicators, warm up gradually
**Warning signs:** Messages stop delivering, "connection closed" errors

### Pitfall 3: Baileys Connection Storms
**What goes wrong:** Bot enters infinite reconnect loop, consuming resources
**Why it happens:** No backoff between reconnection attempts, no max retry limit
**How to avoid:** Exponential backoff (5s, 10s, 20s, 40s, 60s cap) + max retry count (e.g., 10). After max retries, notify Alon and stop.
**Warning signs:** Logs full of "reconnecting" messages, high CPU usage

### Pitfall 4: SQLite Database Locked
**What goes wrong:** "database is locked" errors under concurrent access
**Why it happens:** Multiple write operations without WAL mode
**How to avoid:** Enable WAL mode on database open: `db.pragma('journal_mode = WAL')`
**Warning signs:** Intermittent write failures, especially during message bursts

### Pitfall 5: Ignoring loggedOut Disconnect Reason
**What goes wrong:** Bot keeps trying to reconnect with invalid credentials forever
**Why it happens:** Not checking `DisconnectReason.loggedOut` specifically
**How to avoid:** When loggedOut, delete session directory, set QR state to "needs scan", notify Alon immediately
**Warning signs:** Repeated 401/unauthorized errors in reconnect attempts

### Pitfall 6: Telegram Bot Not Receiving Messages
**What goes wrong:** Telegram notifications silently fail
**Why it happens:** Bot never received a /start from Alon, so it doesn't know the chat ID
**How to avoid:** On first run, Alon must send /start to the Telegram bot. Store the chat_id. Use `bot.api.sendMessage(chatId, text)` -- no polling needed for send-only.
**Warning signs:** No errors but no Telegram messages received

## Code Examples

### Database Schema for Phase 1
```typescript
// Source: AlonBot db.ts pattern adapted for sales bot
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    source TEXT DEFAULT 'whatsapp',
    status TEXT NOT NULL DEFAULT 'new'
      CHECK(status IN ('new', 'contacted', 'in-conversation', 'quote-sent',
                        'meeting-scheduled', 'escalated', 'closed-won', 'closed-lost')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    phone TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, created_at);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
  CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
`);
```

### QR Web Page Route
```typescript
// Source: Baileys docs + qrcode npm
import { Router } from 'express';

const router = Router();

router.get('/qr', (req, res) => {
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AlonBot QR</title>
  <style>
    body { font-family: sans-serif; display: flex; flex-direction: column;
           align-items: center; justify-content: center; min-height: 100vh;
           background: #1a1a2e; color: #fff; margin: 0; }
    .status { font-size: 1.2em; margin: 1em; }
    .connected { color: #4ade80; }
    .waiting { color: #fbbf24; }
    img { max-width: 300px; border-radius: 12px; }
  </style>
  <script>
    async function poll() {
      const res = await fetch('/api/qr-status');
      const data = await res.json();
      document.getElementById('status').className = 'status ' + (data.connected ? 'connected' : 'waiting');
      document.getElementById('status').textContent = data.connected ? 'מחובר!' : 'ממתין לסריקת QR...';
      const img = document.getElementById('qr');
      if (data.qr) { img.src = data.qr; img.style.display = 'block'; }
      else { img.style.display = 'none'; }
      setTimeout(poll, 2000);
    }
    poll();
  </script>
</head>
<body>
  <h1>AlonBot - WhatsApp</h1>
  <div id="status" class="status waiting">טוען...</div>
  <img id="qr" style="display:none" alt="QR Code">
</body>
</html>`;
  res.type('html').send(html);
});

router.get('/api/qr-status', (req, res) => {
  res.json({
    connected: connectionStatus === 'connected',
    qr: currentQR, // data URL or null
    status: connectionStatus,
  });
});

export { router as qrRouter };
```

### Telegram Notification Helper
```typescript
// Source: grammy docs -- send-only bot (no polling)
import { Bot } from 'grammy';

const bot = new Bot(config.telegramBotToken);

export async function notifyAlon(message: string) {
  if (!config.telegramChatId) return;

  try {
    await bot.api.sendMessage(config.telegramChatId, message, {
      parse_mode: 'HTML',
    });
  } catch (err) {
    log.error({ err }, 'telegram notification failed');
  }
}
```

### Dockerfile
```dockerfile
# Source: AlonBot Dockerfile adapted
FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc
RUN npm prune --production

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Baileys v4-5 (adiwajshing) | Baileys v6 (WhiskeySockets) | 2023 | Fork by WhiskeySockets is the maintained version |
| Baileys v6 stable | Baileys v7 RC | Late 2025 | v7 adds LID system, removes ACKs. Still RC -- stay on v6 |
| printQRInTerminal only | QR web page + terminal | Standard pattern | Essential for cloud deployments (Railway, Render) |
| console.log | pino structured logging | Standard | JSON logs, filterable by level/module |

**Deprecated/outdated:**
- `@adiwajshing/baileys`: Dead, use `@whiskeysockets/baileys`
- `isJidUser()`: Renamed to `isPnUser()` in v7 (not relevant for v6)
- `.fromObject()` proto method: Removed in v7, use `.create()` (not relevant for v6)

## Open Questions

1. **Telegram Bot Token**
   - What we know: AlonBot already has a Telegram bot. Can reuse or create new one.
   - What's unclear: Whether to reuse AlonBot's Telegram bot or create a dedicated one
   - Recommendation: Create a new Telegram bot via BotFather for this project (clean separation)

2. **SIM Card Status**
   - What we know: Alon must obtain a prepaid SIM before Phase 1 can be fully tested
   - What's unclear: Whether the SIM has been obtained yet
   - Recommendation: Development can proceed (all code written/tested). QR scan is the final step before going live.

3. **useMultiFileAuthState Production Warning**
   - What we know: Baileys docs warn against it for production multi-session systems
   - What's unclear: Whether it matters for a single-bot deployment
   - Recommendation: Use it. The warning targets systems managing hundreds of sessions. A single bot with files on a persistent volume is fine. If issues arise later, custom DB auth state can be implemented.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | none -- Wave 0 |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WA-01 | Baileys connection initializes with auth state | unit | `npx vitest run src/whatsapp/__tests__/connection.test.ts -t "connect"` | Wave 0 |
| WA-02 | Session directory created, creds saved | unit | `npx vitest run src/whatsapp/__tests__/connection.test.ts -t "session"` | Wave 0 |
| WA-03 | Reconnect logic fires on transient disconnect | unit | `npx vitest run src/whatsapp/__tests__/connection.test.ts -t "reconnect"` | Wave 0 |
| WA-04 | Rate limiter enforces 3-5s delay | unit | `npx vitest run src/whatsapp/__tests__/rate-limiter.test.ts` | Wave 0 |
| WA-05 | Typing simulation delays before send | unit | `npx vitest run src/whatsapp/__tests__/message-handler.test.ts -t "typing"` | Wave 0 |
| INF-01 | Database initializes with schema | unit | `npx vitest run src/db/__tests__/schema.test.ts` | Wave 0 |
| INF-02 | Docker builds and runs | manual-only | `docker build -t test . && docker run --rm test node -e "console.log('ok')"` | N/A |
| INF-03 | Health endpoint returns JSON | unit | `npx vitest run src/http/__tests__/health.test.ts` | Wave 0 |
| INF-04 | Logger creates child with module name | unit | `npx vitest run src/utils/__tests__/logger.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `vitest.config.ts` -- test framework config
- [ ] `src/whatsapp/__tests__/connection.test.ts` -- WA-01, WA-02, WA-03
- [ ] `src/whatsapp/__tests__/rate-limiter.test.ts` -- WA-04
- [ ] `src/whatsapp/__tests__/message-handler.test.ts` -- WA-05
- [ ] `src/db/__tests__/schema.test.ts` -- INF-01
- [ ] `src/http/__tests__/health.test.ts` -- INF-03
- [ ] `src/utils/__tests__/logger.test.ts` -- INF-04

## Sources

### Primary (HIGH confidence)
- AlonBot `/Users/oakhome/קלוד עבודות/alonbot/src/channels/whatsapp.ts` -- proven Baileys v6 connection pattern
- AlonBot `/Users/oakhome/קלוד עבודות/alonbot/src/utils/db.ts` -- proven better-sqlite3 + WAL pattern
- AlonBot `/Users/oakhome/קלוד עבודות/alonbot/Dockerfile` -- proven Railway Docker deployment
- [Baileys official docs - connecting](https://baileys.wiki/docs/socket/connecting/) -- connection, QR, auth flow
- [Baileys v7 migration guide](https://baileys.wiki/docs/migration/to-v7.0.0/) -- breaking changes to avoid
- npm registry -- verified versions: baileys 6.7.21, better-sqlite3 12.6.2, pino 10.3.1, express 5.2.1

### Secondary (MEDIUM confidence)
- [Baileys GitHub](https://github.com/WhiskeySockets/Baileys) -- release history, issues
- [grammy.dev](https://grammy.dev/) -- Telegram bot framework docs

### Tertiary (LOW confidence)
- None -- all findings verified with primary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries verified via npm, proven in AlonBot
- Architecture: HIGH -- direct adaptation of AlonBot patterns with minor additions
- Pitfalls: HIGH -- based on AlonBot production experience + Baileys docs warnings

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable stack, Baileys v6 is mature)
