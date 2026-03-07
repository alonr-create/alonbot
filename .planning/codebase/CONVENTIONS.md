# AlonBot — Code Conventions

## Project Overview

AlonBot is an AI personal assistant bot for Telegram (primary) and WhatsApp (secondary). It uses Claude API as its core reasoning engine with Gemini as a fallback, SQLite for persistence, and a modular adapter pattern for multi-channel messaging.

**19 source files** in `src/`, ~2,500 lines of TypeScript.

---

## Code Style

### Language & Module System
- **TypeScript** with strict mode enabled (`"strict": true` in `tsconfig.json`)
- **ESM** throughout — `"type": "module"` in `package.json`
- Target: **ES2022**, Module resolution: **NodeNext**
- Imports use **`.js` extension** even for `.ts` files (TypeScript ESM convention):
  ```typescript
  import { config } from './utils/config.js';
  import type { UnifiedMessage } from '../channels/types.js';
  ```

### Import Style
- Named imports preferred over default imports (exception: `Anthropic`, `Database`)
- `import type` used for type-only imports: `import type Anthropic from '@anthropic-ai/sdk'`
- Third-party imports come first, then local imports — no blank line separator between groups
- No import aliases observed

### Formatting
- **2-space indentation** (inferred from all source files)
- **Single quotes** for strings
- **Semicolons** used consistently
- **No trailing commas** in most places (some inconsistency in object literals)
- No linter or formatter config files present (no `.eslintrc`, `.prettierrc`)
- Lines generally kept under ~120 characters, but no strict enforcement

### Type Declarations
- `src/types.d.ts` — ambient module declarations for untyped packages (`qrcode-terminal`, `node-cron`)
- `src/channels/types.ts` — shared interface definitions for the channel adapter system
- Interfaces defined inline in their module files (e.g., `Memory`, `Workflow`, `CronJob`, `KnowledgeDoc`)
- `as any` casts used frequently for SQLite query results and API responses

---

## Naming Conventions

### Files
- **kebab-case** is not used — files are **camelCase** or single lowercase words
- Examples: `config.ts`, `db.ts`, `embeddings.ts`, `system-prompt.ts` (hyphenated in agent dir)
- One module per file, exports related functions

### Functions
- **camelCase** for all functions: `handleMessage`, `buildSystemPrompt`, `getRelevantMemories`
- Factory functions prefixed with `create`: `createTelegramAdapter`, `createWhatsAppAdapter`
- Boolean checks prefixed with `is`/`has`/`should`: `isAllowed`, `isPathAllowed`, `hasSession`, `shouldSummarize`
- Database query functions: `get*` (single), `all*` (multiple), `save*` (insert), `delete*` (remove)

### Variables
- **camelCase** for locals and parameters
- **UPPER_SNAKE_CASE** for constants: `CONTEXT_LIMIT`, `RATE_LIMIT`, `RATE_WINDOW_MS`, `MAX_TOOL_ITERATIONS`, `ALLOWED_FILE_DIRS`, `LOCAL_ONLY_TOOLS`
- Prepared statements prefixed with `stmt`: `stmtInsertMsg`, `stmtHistory`, `stmtVectorSearch`

### Types & Interfaces
- **PascalCase** for interfaces and type aliases: `UnifiedMessage`, `ChannelAdapter`, `Memory`, `WorkflowAction`
- Union types used for constrained strings: `ChannelType = 'whatsapp' | 'telegram'`
- `type` keyword for simple aliases, `interface` for object shapes

---

## Common Patterns

### Error Handling
1. **try/catch with `.message` logging** — the dominant pattern across all modules:
   ```typescript
   try {
     // operation
   } catch (err: any) {
     console.error('[Module] Description:', err.message);
   }
   ```
