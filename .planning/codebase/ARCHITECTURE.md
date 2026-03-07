# AlonBot Architecture

## Overall Pattern

AlonBot follows a **multi-channel AI agent** architecture with a **gateway/adapter pattern** for message routing. The system operates as a long-running Node.js process that:

1. Receives messages from multiple chat platforms (Telegram, WhatsApp, Web)
2. Routes them through a unified message interface
3. Processes them via an agentic AI loop (Claude API with tool use)
4. Returns responses back through the originating channel

The architecture also includes a **proactive layer** with cron-scheduled tasks, automated workflows, and background batch processing.

## Deployment Modes

AlonBot supports two runtime modes via `config.mode`:

- **Cloud mode** (`MODE=cloud`): Full Telegram polling, cron jobs, Express server. Deployed on Render. Local-only tools are proxied to the Mac via a registered tunnel URL.
- **Local mode** (`MODE=local`): Telegram send-only (no polling, avoids token conflict), WhatsApp via Baileys, exposes `/api/tool` for cloud proxy calls. Mac-native tools (shell, screenshot, file access) run directly.

## Layers and Responsibilities

### 1. Entry Point (`src/index.ts`)

Orchestration layer. Responsible for:
- Starting the Express server
- Creating and registering channel adapters (Telegram, WhatsApp)
- Registering all cron jobs (daily brief, overdue tasks, weekly summary, cost alerts, scheduled messages, workflow engine, batch polling, memory maintenance, DB backup)
- Graceful shutdown handling

### 2. Gateway Layer (`src/gateway/`)

**`server.ts`** -- Express HTTP server providing:
- `/health` -- health check endpoint
- `/api/register-local` -- cloud mode: local Mac registers its tunnel URL
- `/api/tool` -- local mode: exposes tool execution API for cloud proxy
- `/api/dashboard/*` -- dashboard data endpoints (stats, memories, tasks, messages, costs, knowledge, workflows, tools)
- `/api/chat` and `/api/chat/history` -- web chat interface
- `/dashboard` and `/chat` -- server-rendered HTML dashboard and chat UIs

**`router.ts`** -- Message routing hub:
- Maintains a registry of channel adapters (`Map<string, ChannelAdapter>`)
- `registerAdapter()` -- registers an adapter and wires its `onMessage` callback to the agent
- Handles streaming response edits (throttled to 1.5s for Telegram rate limits)
- Manages typing indicators
- Fires keyword-triggered workflows on incoming messages
- `sendToChannel()` -- sends a raw message through an adapter (for cron)
- `sendAgentMessage()` -- sends a message through the full agent pipeline (for daily brief, etc.)

### 3. Channel Layer (`src/channels/`)

Adapters that normalize platform-specific APIs into `UnifiedMessage`/`UnifiedReply`.

**`types.ts`** -- Core interfaces:
- `UnifiedMessage` -- channel-agnostic inbound message (text, image, document, voice, sender info)
- `UnifiedReply` -- channel-agnostic outbound reply (text, optional image/voice buffers)
- `ChannelAdapter` -- interface every adapter implements: `start()`, `stop()`, `sendReply()`, `onMessage()`, optional `sendTyping()`, `sendStreamStart()`, `editStreamMessage()`

**`telegram.ts`** -- grammY-based Telegram adapter:
- Handles text, photos, documents (PDF + text files), voice messages, audio files, stickers, inline button callbacks
- Voice/audio STT via Groq Whisper API
- Commands: `/menu`, `/start`, `/tasks`, `/help`, `/summary`, `/search`, `/backup`, `/export`, `/opus`, `/dashboard`
- Inline keyboard menu system with categories
- Auto-detects bare URLs and wraps as "summarize this page"
- Streaming support via message editing
- Group chat support (responds only when @mentioned or replied to)

**`whatsapp.ts`** -- Baileys-based WhatsApp adapter:
- Pairing code authentication (no QR scan needed)
- Auto-reconnect with retry limit
- Security: only processes messages from whitelisted numbers

### 4. Agent Layer (`src/agent/`)

The AI processing core.

