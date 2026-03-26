# Codebase Structure

**Analysis Date:** 2026-03-26

## Directory Layout

```
alonbot/
├── src/                           # TypeScript source code (ESM, .ts files)
│   ├── index.ts                   # Entry point: init DB, load tools, start adapters & server
│   ├── agent/                     # AI agent & context management
│   │   ├── agent.ts               # Claude API agentic loop, rate limiting, model fallback
│   │   ├── system-prompt.ts       # 55KB Hebrew system prompt w/ tool descriptions
│   │   ├── memory.ts              # Conversation history, summaries, embeddings, semantic search
│   │   ├── knowledge.ts           # Web learning (Firecrawl), vector search
│   │   ├── batch.ts               # Claude Batch API processing
│   │   ├── model-router.ts        # Model selection, free tier fallbacks (Gemini, Hailuo)
│   │   ├── tools.ts               # Tool execution dispatcher
│   │   └── workflows.ts           # Keyword-based flow matching
│   ├── channels/                  # Platform adapters (unified message abstraction)
│   │   ├── types.ts               # UnifiedMessage, UnifiedReply, ChannelAdapter interfaces
│   │   ├── telegram.ts            # grammy-based Telegram adapter (polling + webhook)
│   │   ├── whatsapp-cloud.ts      # Meta Cloud API adapter (webhook-only)
│   │   └── whatsapp.ts            # Baileys adapter (local-only, QR auth)
│   ├── gateway/                   # HTTP server & message routing
│   │   ├── server.ts              # Express server (113KB): dashboards, PWA, webhooks, APIs
│   │   ├── router.ts              # Message deduplication, rate limiting, tool label mapping
│   │   ├── followup-engine.ts     # Lead follow-up templates + automation
│   │   └── flow-engine.ts         # Chatbot flows (n8n-style: steps, conditions, delays)
│   ├── tools/                     # Tool plugin system
│   │   ├── registry.ts            # Auto-discovers handlers in handlers/, validates, proxies to local
│   │   ├── types.ts               # ToolHandler, ToolContext interfaces
│   │   ├── media.ts               # Media queue (images, voice, documents per request)
│   │   ├── workflow-actions.ts    # Manual action execution (deprecated, for legacy flows)
│   │   └── handlers/              # 40+ tool implementations
│   │       ├── web-search.ts
│   │       ├── web-research.ts
│   │       ├── browse-url.ts
│   │       ├── scrape-site.ts
│   │       ├── analyze-image.ts
│   │       ├── generate-image.ts
│   │       ├── send-email.ts
│   │       ├── send-voice.ts
│   │       ├── send-file.ts
│   │       ├── shell.ts            # Local shell execution with blocklist
│   │       ├── screenshot.ts        # Local Mac screenshot
│   │       ├── camera.ts            # Local Mac camera capture
│   │       ├── claude-code.ts       # Spawn Claude Code IDE
│   │       ├── claude-agent.ts      # Secondary agent for sub-tasks
│   │       ├── remember.ts          # Vector-backed memory save
│   │       ├── knowledge.ts         # Query knowledge base
│   │       ├── calendar.ts          # Google Calendar integration
│   │       ├── monday.ts            # Monday.com API (leads, boards, queries)
│   │       ├── github.ts            # GitHub repo creation
│   │       ├── deploy.ts            # Vercel/Railway deployment
│   │       ├── build-website.ts     # Website generation
│   │       ├── auto-improve.ts      # Self-improvement prompt
│   │       ├── manage-project.ts    # Workspace/project management
│   │       ├── save-survey.ts       # Lead survey capture
│   │       ├── workflows.ts         # Workflow execution
│   │       ├── cron-script.ts       # Scheduled script definition
│   │       ├── schedule-message.ts  # Defer message delivery
│   │       ├── reminders.ts         # Reminder CRUD
│   │       ├── calculator.ts        # Math/unit conversions
│   │       ├── weather.ts           # Weather API
│   │       ├── api-costs.ts         # Token cost tracking
│   │       ├── fb-ads.ts            # Facebook Ads API
│   │       └── [others]             # ~10 more handlers
│   ├── cron/                      # Scheduled jobs
│   │   └── scheduler.ts           # node-cron wrapper, script execution with blocklist
│   ├── migrations/                # Database schema migrations
│   │   └── 001-initial.ts         # Initial tables
│   ├── utils/                     # Utilities
│   │   ├── config.ts              # ENV var loading (mode, tokens, API keys)
│   │   ├── db.ts                  # SQLite: WAL mode, sqlite-vec, schema
│   │   ├── logger.ts              # Pino logger factory
│   │   ├── shell.ts               # Shell execution wrapper (sh/bash)
│   │   ├── shell-blocklist.ts     # Dangerous command whitelist
│   │   ├── embeddings.ts          # Vector encoding (via API)
│   │   ├── git-auth.ts            # GIT_ASKPASS setup for git operations
│   │   ├── github.ts              # GitHub API helper
│   │   ├── migrate.ts             # Run migrations on startup
│   │   ├── retry.ts               # Exponential backoff retry wrapper
│   │   ├── sanitize.ts            # Path/input sanitization
│   │   ├── security.ts            # Crypto (HMAC verification)
│   │   ├── monday-leads.ts        # Monday.com lead enrichment
│   │   └── workspaces.ts          # Workspace CRUD (Dekel vs. Alon.dev)
│   ├── skills/                    # Skill definitions (metadata, not active tools)
│   ├── views/                     # HTML/JS frontend assets (served via Express)
│   │   ├── dashboard.html         # Main lead management dashboard
│   │   ├── chat.html              # Chat interface
│   │   ├── wa-inbox.html          # WhatsApp inbox view
│   │   ├── wa-mobile.html         # Mobile PWA version
│   │   ├── manifest.json          # PWA manifest
│   │   ├── sw.js                  # Service worker (offline support)
│   │   ├── icon-*.png             # App icons
│   │   └── [other assets]
│   └── types.d.ts                 # Global TypeScript definitions
├── dist/                          # Compiled JavaScript (ignored in repo, generated by tsc)
├── data/                          # Runtime data directory (SQLite DB, media, config)
│   ├── alonbot.db                 # SQLite database
│   ├── media/                     # Incoming WhatsApp images/documents
│   ├── slug_mapping.json          # Preview site slug → URL mapping
│   └── [cached assets]
├── scripts/                       # Utility shell scripts
├── tests/                         # Vitest test files
├── .planning/                     # Claude Code planning directory
│   └── codebase/                  # Architecture docs (ARCHITECTURE.md, STRUCTURE.md, etc.)
├── .env                           # Environment variables (secrets, tokens, API keys)
├── .env.example                   # Example env vars (safe to commit)
├── tsconfig.json                  # TypeScript compiler config
├── package.json                   # Dependencies (Claude SDK, express, grammy, zod, etc.)
├── Dockerfile                     # Production image (Node.js 20)
├── render.yaml                    # Render deployment config
├── CLAUDE.md                      # Brief instructions for Claude Code
└── README.md                      # Project overview

```

