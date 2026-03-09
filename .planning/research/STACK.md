# Technology Stack

**Project:** Alon.dev WhatsApp Sales Bot
**Researched:** 2026-03-09
**Overall confidence:** HIGH -- Stack is directly derived from AlonBot (proven in production) with minimal additions.

## Recommended Stack

### Core Runtime

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Node.js | 22 LTS | Runtime | Already used across all Alon projects. LTS = stable for Railway Docker. |
| TypeScript | ^5.9 | Type safety | Used in AlonBot. Catches integration bugs early (Monday.com schemas, Baileys types). ESM + `.js` import convention. |
| tsx | ^4.19 | Dev runner | `tsx watch` for development, same as AlonBot. |

### WhatsApp

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @whiskeysockets/baileys | ^6.7 | WhatsApp Web API | Already proven in AlonBot (`src/channels/whatsapp.ts`). Session persistence via `useMultiFileAuthState`. Pairing code flow already implemented. |
| @hapi/boom | ^10.0 | Error handling for Baileys disconnect reasons | Required companion for Baileys `DisconnectReason` handling. Already used in AlonBot. |
| qrcode-terminal | ^0.12 | QR fallback display | Backup pairing method. Already in AlonBot deps. |

### AI / Conversation

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| @anthropic-ai/sdk | ^0.78 | Claude API client | Best Hebrew AI. Already integrated across the entire ecosystem (AlonBot, Aliza, Instasite). Use `claude-sonnet-4-20250514` for conversation (fast + cheap), escalate to opus for complex quotes if needed. |

### Database

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| better-sqlite3 | ^12.6 | Conversation history, lead state, follow-up queue | Synchronous API = simpler code. Already used in AlonBot and Aliza. WAL mode for concurrent reads. Perfect for single-bot workload. |

### Server / API

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Express | ^5.2 | HTTP server for Monday.com webhooks | Express v5 is the standard across all Alon projects. Receives webhook POSTs from Monday.com when new leads arrive. Also serves a simple admin dashboard. |

### Scheduling / Cron

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| node-cron | ^4.0 | Follow-up scheduler | Checks every minute for leads needing follow-up (day 1, day 3, day 7). Same pattern as Aliza's scheduler and AlonBot's cron system. |

### External APIs

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Monday.com GraphQL API | v2 (direct fetch) | Lead detection, status updates | Direct `fetch()` to `https://api.monday.com/v2` with GraphQL queries. AlonBot already has this pattern (`src/tools/handlers/monday.ts`). No SDK needed -- the API is simple GraphQL. |
| Google Calendar Apps Script | Custom endpoint | Meeting scheduling, availability check | AlonBot uses a Google Apps Script proxy (`GOOGLE_CALENDAR_SCRIPT_URL`) for calendar operations. Reuse this exact pattern -- no googleapis SDK needed. |

### Validation

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| zod | ^4.3 | Input validation, config schema | Already in AlonBot. Validate Monday.com webhook payloads, environment config, conversation state schemas. |

### Logging

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| pino | ^10.3 | Structured logging | Already in AlonBot. Fast JSON logger. Essential for debugging WhatsApp connection issues and conversation flows in Railway logs. |

### Infrastructure

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Docker | node:22-slim | Container | Standard across all Railway deployments (Aliza, Claude Village, Bentzi). |
| Railway | -- | Hosting | Persistent volume for WhatsApp session + SQLite DB. Already used for 5+ projects. Volume mount at `/data`. |
| dotenv | ^17.3 | Environment variables | Standard across all projects. |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| WhatsApp API | Baileys (unofficial) | WhatsApp Business API (official) | Costs money, requires Meta business verification, slower setup. Baileys is free, already working in AlonBot, sufficient for single-number bot. |
| Database | better-sqlite3 | PostgreSQL | Overkill for single-bot. SQLite is simpler, no separate service, already proven pattern. Data volume is tiny (hundreds of conversations, not millions). |
| AI SDK | @anthropic-ai/sdk | OpenAI SDK | Claude has significantly better Hebrew. Already integrated everywhere. No reason to switch. |
| Calendar | Apps Script proxy | googleapis npm package | googleapis is a 50MB+ dependency. The Apps Script proxy is already deployed and working. Zero additional setup. |
| Monday.com | Direct fetch + GraphQL | monday-sdk-js | The SDK adds abstraction over a simple GraphQL endpoint. Direct fetch is cleaner, already proven in AlonBot. |
| Server | Express v5 | Fastify | Express is the standard across all Alon projects. No performance need to switch -- this bot handles maybe 50 messages/day. |
| Scheduler | node-cron | Bull/BullMQ + Redis | Massive overkill. node-cron with SQLite-backed job state is sufficient. No Redis infrastructure needed. |
| TypeScript runner | tsx | ts-node | tsx is faster, zero-config, already used in AlonBot. |
| Logging | pino | winston | pino is faster and already in use. |

## Dev Dependencies

| Library | Version | Purpose |
|---------|---------|---------|
| typescript | ^5.9 | Compiler |
| tsx | ^4.19 | Dev runner with watch mode |
| @types/better-sqlite3 | * | SQLite type definitions |
| @types/express | ^5.0 | Express type definitions |
| @types/node | ^22 | Node.js type definitions |
| vitest | ^4.0 | Testing (optional but recommended for conversation flow tests) |