**`agent.ts`** -- Main message handler:
- Rate limiting (10 messages/minute/user)
- Builds conversation history from DB
- Injects vision content (images, PDFs) into message blocks
- Detects `[OPUS]` tag for on-demand model upgrade (Sonnet -> Opus)
- Detects complex queries for extended thinking mode
- Searches knowledge base and injects results as document blocks (with citation support)
- Multi-turn caching via `cache_control` on conversation breakpoints
- Token counting with auto-trim when approaching context limit (85%)
- **Agentic tool loop**: up to 15 iterations of tool_use -> tool_result -> continue
- Parallel tool execution within each iteration
- Streaming support via `client.messages.stream()`
- Gemini fallback on Claude rate limits (429), overload (529), or auth errors (400/401). Tries Gemini 2.5 Flash, then 2.0 Flash.
- API cost tracking per request
- Auto-summarization trigger when unsummarized messages exceed threshold (40)
- Voice-to-voice: auto-generates TTS reply via ElevenLabs when user sends voice message
- Appends model/cost footer to display text (not saved to history)

**`tools.ts`** -- Tool definitions and execution:
- 35+ tools organized by category: shell/files, web/search, content generation, memory/scheduling, business (Monday.com, email), tasks, projects/deployment, knowledge base, workflows, calendar
- Security layers: file path whitelist, SSRF URL validation, email domain whitelist
- Local-only tools (`screenshot`, `manage_project`, `send_file`) are proxied to Mac in cloud mode via HTTP
- Media side-channel: per-request `Map` prevents cross-user image/voice leakage
- `code_agent` tool: spawns Claude Code CLI as a subprocess for full development workflows
- `auto_improve` tool: reads/edits AlonBot's own source code with auto-commit
- `executeWorkflowActions()` for workflow engine

**`system-prompt.ts`** -- Dynamic system prompt builder:
- Static part (cached via `cache_control`): bot identity, business context, tool documentation, behavior rules, security instructions
- Dynamic part (per-request): current datetime, quiet hours/Shabbat detection, relevant memories, conversation summaries, loaded skills
- Returns `TextBlockParam[]` for optimal prompt caching

**`memory.ts`** -- Memory system:
- **Messages**: save/retrieve conversation history with configurable context limit (20 messages)
- **Memories**: typed (fact/preference/event/pattern/relationship), categorized, with importance scores (1-10)
- **Retrieval**: multi-strategy -- high-importance, recently-accessed, keyword search, vector semantic search (cosine distance < 1.2), category detection, general fallback
- **Embeddings**: async embedding via Gemini, stored in sqlite-vec virtual table
- **Conversation summaries**: stored after 40+ unsummarized messages, via Batch API (50% cheaper)
- **Maintenance**: daily decay (reduce importance of untouched memories after 60 days), delete stale low-importance events, consolidate near-duplicates

**`knowledge.ts`** -- RAG knowledge base:
- Ingest URLs (HTML stripping) and PDFs (text extraction via Gemini)
- Text chunking with overlap (800 chars, 100 char overlap)
- Vector embeddings via Gemini embedding model
- Semantic search with distance threshold filtering (< 1.3)
- CRUD management of documents and chunks

