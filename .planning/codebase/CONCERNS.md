# AlonBot Codebase Concerns

Analysis date: 2026-03-07
Codebase: ~4,825 lines TypeScript across 19 source files

---

## 1. CRITICAL: Security Concerns

### 1.1 Shell Command Injection (CRITICAL)
- **File**: `src/agent/tools.ts` line 280
- The `shell` tool passes user-controlled input directly to `execSync()` with no sanitization or command whitelist. The AI model decides what to run, but a prompt injection attack (e.g., via web page content fed through `browse_url` or `scrape_site`) could trick the model into running arbitrary commands.
- The `cron_script` tool (line 892-903) stores arbitrary shell commands in the database and executes them on schedule via `execSync()` in `src/cron/scheduler.ts` line 50.
- **Impact**: Full system compromise on the host machine.
- **Mitigation**: Add a command allowlist or sandboxing layer; at minimum, block destructive commands (`rm -rf`, `curl | sh`, etc.).

### 1.2 SQL Injection via Dynamic Query Construction (HIGH)
- **File**: `src/agent/tools.ts` line 592-596
- The `api_costs` tool uses string interpolation to build SQL WHERE clauses: `` `WHERE ${where}` ``. While the `where` value currently comes from a fixed `periods` map, the pattern is fragile -- if the map is extended or refactored, injection becomes possible.
- **File**: `src/channels/telegram.ts` line 254
- The `/search` command uses `LIKE ?` with `%${query}%` -- properly parameterized, but the search term is user-controlled and not length-limited, allowing pattern-based DoS on the DB.
- **File**: `src/channels/telegram.ts` line 284
- The `/backup` command uses `db.exec(\`VACUUM INTO '${backupPath}'\`)` with string interpolation. While `backupPath` is server-generated, the pattern is risky.

### 1.3 Dashboard Token Exposure (HIGH)
- **File**: `src/gateway/server.ts` lines 213, 304, 314, 441
- The `localApiSecret` is passed as a URL query parameter (`?token=...`) in multiple places including the dashboard URL, chat URL, and Telegram WebApp buttons. Query parameters are logged in server access logs, browser history, and can leak via Referrer headers.
- The same token (`alonbot-secret-2026`) is used for both the cloud-local API bridge and the dashboard auth -- compromise of one compromises both.
- **File**: `src/gateway/server.ts` line 70-77
- The `dashAuth` middleware accepts the token from either `?token=` query param or `x-dashboard-token` header, but there's no rate limiting on auth failures.

### 1.4 GITHUB_TOKEN in Shell Commands (HIGH)
- **File**: `src/agent/tools.ts` lines 818-819, 857-858, 877-878, 940, 975, 990
- `GITHUB_TOKEN` is embedded directly in git remote URLs via string interpolation: `https://${token}@github.com/...`. These URLs appear in shell output, git config, and error messages. If any tool output is shown to the user (and it is, via Telegram), the token could leak.

### 1.5 Auto-Improve Tool: Self-Modifying Code (HIGH)
- **File**: `src/agent/tools.ts` lines 906-956
- The `auto_improve` tool allows the AI to read and modify its own source code, then auto-commits and pushes to GitHub. Combined with prompt injection risks, an attacker could modify the bot's behavior permanently through a crafted web page.

### 1.6 No Input Validation on Tool Parameters (MEDIUM)
- Most tool handlers trust input directly from the AI model without validation. For example:
  - `monday_api` passes raw GraphQL queries (line 501-514)
  - `send_email` sends HTML body without sanitization (line 557-558)
  - `schedule_message` accepts arbitrary `send_at` strings (line 662)
  - `code_agent` spawns processes with `--permission-mode bypassPermissions` (line 1075)

### 1.7 SSRF Prevention Gaps (MEDIUM)
- **File**: `src/agent/tools.ts` lines 52-68
- The `isUrlAllowed()` function blocks common private IP ranges but misses:
  - DNS rebinding attacks (host resolves to public IP initially, then to private)
  - Cloud metadata endpoints (e.g., `http://169.254.169.254/` is blocked, but `http://metadata.google.internal/` is not)
  - Octal/hex IP encoding (only decimal is checked)
  - URL with credentials: `http://user:pass@internal-host/`

---

## 2. Technical Debt

### 2.1 God File: `src/agent/tools.ts` (1,212 lines)
- This file contains all 35+ tool definitions AND all tool implementations in a single `switch` statement. Each tool case is 15-60 lines of business logic.
- **Impact**: Hard to maintain, test, or review. Adding a tool requires modifying this massive file.
- **Recommendation**: Extract each tool into its own module under `src/tools/` with a common interface, and use a registry pattern.

### 2.2 Inline HTML in `src/gateway/server.ts` (521 lines)
- The dashboard HTML (~180 lines) and chat HTML (~110 lines) are embedded as template literals inside the server file (lines 224-521).
- **Impact**: Impossible to iterate on UI without touching backend code. No syntax highlighting, no formatting tools.
- **Recommendation**: Move to separate `.html` files served statically or via a simple template engine.