## Directory Purposes

**src/:**
- Purpose: All TypeScript source code. ESM module format with .js imports.
- Contains: Organized by feature (agent, channels, gateway, tools, cron, utils)
- Key files: `index.ts` (startup), `agent/agent.ts` (core logic), `tools/registry.ts` (plugin system)

**src/agent/:**
- Purpose: AI orchestration, context management, memory, system prompt
- Contains: Claude API integration, vector embeddings, conversation history, summaries
- Key files: `agent.ts` (main loop), `memory.ts` (vectors + summaries), `system-prompt.ts` (55KB Hebrew)

**src/channels/:**
- Purpose: Platform-specific adapters (Telegram, WhatsApp Cloud, Baileys)
- Contains: Message parsing, reply formatting, webhook handlers
- Key files: `types.ts` (shared interfaces), `telegram.ts`, `whatsapp-cloud.ts`, `whatsapp.ts`

**src/gateway/:**
- Purpose: HTTP server, message routing, lead CRM, dashboard APIs
- Contains: Express endpoints, WebSocket, lead scoring, flow/followup engines
- Key files: `server.ts` (113KB, all endpoints), `router.ts` (dedup + rate limit), `flow-engine.ts`, `followup-engine.ts`

**src/tools/:**
- Purpose: Extensible action registry for the agent
- Contains: Auto-discovered handler plugins, validation, local tool proxying
- Key files: `registry.ts` (loader), `types.ts` (interfaces), `handlers/` (40+ implementations)

**src/cron/:**
- Purpose: Database-driven scheduled jobs
- Contains: node-cron wrapper, script execution with security blocklist
- Key files: `scheduler.ts`

**src/utils/:**
- Purpose: Shared utilities for all layers
- Contains: Config, database, logging, shell, security, APIs
- Key files: `config.ts` (env vars), `db.ts` (SQLite + migrations), `logger.ts`

**src/views/:**
- Purpose: Frontend assets served by Express (dashboards, PWA)
- Contains: HTML, JavaScript, icons, service worker
- Key files: `dashboard.html` (lead management), `sw.js` (offline cache)

**data/:**
- Purpose: Runtime persistent state (not committed to git)
- Contains: SQLite database, incoming media, config JSON
- Key files: `alonbot.db`

**dist/:**
- Purpose: Compiled JavaScript output from TypeScript
- Contains: Generated by `npm run build`, ignored in git
- Key files: Mirrors src/ structure

## Key File Locations

