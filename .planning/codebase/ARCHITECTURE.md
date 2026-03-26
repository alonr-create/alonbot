# Architecture

**Analysis Date:** 2026-03-26

## Pattern Overview

**Overall:** Hub-and-spoke message routing with AI agent as central orchestrator

**Key Characteristics:**
- Unified message abstraction across heterogeneous channels (WhatsApp, Telegram, Web)
- Tool-based agent architecture with plugin pattern for extensibility
- Database-driven state for messages, memories, cron jobs, and conversation workflows
- Dual-mode operation: local (Mac-native tools) + cloud (Render, tool proxying)
- Vector-backed memory with semantic search

## Layers

**Channel Adapters:**
- Purpose: Normalize incoming/outgoing messages across WhatsApp (Cloud API + Baileys), Telegram, and web platforms
- Location: `src/channels/`
- Contains: Protocol-specific handlers (Telegram: grammy, WhatsApp: Meta SDK + Baileys), type definitions
- Depends on: Nothing (external libraries only)
- Used by: Router (`src/gateway/router.ts`)

**Message Router (Gateway):**
- Purpose: Route messages from channels to agent, handle deduplication, streaming UI, rate limiting
- Location: `src/gateway/router.ts`
- Contains: Adapter registry, message deduplication map, tool label mapping, rate limit tracking
- Depends on: Channel adapters, agent, logger
- Used by: Server, channels, agent

**AI Agent:**
- Purpose: Handle message processing, call Claude API, execute tools, manage context windows
- Location: `src/agent/agent.ts`
- Contains: Rate limiting (10 msg/min per user), model fallback (Gemini), token budgeting, streaming
- Depends on: Tools, memory, knowledge, system prompt, model router
- Used by: Router (via `handleMessage`)

**Tool System:**
- Purpose: Plugin registry for extensible actions (40+ handlers: web search, file ops, deploy, schedule, memory, etc.)
- Location: `src/tools/`
  - Registry: `src/tools/registry.ts` — auto-discovers handlers, validates Zod schemas, proxies to local Mac
  - Handlers: `src/tools/handlers/` — 40 individual tool implementations
  - Types: `src/tools/types.ts` — `ToolHandler` interface, `ToolContext`
- Contains: Tool definitions (Anthropic schema), validation, execution, local-only tool proxying
- Depends on: Config, database, logger, handlers (dynamic import)
- Used by: Agent (during agentic loop)

**Memory System:**
- Purpose: Persistent context for agent — conversation history, summaries, semantic memories, embeddings
- Location: `src/agent/memory.ts`
- Contains: Message store (per channel/user), vector embeddings (sqlite-vec), conversation summaries, importance ranking
- Depends on: Database, embeddings service, logger
- Used by: Agent (context building), tools (e.g., `remember`)

**Server (Express):**
- Purpose: HTTP/WebSocket endpoints, dashboard/PWA, webhook receivers, API for dashboard actions
- Location: `src/gateway/server.ts`
- Contains: Lead CRM (A/B/C price tiers, lead scoring), dashboard, WA inbox manager, flow engine triggers, analytics
- Depends on: Express, WebSocket, database, logger, tools
- Used by: Index, channels (webhook registration)

**Cron & Workflows:**
- Purpose: Scheduled message delivery, automated follow-ups, chatbot flows (n8n-style visual editor backend)
- Location: `src/cron/scheduler.ts`, `src/gateway/followup-engine.ts`, `src/gateway/flow-engine.ts`
- Contains: node-cron integration, script execution with blocklist, follow-up template management, flow step execution
- Depends on: Database, logger, config
- Used by: Index (scheduler init), server (flow triggers)

**Database Layer:**
- Purpose: Persistent state for messages, memories, cron jobs, tasks, leads, conversation summaries
- Location: `src/utils/db.ts`
- Contains: SQLite with WAL mode, sqlite-vec extension, schema definitions, prepared statements
- Depends on: better-sqlite3, sqlite-vec
- Used by: All layers

## Data Flow

**Incoming Message → Agent Response:**

1. **Channel Input** → Adapter converts platform message to `UnifiedMessage` (text, image, document, sender ID, timestamp)
2. **Router** → Deduplication check (5-min window) → Rate limit check → Workflow keyword match (optional trigger flows)
3. **Agent** → Fetch conversation history (last 35 messages) + summaries → Build smart context (related memories, commits, tasks)
4. **Agent** → Call Claude with system prompt + context + message
5. **Streaming** → Each tool call, intermediate response → Router emits to UI
6. **Tool Execution** → Registry executes handler (e.g., `web_search`, `shell`, `send_email`)
7. **Memory Save** → Agent saves assistant response + any learned facts to memories table + embeddings
8. **Channel Output** → Reply sent via adapter (text, image, voice, buttons/interactive)

**State Management:**