## Installation

```bash
# Core dependencies
npm install @whiskeysockets/baileys @hapi/boom qrcode-terminal \
  @anthropic-ai/sdk better-sqlite3 express node-cron \
  zod pino dotenv

# Dev dependencies
npm install -D typescript tsx @types/better-sqlite3 @types/express \
  @types/node vitest
```

## Environment Variables

```bash
# WhatsApp
WHATSAPP_PHONE_NUMBER=972546300783    # Bot's phone number for pairing

# AI
ANTHROPIC_API_KEY=                     # Claude API key

# Monday.com
MONDAY_API_KEY=                        # Monday.com API token
MONDAY_BOARD_ID=                       # Leads board ID
MONDAY_WEBHOOK_SECRET=                 # Webhook verification (optional)

# Google Calendar
GOOGLE_CALENDAR_SCRIPT_URL=            # Apps Script proxy URL (reuse from AlonBot)

# Notifications
TELEGRAM_BOT_TOKEN=                    # For escalation notifications to Alon
TELEGRAM_CHAT_ID=                      # Alon's Telegram chat ID

# Infrastructure
DATA_DIR=./data                        # SQLite DB + WhatsApp session
PORT=3000                              # Express server port
```

## Project Structure

```
src/
  index.ts                  # Entry point: start Express, Baileys, cron
  config.ts                 # Zod-validated environment config

  whatsapp/
    connection.ts           # Baileys socket, auth state, reconnect logic
    sender.ts               # Message sending with rate limiting

  conversation/
    engine.ts               # Claude-powered conversation flow
    prompts.ts              # System prompts, service knowledge, Hebrew templates
    state.ts                # Conversation state machine (new → qualifying → quoting → booking → closed)

  integrations/
    monday.ts               # Monday.com GraphQL: read leads, update status
    calendar.ts             # Google Calendar: check slots, book meetings

  scheduler/
    followup.ts             # Follow-up cron: day 1, 3, 7 checks

  db/
    schema.ts               # SQLite tables: leads, conversations, messages, follow_ups
    queries.ts              # Prepared statements

  server/
    webhooks.ts             # POST /webhooks/monday — new lead trigger
    dashboard.ts            # GET /dashboard — simple admin view

  utils/
    logger.ts               # Pino logger setup
    rate-limit.ts           # WhatsApp anti-spam delays

data/                       # Persisted volume on Railway
  bot.db                    # SQLite database
  whatsapp-session/         # Baileys auth state
```

## Confidence Assessment

| Component | Confidence | Reason |
|-----------|------------|--------|
| Baileys ^6.7 | HIGH | Proven in AlonBot production code, exact version verified from package.json |
| @anthropic-ai/sdk ^0.78 | HIGH | Verified from AlonBot package.json, used across 4+ projects |
| better-sqlite3 ^12.6 | HIGH | Verified from AlonBot + Aliza package.json |
| Express ^5.2 | HIGH | Verified from AlonBot + Aliza package.json |
| node-cron ^4.0 | HIGH | Verified from AlonBot (^4.0.7) + Aliza (^4.2.1) |
| zod ^4.3 | HIGH | Verified from AlonBot package.json |
| pino ^10.3 | HIGH | Verified from AlonBot package.json |
| Monday.com direct fetch | HIGH | Exact pattern verified in AlonBot `src/tools/handlers/monday.ts` |
| Google Calendar Apps Script | HIGH | Exact pattern verified in AlonBot `src/tools/handlers/calendar.ts` |
| Railway + Docker | HIGH | Already running 5+ projects on Railway |

## Key Architectural Decisions

### Why No WhatsApp Business API
Baileys is the right choice for this project because: (1) zero cost vs paid API, (2) Alon already has working code, (3) single-number bot doesn't need official API scale. The risk is WhatsApp blocking -- mitigated by careful rate limiting and human-like message timing.

### Why SQLite Over PostgreSQL
This bot serves one business, one WhatsApp number, handling maybe 5-50 leads per day. SQLite in WAL mode handles this trivially. Railway volume persists the DB. No need for a separate database service.

### Why Apps Script Proxy Over googleapis SDK
The `googleapis` npm package is enormous and complex (OAuth2 token refresh, service accounts). AlonBot's Apps Script proxy is already deployed, handles auth server-side, and exposes a simple REST API. Zero additional setup.

### Why Direct Monday.com GraphQL Over SDK
The Monday.com Node SDK (`monday-sdk-js`) is designed for Monday.com apps/integrations marketplace. For a simple bot that reads leads and updates statuses, direct `fetch()` with GraphQL is cleaner and has zero abstraction overhead. The exact pattern is already proven in AlonBot.

## Sources

- AlonBot `package.json` -- verified all dependency versions (HIGH confidence)
- AlonBot `src/channels/whatsapp.ts` -- Baileys connection pattern (HIGH confidence)
- AlonBot `src/tools/handlers/monday.ts` -- Monday.com integration pattern (HIGH confidence)
- AlonBot `src/tools/handlers/calendar.ts` -- Google Calendar integration pattern (HIGH confidence)
- Aliza `package.json` -- verified Express v5, better-sqlite3, node-cron versions (HIGH confidence)
- Note: npm registry versions could not be verified live (web tools unavailable). Versions are from existing working projects dated 2026-03. They are current or very close to current.
