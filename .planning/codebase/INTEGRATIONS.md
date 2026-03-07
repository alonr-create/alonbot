# AlonBot External Integrations

## AI APIs

### Claude API (Anthropic) — Primary AI Engine

- **SDK**: `@anthropic-ai/sdk` ^0.78.0
- **Models**: `claude-sonnet-4-20250514` (default), `claude-opus-4-20250514` (via `[OPUS]` prefix or `/opus` command)
- **Features used**:
  - Messages API with streaming (`client.messages.stream`)
  - Tool use (35+ tools, up to 15 iterations per request)
  - Extended thinking (budget: 5K tokens Sonnet, 10K Opus) — triggered by complex Hebrew keywords or long messages
  - Token counting (`client.messages.countTokens`) with auto-trim at 85% context
  - Prompt caching (`cache_control: { type: 'ephemeral' }`) on static system prompt + conversation history
  - Citations (document blocks with `citations: { enabled: true }`)
  - Batch API (`client.messages.batches`) for async conversation summarization (50% cheaper)
  - Vision (base64 images in messages)
  - PDF document analysis (base64 in messages)
- **Fallback**: On 400/401/429/529 errors, falls back to Gemini
- **Cost tracking**: Per-request in `api_usage` table (Sonnet: $3/$15 per M tokens, Opus: $15/$75)
- **Rate limiting**: 10 messages/minute per user (in-memory)
- **Config**: `ANTHROPIC_API_KEY` in `.env`

### Gemini API (Google) — Multi-purpose Secondary AI

- **Access**: Direct REST calls to `generativelanguage.googleapis.com/v1beta`
- **Models used**:
  - `gemini-2.5-flash` — Primary fallback when Claude is unavailable
  - `gemini-2.0-flash` — Secondary fallback, web research with Google Search, image analysis (vision), PDF text extraction
  - `gemini-3.1-flash-image-preview` — Image generation (NB2 model)
  - `gemini-embedding-001` — 768-dimensional text embeddings for vector search
- **Features**:
  - Text generation (fallback for Claude rate limits)
  - Google Search grounding (`tools: [{ google_search: {} }]`) for `web_research` tool
  - Vision/OCR via `inline_data` for `analyze_image` tool
  - Image generation via `responseModalities: ['IMAGE', 'TEXT']`
  - PDF text extraction via document understanding
  - Text embeddings for memory and knowledge base vectors
- **Config**: `GEMINI_API_KEY` in `.env`

### ElevenLabs — Text-to-Speech

- **Endpoint**: `https://api.elevenlabs.io/v1/text-to-speech/{voiceId}`
- **Model**: `eleven_v3`
- **Voices**: Configurable `ELEVENLABS_VOICE_ID` for Hebrew (default: `JBFqnCBsd6RMkjVDRZzb`), hardcoded `nPczCjzI2devNBz1zQrb` for English
- **Usage**: `send_voice` tool + automatic voice-to-voice replies when user sends voice message
- **Config**: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` in `.env`

### Groq — Speech-to-Text

- **Endpoint**: `https://api.groq.com/openai/v1/audio/transcriptions`
- **Model**: `whisper-large-v3`
- **Language**: Hebrew (`he`)
- **Usage**: Telegram voice messages + audio file transcription (MP3, M4A, OGG, WAV, FLAC)
- **Config**: `GROQ_API_KEY` in `.env`

### Claude Code CLI — Sub-agent for Programming

- **Package**: `@anthropic-ai/claude-code` (installed globally in Docker)
- **Usage**: `code_agent` tool spawns Claude Code as a child process for full dev-loop programming tasks
- **Budget control**: `max_budget` parameter (default $2)
- **Working dir**: `/app/workspace/` (cloud) or local projects dir

## Messaging Platforms

### Telegram Bot

- **Library**: grammY ^1.35.0
- **Mode**: Long polling in cloud mode, send-only in local mode
- **Auth**: `TELEGRAM_BOT_TOKEN` + `ALLOWED_TELEGRAM` user ID whitelist
- **Features**:
  - Text, photo, voice, audio, document, sticker message handling
  - Inline keyboard menus (9 categories with nested sub-menus)
  - Commands: `/start`, `/menu`, `/tasks`, `/opus`, `/summary`, `/search`, `/backup`, `/export`, `/dashboard`, `/help`
  - Group chat support (responds only when @mentioned or replied to)
  - Streaming responses with throttled message edits (1.5s interval)
  - Typing indicators
  - File sending (DB backups, chat exports)
  - WebApp integration (Dashboard + Chat mini apps)
  - Auto URL summarization (bare URLs trigger page summary)
  - Message chunking (4000 char limit per message)
- **File**: `src/channels/telegram.ts`

