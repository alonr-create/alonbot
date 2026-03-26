# Technology Stack

**Analysis Date:** 2025-03-26

## Languages

**Primary:**
- TypeScript 5.9.0 - All source code (`src/` directory), compiles to ES2022+ JavaScript
- JavaScript (compiled output) - Runtime execution via Node.js

**Configuration:**
- JSON - `package.json`, configuration files
- SQL - SQLite database schemas in `src/utils/db.ts`

## Runtime

**Environment:**
- Node.js 22-slim (from Dockerfile) - Container runtime
- Node.js 22.15.0 (minimum target from package.json `@types/node`)

**Package Manager:**
- npm - Lockfile: `package-lock.json` present
- Production dependencies: 15 core packages
- Development dependencies: 5 packages (tsx, tsc, vitest, playwright, @types/*)

## Frameworks & Core Libraries

**Web Server:**
- Express 5.2.1 - HTTP server for webhooks and API endpoints (`src/gateway/server.ts`)

**Bot Platforms:**
- grammy 1.35.0 - Telegram bot framework with webhook + polling support (`src/channels/telegram.ts`)
- @whiskeysockets/baileys 6.7.21 - WhatsApp Baileys client for local mode (`src/channels/whatsapp.ts`)

**AI/LLM:**
- @anthropic-ai/sdk 0.78.0 - Claude API client for all AI inference (`src/agent/agent.ts`)

**Database:**
- better-sqlite3 12.6.2 - Synchronous SQLite driver (`src/utils/db.ts`)
- sqlite-vec 0.1.7-alpha.2 - Vector search extension (768-dim Gemini embeddings) (`src/utils/db.ts`)

**Scheduling & Jobs:**
- node-cron 4.0.7 - Cron expression parsing and scheduling (`src/index.ts`)

**Schema Validation:**
- zod 4.3.6 - Runtime schema validation for tool inputs (`src/tools/types.ts`)

**Testing:**
- vitest 4.0.18 - Unit test runner (`npm test`)
- playwright 1.58.2 - Browser automation (for web scraping tools)

**Utilities:**
- dotenv 17.3.1 - Environment variable loading (`src/utils/config.ts`)
- pino 10.3.1 - Structured JSON logging (`src/utils/logger.ts`)
- nodemailer 8.0.1 - Email sending via Gmail SMTP (`src/tools/handlers/send-email.ts`)
- web-push 3.6.7 - Web push notifications (future use, currently unused)
- form-data 4.0.5 - FormData encoding for multipart requests (Facebook Graph API)
- qrcode 1.5.4 - QR code generation (future use)
- qrcode-terminal 0.12.0 - Terminal QR code display (WhatsApp QR auth)
- ws 8.20.0 - WebSocket client (unused but available)

**Development:**
- tsx 4.19.0 - TypeScript executor for development (`npm run dev`)
- typescript 5.9.0 - TypeScript compiler

## Build System

**Compilation:**
- `tsc` (TypeScript compiler) - Compiles `src/` to `dist/`
- `postbuild` script - Copies `src/views/dist/views` (static assets for web UI)

**Development:**
- `tsx watch` - Hot-reload TypeScript development server

**ESM Configuration:**
- `"type": "module"` in package.json - All files are ES modules
- Imports use `.js` extensions per ESM spec

## Configuration Files

**Environment:**
- `.env` - Local development (not committed, load via dotenv)
- Production: Environment variables via deployment platform (Render)

**Build:**
- `tsconfig.json` - TypeScript compilation settings
- `vitest.config.ts` - Test runner configuration
- `Dockerfile` - Container image definition

**Application:**
- `src/utils/config.ts` - Central config loader with sensible defaults
  - Required: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`
  - Optional: Monday.com, Gmail, ElevenLabs, Gemini, Facebook, WhatsApp Cloud, Google Calendar API keys
  - Computed: `LOCAL_API_SECRET`, `DASHBOARD_SECRET` (auto-generated if missing)

## Data Persistence

**Primary Database:**
- SQLite 3 at `data/alonbot.db` (or `$DATA_DIR/alonbot.db`)
- WAL mode enabled for concurrent access
- Foreign keys enforced
- 30+ tables: messages, memories, tasks, leads, workflows, api_usage, batch_jobs, etc.
- Vector tables: `memory_vectors`, `knowledge_vectors` (768-dim float arrays via sqlite-vec)

**Backup Strategy:**
- Automatic daily backup at 02:00 Israel time via cron (`src/index.ts` line 178)
- Backup sent to Telegram as file attachment
- Manual export command via `/export` Telegram command

## External Data Storage

**File Storage:**
- Local filesystem: `data/` directory for SQLite database and backups
- `/tmp/` for temporary files (QR codes, media, backups)
- Container volume `/data` mounted in production (Render)

**Media Handling:**
- Temporary in-memory buffers for WhatsApp Cloud API media uploads
- Media cache directory: derived from `config.dataDir`

## Platform Requirements

**Development:**
- macOS/Linux/Windows with Node.js 22+
- Local WhatsApp requires Mac for Baileys (no Chrome needed)
- `ANTHROPIC_API_KEY` - Claude API access required
- Optional: `TELEGRAM_BOT_TOKEN`, `WA_CLOUD_TOKEN`, API keys for integrations

**Production (Cloud):**
- Render.com (current hosting) - auto-deploys from git
- Supports `MODE=cloud` for webhook-only operation (no polling)
- Memory: ~400-500MB (Node.js + SQLite + embedded vector DB)
- CPU: Single-threaded Node.js, benefits from 2+ cores
- Storage: 1GB recommended (SQLite + daily backups)

**Deployment:**
- Docker container via `Dockerfile` (Node 22-slim + build tools)
- Build: compiles TypeScript, removes devDeps with `npm prune --production`
- Startup: `node dist/index.js`
- Port: 3700 (configurable via `PORT` env var)

## Dependencies Architecture

**Core Flow:**
1. Express HTTP server (`gateway/server.ts`) receives Telegram/WhatsApp webhooks
2. Message routed to adapters (`channels/telegram.ts`, `channels/whatsapp-cloud.ts`)
3. Unified message passed to agent (`agent/agent.ts`)
4. Agent uses Claude SDK (`@anthropic-ai/sdk`) with dynamic tool definitions
5. Tools execute independently, access shared database (`utils/db.ts`)
6. Results returned via channel adapters (grammy, Baileys, or Graph API)

**Cron Jobs:**
- node-cron scheduler (`cron/scheduler.ts`) runs 15+ recurring jobs:
  - Smart daily brief (08:00)
  - Cost alerts (21:00)
  - Memory maintenance (03:00)
  - Lead follow-up checks
  - Abandoned cart recovery
  - Google review requests
  - Database backups (02:00)

**No External Package Dependencies for:**
- Web framework (built on Express)
- ORM (direct SQL via better-sqlite3)
- Task queue (node-cron + database polling)
- Authentication (env-based token + whitelist)

---

*Stack analysis: 2025-03-26*