2. **Silent catch for non-critical operations** — `try { ... } catch {}` or `try { ... } catch { /* ok */ }`
3. **`.catch()` for fire-and-forget async** — background tasks that should not block:
   ```typescript
   embedMemory(id, content).catch(err =>
     console.error(`[Embed] Failed to embed memory #${id}:`, err.message)
   );
   ```
4. **Error prefixes** in thrown errors: `throw new Error('Embedding API error: ...')`
5. **No custom error classes** — all errors are plain `Error` or caught as `any`

### Async Patterns
- Top-level `await` used in `src/index.ts` (ESM allows this)
- `async/await` preferred everywhere over raw Promises
- `Promise.all` used for parallel tool execution in `agent.ts`
- `AbortSignal.timeout(30000)` used for fetch timeouts
- Background async via `.catch()` attachment (never `void` prefix)
- `setInterval` for periodic cleanup (rate limit map, dashboard auto-refresh)

### Logging
- **`console.log`** with bracketed module prefix: `[Telegram]`, `[Agent]`, `[Cron]`, `[Batch]`, `[Memory]`, `[Embed]`, `[Tool]`, `[Server]`, `[Workflow]`, `[WhatsApp]`, `[Knowledge]`, `[Tokens]`, `[Cache]`
- **`console.error`** for actual errors, always includes `err.message`
- **`console.warn`** for recoverable issues (fallbacks, missing config)
- No structured logging library (no pino despite it being a transitive dependency)
- No log levels or log formatting configuration

### Configuration
- Single `config` object in `src/utils/config.ts` — all env vars centralized
- `dotenv/config` imported as side-effect at top of config module
- Default values provided for all config fields: `process.env.X || 'default'`
- Config is a plain object, not a class — no validation beyond type casting

---

## Database Access Patterns

### Connection Setup (`src/utils/db.ts`)
- **better-sqlite3** (synchronous API) — single `db` instance exported as singleton
- WAL mode enabled: `db.pragma('journal_mode = WAL')`
- Foreign keys enabled: `db.pragma('foreign_keys = ON')`
- **sqlite-vec** extension loaded for vector similarity search
- All schema creation in one `db.exec()` call with `CREATE TABLE IF NOT EXISTS`
- Indexes created alongside tables
- Migration code handles schema evolution (e.g., old `facts` table to `memories`)

### Prepared Statements
- **Module-level prepared statements** — defined once at import time, reused:
  ```typescript
  const stmtInsertMsg = db.prepare(`INSERT INTO messages ...`);
  const stmtHistory = db.prepare(`SELECT ... FROM messages ...`);
  ```
- Named with `stmt` prefix for clarity
- Located in the module that owns the table (e.g., `memory.ts` owns `memories` table statements)

### Query Patterns
- `.get()` for single row, `.all()` for multiple rows, `.run()` for mutations
- Results always cast with `as Type` or `as any`
- `db.transaction()` used for multi-row inserts (migration code)
- Inline SQL queries (via `db.prepare()`) used in `server.ts` and `index.ts` for ad-hoc queries outside the main module boundaries
- `BigInt()` used for rowid values when interfacing with sqlite-vec

### Tables (11 total)
`messages`, `memories`, `memory_vectors` (virtual), `conversation_summaries`, `cron_jobs`, `api_usage`, `tasks`, `scheduled_messages`, `tool_usage`, `knowledge_docs`, `knowledge_chunks`, `knowledge_vectors` (virtual), `batch_jobs`, `workflows`

---

## API Response Patterns

### Express Server (`src/gateway/server.ts`)
- **Express v5** — `express.json({ limit: '1mb' })` body parser
- Security headers set globally via middleware (`X-Content-Type-Options`, `X-Frame-Options`, etc.)
- Auth via query param `?token=` or header `x-dashboard-token` (simple shared secret)
- JSON responses: `res.json({ ... })` for success, `res.status(N).json({ error: '...' })` for errors
- No response envelope pattern — raw data arrays for list endpoints
- Dashboard HTML served as inline template strings (no templating engine)

### External API Calls
- Native `fetch()` used for all HTTP calls (Gemini, Groq, ElevenLabs, DuckDuckGo)
- Response checking: `if (!res.ok) throw new Error(...)`
- Response typing via `as` cast: `await res.json() as { embedding: { values: number[] } }`
- Anthropic SDK used for Claude API (not raw fetch)
- Timeouts: `AbortSignal.timeout(30000)` on fetch calls

### Channel Adapter Pattern
- `ChannelAdapter` interface in `src/channels/types.ts` defines the contract
- Factory functions return adapter objects (not classes): `createTelegramAdapter()`
- Adapters registered via `registerAdapter()` in `src/gateway/router.ts`
- Message routing through `UnifiedMessage` → `handleMessage()` → `UnifiedReply`
- Streaming support via optional `sendStreamStart`/`editStreamMessage` methods

---

## Security Patterns

- **File path restrictions**: whitelist of allowed directories + blocklist of sensitive filenames
- **URL validation**: SSRF prevention blocking private/internal IPs
- **Email whitelist**: only pre-approved addresses/domains
- **Rate limiting**: in-memory sliding window (10 messages/minute/user)
- **Input truncation**: messages capped at 4000 chars
- **Auth**: shared secret token for API endpoints, Telegram user ID whitelist for bot access
- **Symlink protection**: `realpathSync()` to prevent path traversal

---

## Project Structure

```
src/
  index.ts              — Entry point, cron jobs, startup orchestration
  types.d.ts            — Ambient module declarations
  agent/
    agent.ts            — Core message handler, Claude API loop, Gemini fallback
    tools.ts            — Tool definitions + executeTool() switch (~1200 lines)
    memory.ts           — Memory CRUD, vector search, maintenance
    system-prompt.ts    — System prompt builder (static + dynamic parts)
    knowledge.ts        — Knowledge base (ingest, chunk, embed, search)
    workflows.ts        — Workflow engine (keyword/cron/event triggers)
    batch.ts            — Anthropic Batch API wrapper
  channels/
    types.ts            — ChannelAdapter interface, UnifiedMessage/UnifiedReply
    telegram.ts         — Telegram adapter (grammY SDK)
    whatsapp.ts         — WhatsApp adapter (Baileys SDK)
  gateway/
    router.ts           — Adapter registry, message routing, streaming
    server.ts           — Express server, dashboard API, web chat
  cron/
    scheduler.ts        — DB-driven cron job runner
  skills/
    loader.ts           — Markdown skill file loader
  utils/
    config.ts           — Centralized env var config
    db.ts               — SQLite setup, schema, migrations
    embeddings.ts       — Gemini embedding API wrapper
```