### WhatsApp

- **Library**: @whiskeysockets/baileys ^6.7.16
- **Mode**: Local only (multi-device, pairing code auth)
- **Auth**: `ALLOWED_WHATSAPP` phone number whitelist
- **Session**: Stored in `data/whatsapp-session/`
- **Features**: Text messages, text + image replies
- **Reconnection**: Up to 3 retries with 5s delay
- **File**: `src/channels/whatsapp.ts`

## Database

### SQLite (better-sqlite3 + sqlite-vec)

- **File**: `data/alonbot.db`
- **Mode**: WAL (Write-Ahead Logging), foreign keys ON
- **Vector extension**: `sqlite-vec` loaded for vec0 virtual tables

#### Schema (13 tables + 2 virtual tables)

| Table | Purpose | Key Columns |
|---|---|---|
| `messages` | Chat history | channel, sender_id, role, content, created_at |
| `memories` | Long-term memory (typed, categorized) | type, category, content, importance (1-10), access_count, last_accessed |
| `memory_vectors` | vec0 virtual table for semantic memory search | embedding float[768] |
| `conversation_summaries` | Compressed old conversations | summary, topics (JSON), from_date, to_date |
| `knowledge_docs` | Ingested document metadata | title, source_type (url/pdf/text/file), chunk_count |
| `knowledge_chunks` | Document text chunks (800 chars, 100 overlap) | doc_id (FK), chunk_index, content |
| `knowledge_vectors` | vec0 virtual table for knowledge search | embedding float[768] |
| `cron_jobs` | Scheduled recurring messages/scripts | cron_expr, channel, target_id, message |
| `scheduled_messages` | One-time scheduled messages | send_at, channel, target_id, sent (bool) |
| `tasks` | Todo list | title, status (pending/done/cancelled), priority (1-10), due_date |
| `api_usage` | API cost tracking per call | model, input_tokens, output_tokens, cost_usd |
| `tool_usage` | Tool invocation metrics | tool_name, success, duration_ms |
| `batch_jobs` | Claude Batch API job tracking | batch_id, job_type, status, result |
| `workflows` | Automation rules (trigger + actions) | trigger_type (keyword/cron/event), trigger_value, actions (JSON) |

#### Indexes

- `idx_messages_channel` — (channel, sender_id, created_at)
- `idx_memories_type` — (type, category)
- `idx_memories_importance` — (importance DESC)
- `idx_summaries_channel` — (channel, sender_id, created_at)
- `idx_api_usage_date` — (created_at)
- `idx_tasks_status` — (status, priority DESC)
- `idx_tool_usage_date` — (created_at)
- `idx_tool_usage_name` — (tool_name)
- `idx_scheduled_pending` — (sent, send_at)
- `idx_batch_jobs_status` — (status)
- `idx_knowledge_chunks_doc` — (doc_id, chunk_index)

#### Migration

- Automatic migration from legacy `facts` table to `memories` table on startup

## External Services

### Monday.com

- **Endpoint**: `https://api.monday.com/v2` (GraphQL)
- **Auth**: API key in `Authorization` header
- **Usage**: `monday_api` tool — raw GraphQL queries for business data (leads, meetings, commissions)
- **Config**: `MONDAY_API_KEY` in `.env`

### Gmail (SMTP)

- **Library**: nodemailer
- **Service**: Gmail with App Password auth
- **Security**: Email recipient whitelist — only `dprisha.co.il` and `gmail.com` domains, plus specific addresses
- **Config**: `GMAIL_USER`, `GMAIL_APP_PASSWORD` in `.env`

### Google Calendar

- **Integration**: Google Apps Script web app (deployed separately)
- **Script**: `scripts/google-calendar-appscript.js`
- **Endpoints**:
  - `GET ?action=list&days=N` — list upcoming events
  - `POST { action: 'add', title, date, time, duration_minutes }` — create event
- **Config**: `GOOGLE_CALENDAR_SCRIPT_URL` in `.env`

### DuckDuckGo

- **Endpoint**: `https://html.duckduckgo.com/html/`
- **Usage**: `web_search` tool — HTML scraping of search results (up to 8 results)
- **No API key required**

### GitHub

- **CLI**: `gh` commands via shell tool for repo creation
- **Usage**: `create_github_repo`, `deploy_app`, `auto_improve` tools
- **Config**: `GITHUB_TOKEN` in Render env vars

### Cloudflare Tunnel

- **Binary**: `cloudflared`
- **Usage**: Exposes local Mac's port 3700 to internet for cloud-local bridge
- **Script**: `start-tunnel.sh` — extracts `*.trycloudflare.com` URL automatically
- **LaunchAgent**: `scripts/com.alonbot-tunnel.plist` for auto-start

