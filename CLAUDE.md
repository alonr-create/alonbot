# AalonBot — WhatsApp Sales Bot

## What is this?
Autonomous WhatsApp sales bot that manages leads, books meetings, sends quotes, and reports to the boss — all via WhatsApp. Built for Alon.dev but designed for multi-tenant cloning.

## Stack
- **Runtime**: Node.js 22 + TypeScript (ESM, `"type": "module"`)
- **Framework**: Express v5
- **Database**: SQLite via better-sqlite3 (file: `/data/bot.db`)
- **WhatsApp**: whatsapp-web.js (Puppeteer-based, Chromium in Docker)
- **AI**: Claude API (`@anthropic-ai/sdk`) + OpenAI Whisper (voice transcription)
- **Deploy**: Railway (Docker, auto-deploy on push, volume mount `/data`)

## Quick Start

```bash
# Local development
cp .env.example .env   # fill in API keys
npm install
npm run dev            # tsx watch mode

# Production build
npm run build          # tsc → dist/
npm start              # node dist/index.js

# Tests
npm test               # vitest
```

## Environment Variables (required)

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `ALON_PHONE` | Admin phone (format: `972XXXXXXXXX`) |
| `MONDAY_API_TOKEN` | Monday.com API token |
| `MONDAY_BOARD_ID` | Primary Monday.com board ID |
| `MONDAY_BOARD_ID_DPRISHA` | Secondary Monday.com board ID (optional) |
| `FACEBOOK_ACCESS_TOKEN` | FB Marketing API token (account 1) |
| `FACEBOOK_ACCESS_TOKEN_ALON` | FB Marketing API token (account 2, optional) |
| `GOOGLE_CALENDAR_SCRIPT_URL` | Google Apps Script deployment URL |
| `OPENAI_API_KEY` | OpenAI API key (Whisper transcription) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key (voice synthesis) |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice ID |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (escalation alerts) |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for alerts |
| `DATA_DIR` | Data directory (default: `./data`) |
| `PORT` | HTTP port (default: `3000`) |

## Project Structure

```
src/
├── index.ts                  # Entry point — starts all services
├── config.ts                 # Environment config loader
├── ai/
│   ├── conversation.ts       # Main conversation handler + boss markers
│   ├── system-prompt.ts      # System prompt builder (boss vs lead mode)
│   ├── boss-context.ts       # Live business data for boss messages
│   ├── claude-client.ts      # Claude API wrapper
│   ├── lead-scoring.ts       # Lead scoring algorithm
│   ├── bot-rules.ts          # Self-learning rules (boss teaches bot)
│   ├── image-analysis.ts     # Image analysis via Claude Vision
│   ├── voice-synthesize.ts   # ElevenLabs TTS
│   └── voice-transcribe.ts   # OpenAI Whisper STT
├── calendar/
│   ├── api.ts                # Google Calendar via Apps Script proxy
│   └── business-hours.ts     # Israel business hours logic
├── db/
│   ├── index.ts              # DB initialization + health check
│   ├── schema.ts             # Tables: leads, messages, follow_ups, reminders, tenant_config, bot_rules
│   └── tenant-config.ts      # Multi-tenant config system (all business data in DB)
├── escalation/
│   ├── handler.ts            # Lead escalation to boss
│   └── summary.ts            # Escalation summaries
├── facebook/
│   ├── api.ts                # FB Marketing API v21.0 (multi-account)
│   └── types.ts              # FB API types
├── follow-up/
│   ├── follow-up-ai.ts       # AI-generated follow-up messages
│   ├── follow-up-db.ts       # Follow-up DB operations
│   └── scheduler.ts          # 3-message follow-up scheduler (24h, 2d, 4d)
├── http/
│   ├── server.ts             # Express server setup
│   └── routes/
│       ├── health.ts         # Health + admin endpoints
│       ├── chat.ts           # Website chat API
│       └── qr.ts             # WhatsApp QR code display
├── monday/
│   ├── api.ts                # Monday.com GraphQL API (multi-board)
│   ├── types.ts              # Monday.com types
│   └── webhook-handler.ts    # Monday.com webhook handler
├── notifications/
│   ├── telegram.ts           # Telegram alerts
│   └── whatsapp-notify.ts    # WhatsApp admin notifications
├── quotes/
│   ├── generate-quote.ts     # PDF quote generation (Puppeteer)
│   ├── generate-hero-image.ts # Quote hero image
│   ├── logo.ts               # Logo handling
│   └── scrape-website.ts     # Website scraping for quote branding
├── schedulers/
│   ├── daily-summary.ts      # Daily morning recap to boss
│   ├── weekly-report.ts      # Weekly Sunday report
│   └── reminders.ts          # Boss-scheduled reminders
├── utils/
│   ├── logger.ts             # Pino logger
│   └── delay.ts              # Delay utility
└── whatsapp/
    ├── connection.ts         # WhatsApp client setup
    ├── message-handler.ts    # Incoming message router
    ├── message-batcher.ts    # 8-second batching + processing lock
    ├── qr.ts                 # QR code state management
    └── rate-limiter.ts       # In-memory rate limiter
```