### 2.3 Duplicated HTML Stripping Logic
- HTML-to-text stripping is copy-pasted in 4 places with slight variations:
  - `src/agent/tools.ts` line 380-386 (`browse_url`)
  - `src/agent/tools.ts` lines 1025-1031 (`scrape_site`)
  - `src/agent/knowledge.ts` lines 97-103 (`ingestUrl`)
  - No shared utility function exists.
- **Recommendation**: Extract to `src/utils/html.ts`.

### 2.4 Duplicated Deploy Logic
- **File**: `src/agent/tools.ts` lines 841-889
- The Vercel and Railway deploy branches are nearly identical (check repo, create if missing, push). ~25 lines duplicated.

### 2.5 Silent Error Swallowing
- 25+ `catch {}` blocks (empty catch with no logging) across the codebase:
  - `src/agent/agent.ts` line 125, 183, 267, 353
  - `src/agent/tools.ts` line 45, 65, 257, 575, 634, 1044, 1046, 1121, 1140, 1163
  - `src/gateway/router.ts` line 57, 127
  - `src/index.ts` line 242
- **Impact**: Failures are invisible. Debugging production issues is very difficult.

### 2.6 No Test Suite
- Zero test files exist. No testing framework is configured.
- Critical logic (path validation, URL validation, email whitelist, rate limiting, cron matching) has no automated tests.

---

## 3. Performance Concerns

### 3.1 Synchronous `execSync` Blocking the Event Loop (HIGH)
- **File**: `src/agent/tools.ts` lines 280, 573, 654, 819, 858, 878, 911, 940, 967, 990
- All `shell`, `manage_project`, `screenshot`, `create_github_repo`, `deploy_app`, `build_website`, and `auto_improve` tools use synchronous `execSync()`. While the bot is running a shell command (up to 30s timeout), the entire Node.js event loop is blocked -- no other messages can be processed, no cron jobs fire, no health checks respond.
- The `code_agent` tool correctly uses `spawn()` (async), but all others block.
- **Impact**: A slow git push or shell command freezes the entire bot for all users.
- **Recommendation**: Replace with `child_process.exec()` (callback) or `util.promisify(exec)`.

### 3.2 Embedding Every Memory on Save (MEDIUM)
- **File**: `src/agent/memory.ts` lines 142-148
- `saveMemory()` fires off an async embedding request (Gemini API call) for every memory saved. If the bot saves many memories in a burst, this creates a flood of API calls with no throttling.
- The `embedUnembeddedMemories()` startup function (line 156-163) processes all unembedded memories sequentially with no concurrency limit -- could be slow on large backlogs.

### 3.3 Memory Retrieval Does 5+ DB Queries Per Message (MEDIUM)
- **File**: `src/agent/memory.ts` lines 183-241
- `getRelevantMemories()` runs: high-importance query, recently-accessed query, N keyword queries (one per word, up to 5), vector search, category search, and general fallback. Each message triggers 7-10+ synchronous SQLite queries plus one async embedding API call.
- Additionally, it updates `last_accessed` for every retrieved memory (line 236-238), causing write I/O on every read.

### 3.4 No Connection Pooling for External APIs
- Every `send_email` call creates a new SMTP transport (`createTransport()`), sends, then closes it (line 553-564). For repeated sends, this is wasteful.
- Every Gemini, ElevenLabs, and Groq API call creates a new `fetch()` connection with no keep-alive pooling.

### 3.5 pendingMediaMap Memory Leak Risk (LOW)
- **File**: `src/agent/tools.ts` lines 14-29
- If a request generates media but `collectMedia()` is never called (e.g., an exception occurs between media generation and collection), the buffer stays in the Map forever. Large images (~1-5MB each) could accumulate.
- **Recommendation**: Add a TTL-based cleanup or use WeakRef.

### 3.6 Rate Limit Map Never Shrinks Below Entry Count (LOW)
- **File**: `src/agent/agent.ts` lines 48-69
- The cleanup interval (every 10 minutes) removes empty entries but the Map itself can grow unboundedly if many unique user IDs appear. For a personal bot this is negligible, but worth noting.

---

## 4. Fragile Areas

### 4.1 Cron Matcher Is a Custom Implementation (HIGH)
- **File**: `src/index.ts` lines 186-213
- `matchesCronNow()` is a hand-written cron parser that handles `*`, `/`, `,`, and `-` syntax. It parses the Israel timezone by round-tripping through `toLocaleString()` → `new Date()` which is fragile across environments and DST transitions.
- The `node-cron` library is already in use for the static schedules -- the custom matcher is only for workflow cron triggers. This dual approach creates inconsistency risk.
- **Recommendation**: Use `node-cron.validate()` + `node-cron.schedule()` uniformly, or use a cron-matching library.

### 4.2 Tight Coupling Between Tools and Global State
- `pendingMediaMap` and `currentRequestId` in `src/agent/tools.ts` are module-level mutable state shared across requests. The request ID is set via `setCurrentRequestId()` before processing and must be collected via `collectMedia()` after -- this is a fragile implicit contract.
- If two requests overlap (concurrent users), the `currentRequestId` could be overwritten before media is collected, causing media to be delivered to the wrong user.

