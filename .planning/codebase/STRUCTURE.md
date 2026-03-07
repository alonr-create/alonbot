# AlonBot Directory Structure

## Complete Layout

```
alonbot/
|-- .claude/                     # Claude Code project settings
|-- .env                         # Environment variables (API keys, tokens, config)
|-- .env.example                 # Template for .env
|-- .git/                        # Git repository
|-- .gitignore                   # Ignores node_modules, dist, data, .env
|-- .planning/                   # Planning documents
|   |-- codebase/
|       |-- ARCHITECTURE.md      # Architecture documentation
|       |-- STRUCTURE.md         # This file
|-- CLAUDE.md                    # Claude Code instructions for this project
|-- Dockerfile                   # Docker build (node:22-slim, includes Claude Code CLI)
|-- HISTORY.txt                  # Development changelog/history
|-- README.md                    # Project documentation
|-- alonbot-status.html          # Status report (static HTML)
|-- alonbot-status.pdf           # Status report (PDF export)
|-- data/                        # Runtime data directory
|   |-- alonbot.db               # SQLite database (created at runtime)
|   |-- whatsapp-session/        # WhatsApp auth session (created at runtime)
|-- dist/                        # Compiled JavaScript output (from tsc)
|-- docs/                        # Additional documentation
|-- node_modules/                # npm dependencies
|-- package.json                 # Project manifest and scripts
|-- package-lock.json            # Dependency lock file
|-- render.yaml                  # Render.com deployment config
|-- scripts/                     # Utility scripts (currently empty)
|-- skills/                      # Skill definition files
|   |-- morning-greeting.md      # Morning greeting skill
|-- src/                         # TypeScript source code
|   |-- index.ts                 # Main entry point — bootstraps everything
|   |-- types.d.ts               # Type declarations for untyped modules
|   |-- agent/                   # AI agent core
|   |   |-- agent.ts             # Message handler, Claude API loop, Gemini fallback
|   |   |-- batch.ts             # Anthropic Batch API (async jobs, summarization)
|   |   |-- knowledge.ts         # RAG knowledge base (ingest, chunk, search)
|   |   |-- memory.ts            # Memory system (messages, memories, summaries, vectors)
|   |   |-- system-prompt.ts     # Dynamic system prompt builder
|   |   |-- tools.ts             # Tool definitions (35+) and execution engine
|   |   |-- workflows.ts         # Workflow automation (keyword/cron/event triggers)
|   |-- channels/                # Chat platform adapters
|   |   |-- types.ts             # UnifiedMessage, UnifiedReply, ChannelAdapter interfaces
|   |   |-- telegram.ts          # Telegram adapter (grammY, commands, menus, voice STT)
|   |   |-- whatsapp.ts          # WhatsApp adapter (Baileys, pairing code auth)
|   |-- cron/                    # Scheduled task system
|   |   |-- scheduler.ts         # DB-driven cron job manager
|   |-- gateway/                 # HTTP server and message routing
|   |   |-- router.ts            # Adapter registry, message routing, streaming
|   |   |-- server.ts            # Express server (health, dashboard, chat, tool proxy)
|   |-- skills/                  # Skill loading
|   |   |-- loader.ts            # Reads .md skill files from skills/ directory
|   |-- utils/                   # Shared utilities
|       |-- config.ts            # Environment config loader (dotenv)
|       |-- db.ts                # SQLite setup, schema, migrations
|       |-- embeddings.ts        # Gemini embedding API wrapper
|-- start-tunnel.sh              # Script to start local tunnel for cloud-to-Mac proxy
|-- tsconfig.json                # TypeScript compiler configuration
```

## Key File Locations

### Where to find...

| What | File |
|------|------|
| Application bootstrap | `src/index.ts` |
| All cron schedules | `src/index.ts` (lines 54-234) |
| Claude API call logic | `src/agent/agent.ts` |
| Tool definitions array | `src/agent/tools.ts` (`allToolDefinitions`, line 85) |
| Tool execution switch | `src/agent/tools.ts` (`executeTool()`, line 263) |
| System prompt text | `src/agent/system-prompt.ts` |
| Database schema | `src/utils/db.ts` (lines 15-165) |
| Channel interfaces | `src/channels/types.ts` |
| Telegram commands | `src/channels/telegram.ts` (lines 49-318) |
| Dashboard HTML | `src/gateway/server.ts` (`getDashboardHTML()`, line 224) |
| Chat HTML | `src/gateway/server.ts` (`getChatHTML()`, line 406) |
| REST API endpoints | `src/gateway/server.ts` |
| Environment variables | `src/utils/config.ts` |
| Vector embeddings | `src/utils/embeddings.ts` |
| Memory retrieval logic | `src/agent/memory.ts` (`getRelevantMemories()`, line 183) |
| Security restrictions | `src/agent/tools.ts` (lines 34-83) |
| Workflow matching | `src/agent/workflows.ts` (`matchKeywordWorkflows()`, line 60) |
| Deployment config | `render.yaml` (Render), `Dockerfile` |

