# AlonBot v25 — Hardening & New Features

## What This Is

AlonBot is a Hebrew-first AI personal assistant Telegram bot for Alon. It processes messages through Claude API with 35+ tools (shell, web search, email, calendar, GitHub, Monday.com, image generation, voice, code_agent, and more), supports WhatsApp via Baileys, runs DB-driven cron jobs, and maintains a 3-layer memory system with RAG. Deployed on Render (Docker), with a local Mac bridge for native tools.

## Core Value

Alon can ask for anything — from quick info lookups to building and deploying full websites — and the bot handles it end-to-end through a single Telegram chat, reliably and without breaking.

## Requirements

### Validated

- Tool execution with 35+ tools (shell, web, email, calendar, GitHub, Monday, images, voice, code_agent)
- Multi-channel support (Telegram polling + WhatsApp via Baileys)
- Streaming responses with real-time tool indicators
- 3-layer memory (short-term messages, long-term memories with RAG, conversation summaries)
- DB-driven cron scheduler with script execution
- Cloud/local dual-mode deployment
- Knowledge base with URL ingestion and vector search
- Claude Code CLI integration (code_agent) for real programming tasks
- Keyword-triggered workflow engine
- Dashboard and web chat (inline HTML)

### Active

- [ ] Refactor tools.ts (1,212-line god file) into modular tool registry
- [ ] Sandbox shell execution (prevent command injection via prompt attacks)
- [ ] Replace execSync with async spawn (unblock event loop)
- [ ] Add structured logging (pino is installed but unused)
- [ ] Fix silent error swallowing (25+ empty catch blocks)
- [ ] Extract inline HTML from server.ts to static files
- [ ] Add retry logic for external API calls
- [ ] Add basic test coverage (Vitest, start with pure functions)
- [ ] Fix dashboard auth (token in query params leaks via logs/referrer)
- [ ] Secure GITHUB_TOKEN handling (remove from git URLs/shell output)
- [ ] Add WhatsApp media support (currently drops non-text)
- [ ] Add plugin system for easy tool addition
- [ ] Improve health check (currently just returns "ok", no deep checks)
- [ ] Add DB migration system (schema changes are manual)

### Out of Scope

- Multi-user support — this is a single-user personal assistant
- Web UI redesign — dashboard works, not priority
- WhatsApp full feature parity with Telegram — Telegram is primary
- Mobile app — Telegram IS the app

## Context

- Codebase: ~4,825 lines TypeScript across 19 source files
- Stack: TypeScript ESM, Node.js 22, Express v5, better-sqlite3, sqlite-vec, grammY
- Deployed: Docker on Render (free tier), auto-deploy from GitHub
- 13+ external API integrations (Claude, Telegram, Gemini, ElevenLabs, Groq, Monday, Gmail, Google Calendar, GitHub, DuckDuckGo)
- No tests exist — zero test files, no CI pipeline
- pino is in dependencies but console.log/error used everywhere
- Codebase map available at `.planning/codebase/` (7 documents, 1,406 lines)

## Constraints

- **Runtime**: Node.js 22 + TypeScript ESM — must maintain `.js` import convention
- **Database**: SQLite (better-sqlite3 sync API) — no async DB driver change
- **Deployment**: Render free tier Docker — limited resources, no persistent disk beyond data/
- **Single process**: No workers or queue system — everything runs in one process
- **Backward compatible**: Bot must stay operational throughout refactoring — no breaking changes to Telegram interface

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tool registry pattern for tools.ts | God file is unmaintainable at 1,212 lines | -- Pending |
| Vitest for testing | ESM-native, fast, minimal config | -- Pending |
| pino for structured logging | Already installed, just needs wiring | -- Pending |
| Async spawn over execSync | Unblocks event loop, enables timeouts | -- Pending |
| Keep SQLite (no Postgres) | Simple, no external DB needed, fits single-user | -- Pending |

---
*Last updated: 2026-03-07 after initialization*