- **Per-user state:** Conversation history in DB (all roles/content persisted via `saveMessage()`)
- **Agent state:** Rate limit map (in-memory), model catalog (built at startup)
- **System state:** Tool registry (loaded at startup), cron jobs (active task map), adapters (router map)
- **Cross-request state:** Media queue (per `requestId`), pending interactive messages

## Key Abstractions

**UnifiedMessage / UnifiedReply:**
- Purpose: Channel-agnostic message envelope (handles text, image, document, voice, buttons)
- Examples: `src/channels/types.ts` defines interface
- Pattern: Adapter implements `ChannelAdapter`, converts to/from platform-specific format

**ToolHandler:**
- Purpose: Plugin interface for tools
- Examples: 40 handlers in `src/tools/handlers/` (e.g., `web-search.ts`, `send-voice.ts`, `claude-code.ts`)
- Pattern: Default export implements `{ name, definition (Anthropic.Tool), schema (Zod), execute, localOnly? }`

**Memory (Vector + Summaries):**
- Purpose: Semantic + factual context retrieval
- Examples: `src/agent/memory.ts` — `getHistory()`, `getSmartContext()`, `indexDocumentToMemory()`
- Pattern: Embeddings via `sqlite-vec`, importance ranking, temporal decay

**Workspace Mapping:**
- Purpose: Group leads/sources by business unit (Dekel retirement coaching vs. Alon.dev)
- Examples: `src/gateway/followup-engine.ts:workspaceSources()`, `src/gateway/server.ts:getTierPrices()`
- Pattern: `source` (string) → `workspace` (string) for routing follow-ups, lead campaigns

## Entry Points

**Main Server (index.ts):**
- Location: `src/index.ts`
- Triggers: App startup (npm start / tsx watch)
- Responsibilities: Initialize DB + migrations, load tools, register adapters (Telegram + WhatsApp), start Express, schedule cron jobs, start smart daily brief

**Telegram Webhook / Polling:**
- Location: `src/channels/telegram.ts` + `src/gateway/server.ts:/telegram-webhook`
- Triggers: Cloud mode = incoming webhook (Meta Cloud API retry-safe), Local mode = polling
- Responsibilities: Parse message, call router, send reply

**WhatsApp Cloud Webhook:**
- Location: `src/channels/whatsapp-cloud.ts` + `src/gateway/server.ts:/whatsapp-cloud-webhook`
- Triggers: Incoming message event from Meta
- Responsibilities: Verify signature, extract message/button/list response, call router

**Dashboard API Endpoints:**
- Location: `src/gateway/server.ts` (70+ endpoints)
- Triggers: Browser/PWA requests
- Responsibilities: Lead management, conversation view, cron job editor, flow builder, analytics

**Cron Job Execution:**
- Location: `src/cron/scheduler.ts` + node-cron schedule
- Triggers: Time-based (cron expression, timezone: Asia/Jerusalem)
- Responsibilities: Fire scheduled message or execute script (with shell blocklist validation)

## Error Handling

**Strategy:** Graceful degradation with fallback models and detailed logging

**Patterns:**
- **Rate Limit:** Return user-facing message "יותר מדי הודעות" (agent.ts:71)
- **Claude 429 (rate limit):** Retry with `withRetry()` wrapper, fallback to free models (Gemini, etc.)
- **Tool Execution:** Catch + return error string to Claude (auto-recovery in next turn)
- **Webhook Signature:** Validate, return 401 if invalid (server.ts)
- **Local Tool Unavailable:** Return "Error: Mac is offline" (registry.ts:72)
- **DB Access:** Best-effort updates (e.g., lead tier assignment, error swallowed if DB fails)
- **Script Execution:** Shell command checked against blocklist (shell-blocklist.ts), blocked with explanation

## Cross-Cutting Concerns

**Logging:** Pino logger (per module, `createLogger('module-name')`) — outputs to stdout, no file rotation

**Validation:** Zod schemas optional on tool inputs; Claude API schemas enforce shape

**Authentication:**
- **Dashboard/PWA:** `x-api-secret` header (env var `ALONBOT_SECRET`)
- **Webhook:** Signature verification (Telegram: bot token implicit, WhatsApp: Meta X-Hub-Signature)
- **Local tool proxy:** Bearer token in Authorization header (env var `LOCAL_API_SECRET`)

**Security:**
- **Shell execution:** Whitelist-based blocklist (src/utils/shell-blocklist.ts), blocks rm/mv/curl/code-injections
- **Path access:** Restricted to config.dataDir, no ../../../ traversal allowed (sanitize.ts)
- **Email:** Whitelist of allowed recipients (src/tools/handlers/send-email.ts)
- **Secrets:** .env never exposed, API keys only passed via headers or config

**Timezone:** All cron jobs + DND logic use Asia/Jerusalem (Israel time)

**Mode (Local vs. Cloud):**
- **Local:** WhatsApp Baileys (QR scan), tool execution on Mac (native), tunnel to Render for polling
- **Cloud:** WhatsApp Cloud API + Telegram webhook, tool proxying to local Mac, polling-safe deduplication

---

*Architecture analysis: 2026-03-26*