## Naming Conventions

### Files

- All source files are TypeScript (`.ts`)
- Imports use `.js` extension (TypeScript ESM convention): `import { config } from './utils/config.js'`
- One module per file, named by primary concept: `agent.ts`, `memory.ts`, `tools.ts`
- Type definition files: `types.ts` within a directory, `types.d.ts` for ambient declarations
- Skill files: kebab-case `.md` in `skills/` directory

### Exports

- Functions: `camelCase` -- `handleMessage()`, `executeTool()`, `saveMemory()`
- Interfaces/Types: `PascalCase` -- `UnifiedMessage`, `ChannelAdapter`, `Memory`, `Workflow`
- Constants: `UPPER_SNAKE_CASE` -- `LOCAL_ONLY_TOOLS`, `RATE_LIMIT`, `EMBEDDING_DIM`
- Config: single `config` object export from `src/utils/config.ts`
- DB: single `db` object export from `src/utils/db.ts`

### Patterns

- Factory functions for adapters: `createTelegramAdapter()`, `createWhatsAppAdapter()`
- Prepared statements: `const stmtXxx = db.prepare(...)` at module scope
- Tool definitions: inline objects in `allToolDefinitions` array, not separate files
- Tool execution: single `executeTool()` with a large switch-case

## Module Organization

### Dependency Graph (simplified)

```
index.ts
  |-- gateway/server.ts     (starts Express)
  |-- gateway/router.ts     (registers adapters, routes messages)
  |     |-- agent/agent.ts  (handles messages)
  |           |-- agent/system-prompt.ts
  |           |-- agent/memory.ts
  |           |-- agent/knowledge.ts
  |           |-- agent/tools.ts
  |           |     |-- agent/workflows.ts
  |           |     |-- agent/knowledge.ts
  |           |     |-- agent/memory.ts
  |           |     |-- cron/scheduler.ts
  |           |-- agent/batch.ts
  |-- channels/telegram.ts  (Telegram adapter)
  |-- channels/whatsapp.ts  (WhatsApp adapter)
  |-- cron/scheduler.ts     (DB-driven cron)
  |-- agent/memory.ts       (startup embedding)
  |-- utils/config.ts       (shared by all)
  |-- utils/db.ts           (shared by all)
  |-- utils/embeddings.ts   (used by memory + knowledge)
  |-- skills/loader.ts      (used by system-prompt)
```

### Shared State

- `db` (SQLite instance) -- imported from `src/utils/db.ts` by most modules
- `config` -- imported from `src/utils/config.ts` by most modules
- Adapter registry -- `Map` in `src/gateway/router.ts`
- Active cron tasks -- `Map` in `src/cron/scheduler.ts`
- Rate limit map -- `Map` in `src/agent/agent.ts`
- Pending media map -- `Map` in `src/agent/tools.ts` (per-request isolation)

## Database Tables

| Table | Purpose |
|-------|---------|
| `messages` | Conversation history (channel, sender, role, content) |
| `memories` | Long-term memories with type/category/importance |
| `memory_vectors` | sqlite-vec virtual table for semantic memory search (768-dim) |
| `conversation_summaries` | Compressed conversation summaries |
| `cron_jobs` | User-created recurring reminders/scripts |
| `api_usage` | API call tracking (model, tokens, cost) |
| `tasks` | Todo list (title, priority, due date, status) |
| `scheduled_messages` | One-time scheduled messages/reminders |
| `tool_usage` | Tool call analytics (name, success, duration) |
| `knowledge_docs` | Ingested documents metadata |
| `knowledge_chunks` | Document chunks for RAG |
| `knowledge_vectors` | sqlite-vec virtual table for knowledge search (768-dim) |
| `batch_jobs` | Anthropic Batch API job tracking |
| `workflows` | Automation definitions (trigger -> actions) |

## npm Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `tsx watch src/index.ts` | Development with auto-reload |
| `build` | `tsc` | Compile TypeScript to `dist/` |
| `start` | `node dist/index.js` | Run compiled production build |

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Claude API client |
| `grammy` | Telegram Bot API framework |
| `@whiskeysockets/baileys` | WhatsApp Web API (unofficial) |
| `better-sqlite3` | SQLite database (sync API) |
| `sqlite-vec` | Vector search extension for SQLite |
| `express` | HTTP server (v5) |
| `node-cron` | Cron job scheduling |
| `nodemailer` | Email sending via Gmail |
| `dotenv` | Environment variable loading |
