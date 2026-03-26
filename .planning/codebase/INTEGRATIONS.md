# External Integrations

**Analysis Date:** 2025-03-26

## APIs & External Services

**Messaging & Communication:**
- **Telegram Bot API** - Polling and webhook modes
  - SDK: grammy 1.35.0
  - Auth: `TELEGRAM_BOT_TOKEN` env var
  - Implementation: `src/channels/telegram.ts`
  - Webhook endpoint: `/telegram-webhook`
  - Features: text, media, commands, export chat history

- **WhatsApp Cloud API (Meta Graph API)** - Business messaging
  - Auth: `WA_CLOUD_TOKEN` (Bearer token)
  - Configuration: `WA_CLOUD_PHONE_ID`, `WA_CLOUD_WABA_ID`
  - API base: `https://graph.facebook.com/v21.0`
  - Implementation: `src/channels/whatsapp-cloud.ts`
  - Webhook endpoint: `/whatsapp-cloud-webhook`
  - Media upload: `/{phoneId}/media` endpoint with Bearer auth
  - Features: text messages, media, read receipts, status updates

- **WhatsApp Baileys (Local Mode)** - Alternative WhatsApp client
  - Package: @whiskeysockets/baileys 6.7.21
  - Implementation: `src/channels/whatsapp.ts`
  - Authentication: QR code-based (local only, no API key needed)
  - Phone numbers: `ALLOWED_WHATSAPP` whitelist
  - Use case: Local development when Cloud API unavailable
  - Fallback: Cannot run on Render (cloud only)

**AI & LLM Services:**
- **Anthropic Claude API** - Primary LLM inference
  - SDK: @anthropic-ai/sdk 0.78.0
  - Auth: `ANTHROPIC_API_KEY` env var
  - Implementation: `src/agent/agent.ts`
  - Features: text generation, tool use, vision (image analysis)
  - Fallback: Gemini free tier when Claude 429-rate-limited
  - Batch API: Asynchronous batch processing (`src/agent/batch.ts`)

- **Google Gemini API** - Free tier fallback + image generation
  - Auth: `GEMINI_API_KEY` env var
  - Endpoints used:
    - `generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent` (image generation)
  - Implementation: `src/tools/handlers/generate-image.ts`, `src/agent/agent.ts`
  - Use case: Image generation, fallback inference when Claude unavailable

- **Groq API** - Optional LLM fallback (configured but not actively used)
  - Auth: `GROQ_API_KEY` env var
  - Status: Available in model router but no active calls

**Text-to-Speech:**
- **ElevenLabs** - Voice synthesis for TTS messages
  - Auth: `ELEVENLABS_API_KEY` env var
  - Voice ID (default): `afovcnSM12xH5rD4hdwt` (Alon voice)
  - Alternative voices: yael, robot, monster, wizard, santa, english, woman
  - Model: eleven_v3 (hardcoded, not turbo to preserve Hebrew)
  - Endpoint: `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}`
  - Implementation: `src/tools/handlers/send-voice.ts`
  - Output format: OGG Opus
  - Settings: stability, similarity_boost, style (per preset)

## Data Storage

**Databases:**
- **SQLite 3** - Primary persistent storage
  - Location: `data/alonbot.db` (or `$DATA_DIR/alonbot.db`)
  - Client: better-sqlite3 (sync)
  - Schema: 30+ tables (messages, memories, leads, tasks, workflows, etc.)
  - Vector tables: memory_vectors, knowledge_vectors (768-dim float arrays)
  - Extensions: sqlite-vec (vector search)
  - Backup: Daily automatic backup to Telegram (02:00 Israel time)

**File Storage:**
- **Local filesystem** - All persistent data
  - Database: `data/alonbot.db`
  - Workspace config: `workspace/` directory
  - Skills directory: `skills/` for custom tools
  - Temp files: `/tmp/` for media, QR codes, backups

**No External Database:**
- All data remains local or in Render's `/data` volume
- No third-party database service (MongoDB, PostgreSQL, etc.)

## Authentication & Identity

**Auth Methods:**
1. **API Key-based:**
   - `ANTHROPIC_API_KEY` - Claude API
   - `ELEVENLABS_API_KEY` - ElevenLabs TTS
   - `GEMINI_API_KEY` - Google Gemini
   - `GROQ_API_KEY` - Groq API
   - `TELEGRAM_BOT_TOKEN` - Telegram bot
   - `MONDAY_API_KEY` - Monday.com GraphQL