### 4.3 WhatsApp Adapter: Text-Only (MEDIUM)
- **File**: `src/channels/whatsapp.ts` lines 82-84
- Only `conversation` and `extendedTextMessage` are handled. Images, voice, documents, and other media types are silently dropped.

### 4.4 Telegram /backup SQL Injection Vector
- **File**: `src/channels/telegram.ts` line 284
- `db.exec(\`VACUUM INTO '${backupPath}'\`)` -- while `backupPath` is generated from `Date.now()`, the pattern of using string interpolation in SQL is dangerous if ever refactored.

### 4.5 System Prompt Size Growth
- **File**: `src/agent/system-prompt.ts`
- The static system prompt is ~176 lines of text. On every message, it concatenates: static prompt + memories (up to 25) + summaries (up to 5) + skills + time context. This grows the input token count continuously, increasing costs.

---

## 5. Missing Features

### 5.1 No Error Recovery / Retry Logic
- External API calls (Gemini, ElevenLabs, Groq, Monday.com, Google Calendar) have no retry logic. A transient 500 or network timeout results in immediate failure.
- The Gemini fallback in `agent.ts` catches Claude 429/529 errors, but other tools fail silently.

### 5.2 No Structured Logging
- All logging uses `console.log()` / `console.error()` / `console.warn()` with ad-hoc prefixes like `[Telegram]`, `[Tool]`, `[Cron]`. There is no structured logging, no log levels, no log rotation, no correlation IDs.
- Pino is installed as a dependency but not used.

### 5.3 No Graceful Shutdown for All Components
- **File**: `src/index.ts` lines 239-244
- `SIGINT` handler stops Telegram and closes DB, but does not:
  - Stop cron jobs (they continue firing)
  - Wait for in-flight message processing to complete
  - Stop the Express server
  - Stop WhatsApp adapter

### 5.4 No Health Check for Dependencies
- The `/health` endpoint (line 18-19) returns static `ok` regardless of whether the database, Telegram, or any API key is actually working. It does not check Claude API reachability or DB integrity.

### 5.5 No DB Migrations System
- **File**: `src/utils/db.ts`
- Schema changes are handled via `CREATE TABLE IF NOT EXISTS` and ad-hoc migration blocks (lines 167-191). There is no version tracking or migration framework. Adding a column to an existing table requires manual ALTER TABLE statements.

### 5.6 No Monitoring or Alerting
- No Prometheus metrics, no error tracking (Sentry), no uptime monitoring beyond the basic health endpoint.
- API cost tracking exists in the DB but there's no automated alert if spending exceeds a threshold (the 21:00 cron check in `index.ts` line 99-115 only checks $0.50/day -- no weekly or monthly caps).

### 5.7 No Data Retention Policy
- Messages, memories, tool usage, and API usage records grow indefinitely. There is no cleanup job for old messages, no archiving strategy, and no DB size monitoring.
- The only cleanup is memory maintenance (decay + consolidation) which runs daily but only affects the `memories` table.

---

## 6. Prioritized Recommendations

### P0 -- Critical (do immediately)
1. **Rotate all API keys** -- the `.env` file was readable during this analysis. Even though it's `.gitignore`d, verify no keys were committed in git history.
2. **Add shell command sandboxing** -- at minimum, block known-dangerous patterns; ideally run in a container or use a restricted shell.
3. **Separate dashboard auth from API bridge auth** -- use distinct secrets for distinct purposes.
4. **Stop embedding GITHUB_TOKEN in git URLs** -- use credential helpers or environment-based auth.

### P1 -- High (this sprint)
5. **Replace `execSync` with async `exec`** throughout `tools.ts` to unblock the event loop.
6. **Split `tools.ts`** into individual tool modules (~35 files of 30-50 lines each).
7. **Add input validation** for tool parameters (length limits, type checks, sanitization).
8. **Add basic test coverage** for security-critical functions: `isPathAllowed`, `isUrlAllowed`, `isEmailAllowed`, `matchesCronNow`.
9. **Fix media isolation** -- the `currentRequestId` pattern is not concurrency-safe. Pass request context explicitly.

### P2 -- Medium (next cycle)
10. **Extract inline HTML** from `server.ts` into separate files.
11. **Add structured logging** with pino (already a dependency).
12. **Add retry logic** for external API calls with exponential backoff.
13. **Implement proper graceful shutdown** that drains in-flight requests.
14. **Add a DB migration system** (even a simple version-number approach).
15. **De-duplicate** HTML stripping and deploy logic.

### P3 -- Nice-to-have (backlog)
16. **Add data retention policy** -- auto-archive messages older than 90 days.
17. **Add monitoring** -- Prometheus metrics or at least structured error counts.
18. **Improve health check** -- verify DB connectivity and API key validity.
19. **Expand WhatsApp adapter** -- handle images, voice, documents.
20. **Add rate limiting** to dashboard API endpoints.