**Entry Points:**
- `src/index.ts`: Application startup (init DB, load tools, register adapters, start server/cron)

**Configuration:**
- `src/utils/config.ts`: Environment variable parsing (mode, tokens, API keys)
- `.env`: Secrets (never committed, loaded by config.ts)
- `.env.example`: Safe example (documenting required vars)

**Core Logic:**
- `src/agent/agent.ts`: Main Claude API agentic loop
- `src/gateway/router.ts`: Message routing, deduplication, rate limiting
- `src/tools/registry.ts`: Tool plugin loader
- `src/agent/memory.ts`: Context management, embeddings, summaries

**Database:**
- `src/utils/db.ts`: SQLite connection, schema, prepared statements
- `data/alonbot.db`: Persistent database file

**Testing:**
- `tests/`: Vitest test files (if any exist)

## Naming Conventions

**Files:**
- Handlers: `kebab-case.ts` (e.g., `web-search.ts`, `send-voice.ts`)
- Modules: `kebab-case.ts` (e.g., `system-prompt.ts`, `shell-blocklist.ts`)
- Functions: `camelCase` (e.g., `handleMessage`, `executeFlow`, `getSmartContext`)
- Exports: Named exports for utilities, default export for handlers/adapters

**Directories:**
- Feature-based: `agent/`, `channels/`, `gateway/`, `tools/`, `utils/`
- Nested: `tools/handlers/` for plugins
- Assets: `views/`, `data/`, `dist/`

**Database Tables:**
- Snake_case with singular/plural context: `messages`, `memories`, `memory_vectors`, `conversation_summaries`, `cron_jobs`, `tasks`, `scheduled_messages`, `leads`, `api_usage`

**Environment Variables:**
- Uppercase, underscore-separated: `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `ALONBOT_SECRET`
- Config object exposes lowercase: `config.telegramBotToken`

## Where to Add New Code

**New Tool:**
1. Create `src/tools/handlers/my-tool.ts`
2. Export default a `ToolHandler` implementing `{ name, definition (Anthropic.Tool), schema (Zod), execute, localOnly? }`
3. Registry auto-discovers on startup — no other file edits needed
4. Add to system prompt (`src/agent/system-prompt.ts`) for agent awareness
5. Example: `src/tools/handlers/web-search.ts`

**New Channel Adapter:**
1. Create `src/channels/my-platform.ts`
2. Export `createMyAdapter(): ChannelAdapter` implementing the interface
3. Register in `src/index.ts` (similar to Telegram/WhatsApp registration)
4. Add webhook endpoint if applicable in `src/gateway/server.ts`
5. Update `src/channels/types.ts` if new message properties needed

**New Database Table:**
1. Add migration in `src/migrations/` (e.g., `002-add-feature.ts`)
2. Call `runMigrations(db)` in `src/index.ts` (already does this)
3. Add prepared statements in `src/utils/db.ts` if frequently accessed

**New API Endpoint:**
1. Add handler in `src/gateway/server.ts` (e.g., `app.get('/api/my-endpoint', ...)`)
2. Use auth middleware: check `req.headers['x-api-secret'] === config.dashboardSecret`
3. Response format: JSON with `{ success, data/error, details }`

**New Dashboard Page:**
1. Create `src/views/my-page.html`
2. Add route in `src/gateway/server.ts` (e.g., `/my-page`)
3. Pass token via query string: `/my-page?token=X`
4. Client fetches data via `/api/` endpoints (authenticated)
5. Can use WebSocket for real-time updates (see dashboard.html)

**New Cron Job:**
1. Use `addCronJob(name, cronExpr, channel, targetId, message)` from `src/cron/scheduler.ts`
2. Or register via DB table directly: `INSERT INTO cron_jobs (...)`
3. Cron expression validated with node-cron at insert
4. Timezone: Asia/Jerusalem (Israel time)

## Special Directories

**src/views/:**
- Purpose: Frontend HTML/JS served by Express (PWA + dashboards)
- Generated: No, hand-edited HTML
- Committed: Yes, included in dist on build (see postbuild script in package.json)

**data/:**
- Purpose: Runtime persistent storage (SQLite, media, config)
- Generated: Yes, created at first run
- Committed: No, in .gitignore

**dist/:**
- Purpose: Compiled JavaScript output
- Generated: Yes, by `npm run build` (tsc)
- Committed: No, in .gitignore

**.planning/codebase/:**
- Purpose: Claude Code planning documents (architecture, structure, testing, concerns)
- Generated: Yes, by `/gsd:map-codebase` command
- Committed: Yes, tracked in git for context continuity

**node_modules/:**
- Purpose: Installed dependencies
- Generated: Yes, by npm install
- Committed: No, in .gitignore

---

*Structure analysis: 2026-03-26*