2. **Bearer Tokens:**
   - `WA_CLOUD_TOKEN` - WhatsApp Cloud API (Meta Graph API)
   - `FB_ACCESS_TOKEN` - Facebook Ads (System User token, never expires)
   - `WA_CLOUD_WABA_ID` - WhatsApp Business Account ID
   - `WA_CLOUD_PHONE_ID` - WhatsApp Phone Number ID

3. **Custom Secrets:**
   - `LOCAL_API_SECRET` - Internal API authentication (auto-generated if missing)
   - `DASHBOARD_SECRET` - Dashboard access token (alias: LOCAL_API_SECRET)

4. **Allowlist-based:**
   - `ALLOWED_TELEGRAM` - Comma-separated list of Telegram user IDs
   - `ALLOWED_WHATSAPP` - Comma-separated list of WhatsApp phone numbers

5. **OAuth/Session-based:**
   - Google Calendar: External integration via `GOOGLE_CALENDAR_SCRIPT_URL` (requires manual setup)
   - Not implemented: Google Drive, Sheets, or native OAuth flow

**No Third-Party Auth:**
- No built-in Supabase, Firebase, Auth0, or similar
- All authentication is token/key-based from external services

## Monitoring & Observability

**Error Tracking:**
- None detected - Not integrated with Sentry, Datadog, or similar
- Logging: Pino (structured JSON to stdout)
- Log level configurable, default: info

**Logs:**
- **Pino logger** - Structured JSON logging to stdout
- Log modules: main, db, agent, gateway, channels, tools, cron, etc.
- Log file: Captured by container runtime / Render logs
- No persistent log storage (Render retains last ~10k lines)

**Metrics:**
- API usage tracking: `api_usage` table in SQLite
  - Columns: model, input_tokens, output_tokens, cost_usd, created_at
  - Cost alerts: Daily limit $0.50 (configurable)
  - Usage: Cost alert cron at 21:00 Israel time

## CI/CD & Deployment

**Hosting:**
- Render.com - Current production host
- Repository: Likely git-based with auto-deploy on push
- Build: Dockerfile (Node 22-slim + build tools)
- Environment: `MODE=cloud` for cloud deployment, `MODE=local` for local Mac

**CI Pipeline:**
- Not explicitly configured
- Render likely auto-builds and deploys on git push
- No GitHub Actions, GitLab CI, or CircleCI observed

**Deployment Checklist:**
- Set `MODE=cloud` in Render environment
- Configure all required env vars (ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, etc.)
- Mount `/data` volume for SQLite persistence
- Expose port 3700

## Webhooks & Callbacks

**Incoming Webhooks (Server listens):**
- **Telegram Webhook** - `/telegram-webhook`
  - Source: Telegram Bot API (outbound)
  - Auth: Token implicit (webhook URL registration)
  - Payload: Telegram update object
  - Implementation: grammy webhook callback

- **WhatsApp Cloud Webhook** - `/whatsapp-cloud-webhook`
  - Source: Meta Graph API (outbound)
  - Auth: Bearer token verification (webhook verify token in setup)
  - Payload: WhatsApp business account messages, statuses
  - Implementation: `src/channels/whatsapp-cloud.ts`
  - Events: messages, read receipts, delivery status, message_template_status_update

- **Custom Webhook** - `/api/*` endpoints
  - Local API: `/api/send-whatsapp`, `/api/send-telegram`
  - Auth: `x-api-secret` header
  - Implementation: `src/gateway/server.ts`

**Outgoing Callbacks (Bot makes requests):**
1. **Monday.com GraphQL** - `https://api.monday.com/v2`
   - Purpose: Query leads, update status, fetch board items
   - Auth: `Authorization: <MONDAY_API_KEY>`
   - Implementation: `src/index.ts` (lead outreach cron), `src/tools/handlers/monday.ts`
   - Mutations: change_simple_column_value (update lead status)

2. **Facebook Graph API** - `https://graph.facebook.com/v21.0`
   - Purpose: Ad account insights, campaign details, budget updates, CAPI sync
   - Auth: Bearer token
   - Implementation: `src/tools/handlers/fb-ads.ts`
   - Endpoints: `/{accountId}/campaigns`, `/{campaignId}/insights`, `/{adsetId}`, `/set_value`, `/{entityId}/live_data`

3. **Google Calendar API** - External script (custom Apps Script)
   - URL: `GOOGLE_CALENDAR_SCRIPT_URL` env var
   - Purpose: List events, add events, update events, delete events
   - Auth: Implicit (via script endpoint)
   - Implementation: `src/tools/handlers/calendar.ts`
   - Query params: action, days, title, date, time, description, etc.