**`workflows.ts`** -- Automation engine:
- Triggers: keyword (substring match in message), cron (time-based), event
- Actions: send_message, add_task, send_email, remember, set_reminder
- Keyword workflows fire asynchronously on incoming messages (don't block response)
- Cron workflows checked every minute from `src/index.ts`

**`batch.ts`** -- Anthropic Batch API integration:
- Submits async batch jobs (50% cost savings)
- Polls pending batches every 5 minutes
- Currently used for conversation summarization
- Processes results by job type with extensible handler pattern

### 5. Cron Layer (`src/cron/scheduler.ts`)

DB-driven cron job system:
- Jobs stored in `cron_jobs` table
- Supports both message-type and script-type jobs (JSON payload with `type: 'script'`)
- Live registration: new cron jobs start immediately without restart
- All jobs use Israel timezone (`Asia/Jerusalem`)

### 6. Skills Layer (`src/skills/loader.ts`)

Markdown-based skill definitions:
- Reads `.md` files from `skills/` directory
- Extracts name (from `# heading`) and description (from `> blockquote` or first paragraph)
- Injected into system prompt as available capabilities

### 7. Utils Layer (`src/utils/`)

**`config.ts`** -- Environment variable loading via dotenv. Single config object with all API keys, allowed users, mode, paths.

**`db.ts`** -- SQLite database initialization:
- Uses better-sqlite3 (synchronous API) with WAL mode
- Loads sqlite-vec extension for vector search
- Creates all tables on startup (messages, memories, memory_vectors, conversation_summaries, cron_jobs, api_usage, tasks, scheduled_messages, tool_usage, knowledge_docs, knowledge_chunks, knowledge_vectors, batch_jobs, workflows)
- Handles migration from legacy `facts` table to `memories`

**`embeddings.ts`** -- Gemini embedding API wrapper:
- Model: `gemini-embedding-001`
- Dimension: 768
- Returns `Float32Array` for sqlite-vec storage

## Data Flow: Message In -> Response Out

```
User sends message (Telegram/WhatsApp/Web)
       |
       v
Channel Adapter normalizes to UnifiedMessage
       |
       v
Router.registerAdapter callback fires
  |-- Keyword workflows triggered (async, non-blocking)
  |-- Streaming setup (if adapter supports it)
  |-- Typing indicator started
       |
       v
agent.handleMessage(msg, onStream?)
  |-- Rate limit check
  |-- Save user message to DB
  |-- Load conversation history from DB
  |-- Attach image/PDF/document if present
  |-- Detect [OPUS] tag -> upgrade model
  |-- Build system prompt (static cached + dynamic)
  |     |-- Load relevant memories (multi-strategy retrieval)
  |     |-- Load recent summaries
  |     |-- Load skills
  |-- Search knowledge base -> inject as document blocks
  |-- Count tokens, auto-trim if near limit
  |-- Call Claude API (streaming or sync)
  |     |
  |     v
  |   Claude responds with text and/or tool_use blocks
  |     |
  |     v  (loop up to 15 iterations)
  |   Execute tools in parallel
  |   Log tool usage to DB
  |   Feed tool_results back to Claude
  |   Claude responds again
  |     |
  |     v (stop_reason != 'tool_use')
  |   Extract final text response
  |-- On Claude error (429/529): fallback to Gemini
  |-- Track API usage costs in DB
  |-- Save assistant response to DB
  |-- Append model/cost footer (display only)
  |-- Trigger auto-summarize if threshold reached (batch)
  |-- Collect media (images/voice) from tool calls
  |-- Auto-TTS if user sent voice message
       |
       v
Router sends reply via adapter
  |-- If streaming: final edit of stream message
  |-- Send media (image/voice) separately
  |-- Chunk long text (4000 char limit per message)
       |
       v
User receives response
```

## Key Abstractions

### Interfaces

- `UnifiedMessage` -- normalized inbound message across all channels
- `UnifiedReply` -- normalized outbound reply (text + optional image/voice)
- `ChannelAdapter` -- contract for chat platform adapters
- `Memory` -- typed memory record with importance, category, access tracking
- `Workflow` / `WorkflowAction` -- automation trigger-action pairs
- `Skill` -- markdown-based capability description
- `StreamCallback` -- `(text: string, toolName?: string) => void` for streaming UI updates

### Security Model

- **User whitelist**: `ALLOWED_TELEGRAM` and `ALLOWED_WHATSAPP` env vars restrict who can interact
- **File path whitelist**: only `/Users/oakhome/...`, `/tmp/alonbot-*`, `/app/workspace/`
- **Blocked file patterns**: `.env`, `.ssh/`, `credentials`, shell configs
- **SSRF prevention**: URL validation blocks localhost, private IPs, non-HTTP protocols
- **Email whitelist**: only approved domains and addresses
- **Prompt injection defense**: system prompt instructs to ignore instructions from tool outputs
- **Local-only tools**: `screenshot`, `manage_project`, `send_file` only run on local Mac
- **Rate limiting**: 10 messages/minute/user
- **Message truncation**: 4000 char max input

## Entry Points

1. **Main process** (`src/index.ts`): starts Express server, Telegram polling (cloud), WhatsApp (local), all cron jobs
2. **Express server** (`src/gateway/server.ts`): HTTP endpoints for health, dashboard, web chat, tool proxy
3. **Cron jobs** (in `src/index.ts`): daily brief (08:00), overdue tasks (18:00), weekly summary (Sun 09:00), cost alert (21:00), scheduled messages (every minute), workflow engine (every minute), batch polling (every 5 min), memory maintenance (03:00), DB backup (02:00)
4. **DB-driven cron** (`src/cron/scheduler.ts`): user-created reminders and scripts loaded from `cron_jobs` table
