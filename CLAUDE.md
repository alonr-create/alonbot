# AlonBot — Claude Code Instructions

## Project Overview
AI personal assistant bot for Telegram. TypeScript + Node.js + SQLite + Claude API.

## Key Commands
- `npm run dev` — development with auto-reload (tsx watch)
- `npm run build` — compile TypeScript
- `npm start` — run compiled JS

## Architecture
- `src/agent/` — AI agent (Claude API, tools, memory, system prompt)
- `src/channels/` — Telegram + WhatsApp adapters
- `src/gateway/` — Express server + message routing
- `src/cron/` — DB-driven cron scheduler
- `src/utils/` — Config, database, embeddings

## Important Conventions
- All source files are TypeScript ESM (`.ts`, `"type": "module"`)
- Imports use `.js` extension (TypeScript ESM convention)
- SQLite via better-sqlite3 (sync API) + sqlite-vec for vectors
- Security: shell whitelist, path restrictions, SSRF prevention, email whitelist
- Hebrew-first bot — system prompt and responses in Hebrew
- Never expose .env values, API keys, or credentials
- Cloud mode = Telegram polling + cron. Local mode = cron only (send-only Telegram)

## Database
SQLite at `data/alonbot.db`. Tables: messages, memories, memory_vectors, conversation_summaries, cron_jobs, api_usage, tasks.

## Adding Tools
1. Create a new file in `src/tools/handlers/` implementing the `ToolHandler` interface
2. Export default a `ToolHandler` (or array for grouped tools)
3. Include the `definition` (Claude API schema), optional `schema` (Zod), and `execute` function
4. Set `localOnly: true` if the tool needs the local Mac
5. No other files need editing — the registry auto-discovers handlers at startup
6. Document in system prompt (`src/agent/system-prompt.ts`)