## Architecture

### Two Modes
1. **Boss mode** (`isAdminPhone(phone) === true`): Personal assistant — pipeline stats, lead search, Monday/FB commands, reminders, quotes
2. **Lead mode**: Sales agent — qualification, pricing, meeting booking, objection handling, follow-ups

### Boss Markers
The AI generates markers in its response that trigger actions:
- `[SEARCH:query]` — Search leads
- `[PREP:phone]` — Meeting prep summary
- `[NOTE:name:content]` — Add lead note
- `[CREATE_LEAD:name:phone:interest]` — Create new lead
- `[MONDAY_STATS]` — Pipeline statistics
- `[CLOSE:phone:won|lost]` — Close deal
- `[QUOTE:name:service:price:url?]` — Generate PDF quote
- `[FB_REPORT:today|yesterday|last_7d|last_30d]` — Facebook ads report
- `[FB_PAUSE:id]` / `[FB_RESUME:id]` / `[FB_BUDGET:id:amount]` — Campaign controls
- `[RULE:text]` / `[LIST_RULES]` / `[REMOVE_RULE:id]` — Self-learning rules
- `[BOOK:YYYY-MM-DD:HH:mm]` — Book calendar meeting
- `[ESCALATE]` — Hand off to boss
- `[VOICE]` — Send voice message
- `[REMINDER:HH:mm:message]` — Schedule reminder

### Multi-Tenant Config
All business-specific data lives in the `tenant_config` DB table (not code). To clone for a new business:
1. Change env vars (API keys, phone, board IDs)
2. Update `tenant_config` rows: business_name, owner_name, admin_phone, service_catalog, portfolio, sales_faq, sales_objections, bot_personality
3. Deploy — the bot adapts automatically

### Google Calendar Integration
Uses a Google Apps Script proxy (`google-apps-script/calendar-proxy.gs`):
1. Deploy script to Google Apps Script (Web App, execute as you, access: Anyone)
2. Set URL as `GOOGLE_CALENDAR_SCRIPT_URL`
3. Supports: `freeBusy` (available slots) and `add` (book meeting)

### Facebook Multi-Account
Hardcoded account mapping in `src/facebook/api.ts`:
- Account configs: `AD_ACCOUNTS` object with account IDs and token env var names
- To add accounts: add entry to `AD_ACCOUNTS` + set env var

### Monday.com Multi-Board
- Board IDs from env vars: `MONDAY_BOARD_ID`, `MONDAY_BOARD_ID_DPRISHA`
- `getAllBoardIds()` returns configured boards
- All operations (search, stats, create) work across all boards

## Database Tables
- `leads` — Lead records (phone, name, status, interest, notes, score, monday_item_id)
- `messages` — Conversation history (phone, direction, content)
- `follow_ups` — Scheduled follow-up messages (3 per lead: 24h, 2d, 4d)
- `reminders` — Boss-scheduled reminders
- `tenant_config` — Business configuration (key-value)
- `bot_rules` — Self-learning rules from boss corrections

## Deployment (Railway)

```bash
# Deploy
git add -A && git commit -m "..." && git push

# Or direct deploy
railway up --detach

# Check logs
railway logs --tail 20

# Set env var
railway variables --set "KEY=value"
```

### Railway Setup
- **Volume**: Mount `/data` for DB + WhatsApp session persistence
- **Dockerfile**: Multi-stage (node:22-slim + Chromium for Puppeteer)
- **Port**: 3000
- **Health**: `GET /health`

## Cloning for a New Business

1. Fork the repo
2. Create Railway project with volume mount `/data`
3. Set all env vars (see table above)
4. First run: bot creates DB + seeds default config
5. Update `tenant_config` via SQLite or add a seed script:
   ```sql
   UPDATE tenant_config SET value = 'NewBusiness' WHERE key = 'business_name';
   UPDATE tenant_config SET value = 'Owner Name' WHERE key = 'owner_name';
   UPDATE tenant_config SET value = '972XXXXXXXXX' WHERE key = 'admin_phone';
   -- Update: service_catalog, portfolio, sales_faq, sales_objections, bot_personality
   ```
6. Deploy Google Apps Script for calendar (copy `google-apps-script/calendar-proxy.gs`)
7. Update Facebook account IDs in `src/facebook/api.ts` (TODO: move to config)
8. Scan QR code at `https://your-app.up.railway.app/qr`

## Code Conventions
- ESM imports with `.js` extension (even for `.ts` files)
- Pino logger: `createLogger('module-name')`
- All DB queries use parameterized statements (no SQL injection)
- Functions that call external APIs never throw — return empty/false on error
- Hebrew text in system prompts and user-facing messages
- Tests: Vitest with `__tests__/` folders next to source

## Known Limitations
- Facebook account IDs are hardcoded in `src/facebook/api.ts` — should move to tenant_config
- Rate limiter is in-memory — resets on restart
- WhatsApp session requires QR scan on first deploy (then persists in volume)
- Google Calendar proxy is a separate Google Apps Script deployment per business
