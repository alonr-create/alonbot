# AlonBot Technology Stack

## Language and Runtime

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 22 (`node:22-slim` Docker image)
- **Module System**: ESM (`"type": "module"` in `package.json`)
- **TypeScript target**: ES2022, `NodeNext` module resolution
- **Convention**: Imports use `.js` extension (TypeScript ESM convention)

## Frameworks and Key Libraries

| Package | Version | Purpose |
|---|---|---|
| `@anthropic-ai/sdk` | ^0.78.0 | Claude API (Sonnet 4 / Opus 4) — main AI engine |
| `grammy` | ^1.35.0 | Telegram Bot framework |
| `@whiskeysockets/baileys` | ^6.7.16 | WhatsApp Web multi-device client |
| `@hapi/boom` | ^10.0.1 | HTTP-friendly error objects (used by Baileys) |
| `express` | ^5.2.1 | HTTP server (health, dashboard, chat API, tool proxy) |
| `better-sqlite3` | ^12.6.2 | SQLite database (sync API) |
| `sqlite-vec` | ^0.1.7-alpha.2 | SQLite vector search extension (vec0 virtual tables) |
| `dotenv` | ^17.3.1 | Environment variable loading from `.env` |
| `node-cron` | ^4.0.7 | Cron job scheduler (Israel timezone) |
| `nodemailer` | ^8.0.1 | Gmail SMTP email sending |
| `qrcode-terminal` | ^0.12.0 | QR code display for WhatsApp pairing |

### Dev Dependencies

| Package | Version | Purpose |
|---|---|---|
| `typescript` | ^5.9.0 | TypeScript compiler |
| `tsx` | ^4.19.0 | Dev-time TypeScript execution with watch mode |
| `@types/better-sqlite3` | * | Type definitions |
| `@types/express` | ^5.0.6 | Type definitions |
| `@types/node` | ^22.15.0 | Type definitions |
| `@types/nodemailer` | ^7.0.11 | Type definitions |

## Build System and Tooling

- **Dev**: `npm run dev` — `tsx watch src/index.ts` (auto-reload on changes)
- **Build**: `npm run build` — `tsc` (compiles `src/` to `dist/`)
- **Start**: `npm start` — `node dist/index.js`
- **Output**: `dist/` directory mirrors `src/` structure with `.js` + `.d.ts` files
- **Config**: `tsconfig.json` — strict mode, declaration generation, skipLibCheck

## Configuration Approach

### Environment Variables (`.env`)

All configuration loaded via `dotenv` in `src/utils/config.ts`. Single config object exported:

- **Required**: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM`
- **Optional AI**: `GEMINI_API_KEY` (image gen, embeddings, web research, vision, fallback)
- **Optional integrations**: `MONDAY_API_KEY`, `ELEVENLABS_API_KEY`, `GROQ_API_KEY`, `GMAIL_USER`/`GMAIL_APP_PASSWORD`, `GOOGLE_CALENDAR_SCRIPT_URL`
- **Deployment**: `MODE` (cloud|local), `PORT` (default 3700), `LOCAL_API_SECRET`
- **Security**: `ALLOWED_TELEGRAM` (comma-separated user IDs), `ALLOWED_WHATSAPP` (comma-separated phone numbers)

### Dual-Mode Architecture

The bot runs in two modes controlled by `MODE` env var:

- **`cloud`** (Render): Full Telegram polling + cron jobs. Proxies local-only tools (screenshot, manage_project, send_file) to Mac via tunnel.
- **`local`** (Mac): Cron only, send-only Telegram (no polling to avoid token conflict). Exposes tool API at `/api/tool`. Optional WhatsApp adapter.

### Cloud-Local Bridge

- Local Mac runs `start-tunnel.sh` (Cloudflare tunnel) to expose `localhost:3700`
- Tunnel URL registered to cloud via `POST /api/register-local`
- Cloud proxies `LOCAL_ONLY_TOOLS` requests to Mac's `/api/tool` endpoint
- Auth via `LOCAL_API_SECRET` Bearer token

### Skills System

- Markdown files in `skills/` directory
- Loaded at runtime by `src/skills/loader.ts`
- Injected into system prompt as available capabilities
- Current skills: `daily-brief.md`, `morning-greeting.md`

## Deployment Setup

### Docker (`Dockerfile`)

```
Base: node:22-slim
Build deps: python3, make, g++, curl, git, jq
Steps: npm ci → tsc → npm prune --production
Extra: installs @anthropic-ai/claude-code globally (for code_agent tool)
Dirs: data/, workspace/
Port: 3700
```

### Render (`render.yaml`)

- **Service type**: Web (Docker runtime)
- **Plan**: Free
- **Region**: Frankfurt
- **Health check**: `GET /health`
- **All API keys**: set as Render env vars (sync: false)

### Express Server (`src/gateway/server.ts`)

- Port 3700
- Health endpoint: `GET /health`
- Dashboard: `GET /dashboard?token=SECRET` (inline HTML)
- Web Chat: `GET /chat?token=SECRET` (inline HTML)
- Dashboard API: `/api/dashboard/{stats,memories,tasks,messages,costs,knowledge,workflows,tools}`
- Chat API: `POST /api/chat` (sends message through full agent pipeline)
- Tool proxy: `POST /api/tool` (local mode only)
- Registration: `POST /api/register-local` (cloud mode only)

### Data Persistence

- SQLite database at `data/alonbot.db` (WAL mode)
- WhatsApp session at `data/whatsapp-session/`
- Automated daily DB backup at 02:00 (VACUUM INTO → send to Telegram as file)

## Source File Structure

```
src/
  index.ts              — Entry point, cron jobs, adapters, startup
  types.d.ts            — Module declarations
  agent/
    agent.ts            — Message handler, Claude API calls, Gemini fallback, streaming
    tools.ts            — 35+ tool definitions + executeTool() switch
    system-prompt.ts    — Dynamic system prompt builder (static cached + dynamic parts)
    memory.ts           — Message history, memories CRUD, vector search, maintenance
    knowledge.ts        — RAG: ingest URLs/text, chunk, embed, semantic search
    batch.ts            — Claude Batch API for async summarization
    workflows.ts        — Keyword/cron/event triggered automation workflows
  channels/
    types.ts            — UnifiedMessage, UnifiedReply, ChannelAdapter interfaces
    telegram.ts         — grammY adapter (commands, menu, photos, voice, docs, stickers, audio)
    whatsapp.ts         — Baileys adapter (text messages, pairing code auth)
  gateway/
    server.ts           — Express server, dashboard HTML, chat API
    router.ts           — Adapter registry, message routing, streaming orchestration
  cron/
    scheduler.ts        — DB-driven cron scheduler with live registration
  utils/
    config.ts           — Environment config loader
    db.ts               — SQLite init, schema, migrations, vec0 tables
    embeddings.ts       — Gemini embedding API (768-dim)
  skills/
    loader.ts           — Markdown skill file loader
```