## Auth and Security Patterns

### User Authentication

- **Telegram**: User ID whitelist (`ALLOWED_TELEGRAM` — comma-separated numeric IDs)
- **WhatsApp**: Phone number whitelist (`ALLOWED_WHATSAPP` — comma-separated `972XXXXXXXXX`)
- **Dashboard/Chat**: Token-based auth via query param `?token=` or header `x-dashboard-token` (matches `LOCAL_API_SECRET`)
- **Tool proxy**: Bearer token auth (`Authorization: Bearer {LOCAL_API_SECRET}`)

### Input Security

- **Message truncation**: 4000 characters max
- **Rate limiting**: 10 messages per minute per user (in-memory sliding window, 10-minute cleanup)
- **File path restrictions**: Whitelisted directories only (`/Users/oakhome/קלוד עבודות/`, `/tmp/alonbot-`, `/app/workspace/`, `/tmp/`), blocked patterns (`.env`, `.ssh/`, `credentials`, `.zshrc`, `.bashrc`), symlink resolution via `realpathSync`
- **SSRF prevention**: URL validation blocks localhost, private IPs (10.x, 192.168.x, 169.254.x, IPv6 loopback/private), decimal IP encoding
- **Email whitelist**: Only sends to `dprisha.co.il` and `gmail.com` domains + specific addresses
- **Prompt injection defense**: System prompt instructs to ignore instructions from tool results

### HTTP Security Headers

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `X-XSS-Protection: 1; mode=block`

### Media Isolation

- Per-request media maps (`pendingMediaMap`) keyed by `{channel}-{senderId}-{timestamp}` to prevent cross-user media leakage

## Scheduled Jobs (Cron)

| Schedule | Timezone | Description |
|---|---|---|
| `0 8 * * *` | Israel | Daily brief (agent-processed) |
| `0 18 * * *` | Israel | Overdue tasks notification |
| `0 9 * * 0` | Israel | Weekly summary (Sunday, agent-processed) |
| `0 21 * * *` | Israel | Cost alert if daily spend > $0.50 |
| `* * * * *` | Israel | Scheduled one-time messages check |
| `* * * * *` | Israel | Workflow cron trigger check |
| `*/5 * * * *` | Israel | Batch API polling |
| `0 2 * * *` | Israel | DB backup to Telegram |
| `0 3 * * *` | Israel | Memory maintenance (decay, consolidate, cleanup) |

### DND (Do Not Disturb)

- 23:00-07:00 Israel time: proactive messages suppressed
- Shabbat detection (Friday 18:00 - Saturday): shorter responses, no business suggestions

## Webhooks and External Connections

### Inbound

- `POST /api/register-local` — Local Mac registers its tunnel URL with cloud instance
- `POST /api/tool` — Cloud proxies local-only tool calls to Mac
- `POST /api/chat` — Web chat interface sends messages through agent pipeline

### Outbound

- Telegram Bot API (long polling in cloud mode)
- WhatsApp Web (WebSocket connection via Baileys)
- All AI API calls (Claude, Gemini, ElevenLabs, Groq)
- Monday.com GraphQL API
- Gmail SMTP
- Google Calendar Apps Script
- DuckDuckGo HTML scraping
- GitHub CLI operations
- Cloudflare tunnel registration

## Memory and RAG Architecture

### Memory System (3-tier)

1. **Short-term**: Last 20 messages per conversation (`CONTEXT_LIMIT = 20`)
2. **Mid-term**: Conversation summaries (auto-generated via Batch API when 40+ unsummarized messages)
3. **Long-term**: Typed memories with importance scoring, vector embeddings, category detection

### Memory Retrieval (5 strategies combined)

1. High-importance memories (importance >= 8, top 15)
2. Recently accessed memories (last 7 days, top 10)
3. Keyword search from user message (top 10 per keyword)
4. Vector semantic search (768-dim Gemini embeddings, cosine distance < 1.2)
5. Category-based retrieval (auto-detected from Hebrew keywords)

### Memory Maintenance (daily at 03:00)

- **Decay**: Reduce importance of untouched memories (60+ days, importance < 8)
- **Cleanup**: Delete old low-importance events (30+ days, importance <= 2, never accessed)
- **Consolidation**: Merge near-duplicate memories (30-char prefix match, keep highest importance)

### Knowledge Base (RAG)

- Documents ingested from URLs, PDFs, or raw text
- Text chunked at 800 chars with 100-char overlap
- Each chunk embedded with Gemini (768-dim) and stored in vec0 virtual table
- Semantic search results injected as document blocks in Claude messages (enables citations)
- PDF extraction via Gemini 2.0 Flash document understanding