4. **ElevenLabs API** - `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}`
   - Purpose: Text-to-speech synthesis
   - Auth: Bearer token (`xi-api-key`)
   - Implementation: `src/tools/handlers/send-voice.ts`
   - Response: Audio stream (OGG Opus)

5. **Gmail SMTP** - `smtp.gmail.com`
   - Purpose: Send emails
   - Auth: nodemailer with Gmail app password
   - Implementation: `src/tools/handlers/send-email.ts`
   - Recipient whitelist: `ALLOWED_EMAILS` (enforced by `isEmailAllowed()`)

6. **DuckDuckGo Search** - `https://html.duckduckgo.com/html/`
   - Purpose: Web search (no API, HTML scraping)
   - Auth: None (User-Agent spoofing)
   - Implementation: `src/tools/handlers/web-search.ts`
   - Results: 8 top hits with title, snippet, URL

## Lead Management & Pipelines

**Lead Ingestion:**
- **Alon.dev Leads** - Monday.com board "לידים אלון" (5092777389)
  - Cron: Every 5 minutes (`src/index.ts` line 332)
  - Columns: phone, source, service, message
  - Action: Auto-send WhatsApp greeting, mark status as "Done"
  - Local DB: `leads` table (phone, name, source, status)

**Lead Follow-up:**
- **Automated Follow-ups** - Template-based via `followup-engine.ts`
  - Templates: 3 default (day 3, day 5, day 8) per workspace
  - Trigger: Time-based (background cron every minute)
  - Delivery: WhatsApp messages with optional voice attachments
  - Workspace support: alon_dev, dekel (separate templates per business)

**Abandoned Cart Recovery:**
- **Checkout Monitoring** - Every 10 minutes (`src/index.ts` line 226)
- **Trigger**: Unpaid checkout visits older than 30 minutes
- **Action**: Send WhatsApp reminder with checkout link
- **Quiet hours**: 22:00-08:00 Israel time (skip messages during night)

**Google Review Requests:**
- **Order Status** - Daily at 11:00 Israel time (`src/index.ts` line 259)
- **Trigger**: Orders delivered 48+ hours ago without review request
- **Action**: Send WhatsApp with Google Review link

## Configuration & Secrets

**Required Environment Variables:**
- `ANTHROPIC_API_KEY` - Claude API access (mandatory)
- `TELEGRAM_BOT_TOKEN` - Telegram bot activation
- `MODE` - 'cloud' or 'local' (default: local)

**Optional Environment Variables:**
- `MONDAY_API_KEY` - Monday.com GraphQL access
- `GEMINI_API_KEY` - Google Gemini image generation
- `ELEVENLABS_API_KEY` - ElevenLabs TTS
- `GROQ_API_KEY` - Groq API fallback
- `GMAIL_USER`, `GMAIL_APP_PASSWORD` - Email sending
- `ALLOWED_WHATSAPP`, `ALLOWED_TELEGRAM` - User whitelists
- `WA_CLOUD_TOKEN`, `WA_CLOUD_PHONE_ID`, `WA_CLOUD_WABA_ID` - WhatsApp Cloud API
- `FB_ACCESS_TOKEN` - Facebook Ads API
- `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` - Alternative WhatsApp (Evolution API)
- `GOOGLE_CALENDAR_SCRIPT_URL` - Google Calendar Apps Script URL
- `LOCAL_API_URL` - Internal API endpoint (for tool proxying)
- `LOCAL_API_SECRET` - Internal API authentication token
- `GROW_USER_ID`, `GROW_PAGE_CODE`, `GROW_API_URL` - Grow checkout integration
- `PORT` - HTTP server port (default: 3700)
- `DATA_DIR` - SQLite data directory (default: `data/` or `/data`)

**Secrets Location:**
- Local: `.env` file (git-ignored)
- Production (Render): Environment variable secrets in Render dashboard
- Never committed: API keys, tokens, credentials

## Integration Points Not Implemented

- Zapier / Make.com automation (no native integration)
- Slack (no Slack adapter, unlike Telegram/WhatsApp)
- Discord (no Discord bot)
- Firebase / Supabase (SQLite only)
- Twilio (no SMS)
- Stripe / Payment processors (Grow checkout only)
- CRM systems (Monday.com only)
- Native Google Drive / Sheets (only Calendar via Apps Script)
- Authentication: No OAuth2, Passport.js, or session management

---

*Integration audit: 2025-03-26*
