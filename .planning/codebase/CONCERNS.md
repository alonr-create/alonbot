# Codebase Concerns

**Analysis Date:** 2026-03-26

## Tech Debt

**Swallowed Exception Patterns:**
- Issue: 30+ catch blocks use empty comments or silent logging without recovery
- Files: `src/gateway/server.ts` (28 instances), `src/agent/agent.ts` (6 instances), `src/index.ts` (2 instances), `src/channels/whatsapp-cloud.ts`
- Impact: Silent failures make debugging hard; API errors (e.g., Monday.com, WhatsApp) fail without user notification. Abandoned cart/review request failures are logged but don't alert the user.
- Fix approach: Differentiate between "expected transient errors" (log + continue) and "unexpected failures" (log + notify user). Add error telemetry to understand which catch blocks fire most.

**Dynamic SQL String Interpolation (Potential SQL Injection):**
- Issue: SQL prepared statements mix parameters with inline template literals for dynamic column lists and IN clauses
- Files:
  - `src/gateway/server.ts` lines 1212, 1385, 1482 (UPDATE with dynamic column names)
  - `src/gateway/server.ts` lines 909, 914, 940, 946, 949, 961 (IN clause with dynamic sources)
  - `src/gateway/followup-engine.ts` lines 324, 428 (date offset calculation in SQL)
- Impact: If column names or source values come from untrusted input, SQL injection is possible. Currently safe because column names are hardcoded, but pattern is fragile.
- Fix approach: Build column update maps as objects validated at compile time. For IN clauses, validate sources against whitelist before constructing placeholder string.
- Example risk: `db.prepare(`UPDATE leads SET next_followup = date('now', '+${days} days')`).run()` — if `days` is user input without validation, attacker can inject SQL.

**Type Coercion with `any` Type:**
- Issue: 12+ database queries cast results to `any[]` or `any` without validation
- Files: `src/gateway/server.ts`, `src/agent/agent.ts`, `src/index.ts` (cron jobs)
- Impact: Missing properties assumed to exist cause null reference errors at runtime. Examples:
  - Line 95-97 (memory.ts): `SELECT ... user_replies, last_message` — if column is null, code may crash
  - Line 369 (agent.ts): `db.prepare(...).run(block.name, toolSuccess, toolDuration)` — assumes `block.name`, `block.type` exist
- Fix approach: Add TypeScript interfaces for all DB result types. Use `as const` assertions on table schemas.

**Unbounded Cron Job Count:**
- Issue: `src/cron/scheduler.ts` loads all cron jobs from DB and starts them without limit
- Files: `src/cron/scheduler.ts`, `src/index.ts` (lines 80-81)
- Impact: If a user adds 1000+ cron jobs, Node.js will hit memory limits or listener exhaustion (max 10 listeners warning).
- Fix approach: Cap at 100 active crons per workspace. Archive old/disabled crons. Add cron job health check.

**Timezone Handling Fragility:**
- Issue: Multiple mismatched timezone conversion patterns:
  - `new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', ...})` creates date string, then re-parse to Date (lines 30, 229, 292-293)
  - `sv-SE` locale for YYYY-MM-DD HH:mm format (line 161) is fragile — relies on undocumented behavior
  - cron.js library uses local system time, not Israel time consistently
- Files: `src/index.ts` (lines 30, 161, 229, 292-293), `src/gateway/router.ts`, `src/utils/db.ts`
- Impact: DST transitions can cause scheduled messages to run at wrong time. Cross-timezone bugs (user in US, bot in Israel cloud).
- Fix approach: Use a timezone library (date-fns-tz or Temporal API) throughout. Remove all `toLocaleString` conversions.

**Vector Embedding Blocking:**
- Issue: Memory embeddings (`embedUnembeddedMemories`) run in background at startup (line 105-107) but no timeout or skip if embeddings service is down
- Files: `src/index.ts`, `src/agent/memory.ts`
- Impact: If embedding API (via local endpoint) fails, it doesn't block startup but causes silent memory degradation. New memories won't be searchable.
- Fix approach: Add 10-second timeout, skip if endpoint unreachable, warn user. Schedule retry every 5 minutes instead of fire-and-forget.

**Rate Limiting in Memory:**
- Issue: Rate limit map (`rateLimitMap`) stored in memory; resets on process restart
- Files: `src/agent/agent.ts` (lines 43-64)
- Impact: In cloud deployment with multiple instances, rate limiting is per-instance. User can bypass limit by sending to multiple instances.
- Fix approach: Move rate limiting to Redis or DB. Include instance ID in rate limit key for cloud mode.

## Known Bugs

**Duplicate WAMID Processing Across Instances:**
- Symptoms: Same WhatsApp message processed twice on cloud deployment
- Files: `src/channels/whatsapp-cloud.ts` (lines 107-128)
- Trigger: Webhook forwarding middleware + direct Meta webhook both receive same message
- Current mitigation: 10-minute dedup window at adapter level
- Workaround: Disable forwarding middleware if using direct Meta webhooks

**Checkout Abandoned Cart Reminders Not Sent:**
- Symptoms: Customer never receives "you forgot to checkout" message
- Files: `src/index.ts` (lines 226-256)
- Trigger: Cloud mode check at line 227 exits early if local mode; WhatsApp adapter not started in local mode
- Workaround: Run in cloud mode (MODE=cloud) to enable abandoned cart cron

**Memory Vector Search Fails Silently on Cold Start:**
- Symptoms: Memory search returns no results when bot first starts
- Files: `src/agent/memory.ts`, `src/utils/embeddings.ts`
- Trigger: `embedUnembeddedMemories()` hasn't finished; vector tables are empty
- Workaround: Wait 30 seconds after startup before querying memory
- Fix: Add startup wait gate for memory search

**Telegram Webhook 409 Conflicts on Rapid Deploys:**
- Symptoms: "Conflict: terminated bot" error after redeployment
- Files: `src/channels/telegram.ts`, `src/index.ts`
- Trigger: Old Telegram connection still active when new instance starts; both try to register webhook
- Workaround: Stagger deploys by 30+ seconds; use graceful shutdown
- Fix: Implement webhook state machine to handle concurrent resets

## Security Considerations

**API Key Exposure in Error Messages:**
- Risk: If external API calls fail, response bodies may contain tokens
- Files: `src/channels/whatsapp-cloud.ts` (line 35), `src/gateway/server.ts` (multiple)
- Current mitigation: Logs are kept in container; .env not committed
- Recommendation: Add response sanitizer for API errors; never log full response body in JSON

**Baileys Session File Not Encrypted:**
- Risk: Session file at `/data/baileys_alonbot_session/` contains WhatsApp authentication credentials
- Files: `src/channels/whatsapp.ts`, backup in `src/utils/db.ts` (lines 182-197)
- Current mitigation: Local mode only; file not exposed via HTTP
- Recommendation: Encrypt session file at rest. Rotate session weekly.

**Local API Secret Generated Randomly if Missing:**
- Risk: If `LOCAL_API_SECRET` not set, bot generates random secret (line 21 config.ts)
- Files: `src/utils/config.ts`, `src/index.ts` (abandoned cart, review cron use `config.localApiSecret`)
- Impact: Local tools (shell, camera) callable with any secret if process is restarted
- Fix: Require `LOCAL_API_SECRET` to be set; fail startup if missing

**Dashboard Token Reuse (DASHBOARD_SECRET = LOCAL_API_SECRET):**
- Risk: Single token protects both API calls and dashboard access
- Files: `src/utils/config.ts` (line 22), `src/gateway/server.ts` (wa-manager, wa-inbox routes)
- Impact: Compromised API secret gives full dashboard access
- Fix: Separate tokens with different permissions

**No CSRF Protection on Form Endpoints:**
- Risk: POST endpoints (save-lead, update-template, etc.) accept body without CSRF token
- Files: `src/gateway/server.ts` (lines 1200+)
- Current mitigation: Dashboard accessed locally or with secret token
- Recommendation: Add token validation to all state-changing endpoints

## Performance Bottlenecks

**Memory Queries Unbounded by Default:**
- Problem: `getSmartContext()` and memory search return up to 30-35 memories with no pagination
- Files: `src/agent/memory.ts` (lines 57, 73, CONTEXT_LIMIT = 35)
- Cause: Each context window search scans full memory table
- Impact: With 10k+ memories, queries slow down. Token usage increases.
- Improvement path: Add indexing by date + importance; paginate at 10 memories; implement memory decay/archiving

**Cron Job Deduplication Full Scan:**
- Problem: `matchesCronNow()` iterates workflows table every minute
- Files: `src/index.ts` (lines 199-223)
- Cause: No indexed lookups; validates every row's cron expression
- Impact: 100+ workflows cause noticeable delay
- Improvement: Index by trigger_type; cache validated expressions

**Message History Load Per Request:**
- Problem: `getHistory()` loads last N messages on every user message
- Files: `src/agent/memory.ts` (line 107), `src/agent/agent.ts`
- Cause: No message cache; repeated DB hits
- Impact: User with 10k messages experiences 200ms latency on each request
- Improvement: Cache last 30 messages per user; invalidate on new message

**Vector Embedding API Network Call:**
- Problem: Every upsert to memories table triggers HTTP call to embedding service
- Files: `src/agent/memory.ts`, `src/utils/embeddings.ts`
- Cause: Sync embedding on insert (non-batched)
- Impact: Memory save takes 500-2000ms; blocks message flow
- Improvement: Batch embeddings; run async; use local model if available

**Monday.com API Polling Every 5 Minutes:**
- Problem: Two separate crons query Monday leads (lines 332-395, followup-engine.ts)
- Files: `src/index.ts`, `src/gateway/followup-engine.ts`
- Cause: No dedup; both poll same board
- Impact: 2 API calls per 5 minutes; Monday rate limits
- Improvement: Single consolidated leads poller; cache board state

## Fragile Areas

**WhatsApp Cloud API Template System:**
- Files: `src/gateway/followup-engine.ts` (lines 129-300), `src/gateway/server.ts` (template handlers)
- Why fragile: Templates tied to hardcoded Meta template IDs (line 129). If template name changes in Meta, mapping breaks. No fallback to text messages.
- Safe modification: Validate template ID exists in Meta before sending. Add SMS fallback. Store template mapping in DB, not hardcoded.
- Test coverage: No tests for template send failure. No tests for text fallback.

**Babel/Evolution API Dual Mode:**
- Files: `src/channels/whatsapp.ts`, `src/channels/whatsapp-cloud.ts`, `src/index.ts` (lines 56-78)
- Why fragile: 3 WhatsApp adapters (Baileys, Cloud API, Evolution API) can be active simultaneously. Message routing in `router.ts` picks first matching adapter; if two are registered, behavior is undefined.
- Safe modification: Add explicit channel selection in config. Validate only one WhatsApp adapter is active at startup.
- Test coverage: No integration tests for adapter conflicts

**Lead Status Enum Not Validated:**
- Files: `src/gateway/followup-engine.ts`, `src/gateway/server.ts` (lead_status column)
- Why fragile: `lead_status` values (`new`, `contacted`, `booked`, `closed`, etc.) hardcoded in 15+ places. No enum. Typo in one place silently breaks filtering.
- Safe modification: Create TS enum for lead statuses. Add DB constraint CHECK(lead_status IN (...)).
- Test coverage: No tests for invalid status values

**Timezone Conversion in Cron Trigger:**
- Files: `src/index.ts` (line 292-315 matchesCronNow)
- Why fragile: Custom cron parser doesn't match node-cron library exactly. Line 307 has step logic that may miss matches around DST transitions.
- Safe modification: Use node-cron's validation + explicit Israel timezone. Add unit tests for DST edge cases.
- Test coverage: No tests for DST, leap seconds, or rare cron patterns

## Scaling Limits

**SQLite Database Locks on High Concurrency:**
- Current capacity: SQLite with WAL mode supports ~10-20 concurrent writers
- Limit: If bot processes 50+ messages/minute from multiple channels, write lock contention appears
- Scaling path: Migrate to PostgreSQL; add connection pooling (PgBouncer)

**Memory Cache Size (Rate Limiting + Dedup Maps):**
- Current capacity: Rate limit map holds 1000 users × 10 timestamps = 10KB; dedup maps hold 1000 messages = 50KB
- Limit: With 5 instances on cloud, each holds separate cache. No cluster-wide coordination.
- Scaling path: Move rate limiting and dedup to Redis. Size: 1GB Redis enough for 10M users at 10 timestamps each.

**Tool Execution Queue (Single-threaded Node.js):**
- Current capacity: TOOL_TIMEOUT_MS = 30 seconds per tool; blocking tools (shell, camera) block message queue
- Limit: If 3+ users request simultaneous tools, others wait 30+ seconds
- Scaling path: Offload long-running tools to separate worker pool. Use piscina or Bull job queue.

**Vector Database (sqlite-vec):**
- Current capacity: sqlite-vec fits ~1M embeddings in SQLite
- Limit: Beyond 100k memories, search becomes slow (no GPU acceleration)
- Scaling path: Switch to Pinecone or Weaviate; migrate memories to cloud vector DB

**Telegram Polling (Local Mode Only):**
- Current capacity: Single polling loop handles ~100 messages/second
- Limit: If bot used by 1000+ users, polling becomes a bottleneck
- Scaling path: Use cloud mode with webhooks (not polling)

## Dependencies at Risk

**sqlite-vec@0.1.7-alpha:**
- Risk: Alpha version; API may change; no v1.0 release
- Impact: Embedding queries may break on update
- Migration plan: Monitor github.com/asg017/sqlite-vec for v1.0. Test upgrades in staging first. Consider backup: use external vector DB (Pinecone) + keep embeddings in sqlite-vec for local fallback.

**@whiskeysockets/baileys@6.7.21:**
- Risk: Maintains unofficial WhatsApp reverse-engineered protocol; breaks on WhatsApp client updates
- Impact: Local WhatsApp mode may stop working without notice
- Migration plan: Already have Cloud API as primary. Keep Baileys as fallback only. Monitor releases weekly.

**grammy@1.35.0:**
- Risk: Telegram bot framework; API stable but occasional breaking changes
- Impact: Telegram adapter may need updates on Telegram API changes
- Migration plan: Lock version in package-lock.json. Test Telegram updates in staging. Subscribe to grammy releases.

**node-cron@4.0.7:**
- Risk: Custom cron scheduler; not POSIX-compliant
- Impact: Rare cron patterns (e.g., `*/15 * * * 1-5`) may not work as expected
- Migration plan: Add unit tests for all cron expressions used. Consider switching to croner library.

## Missing Critical Features

**No Persistent Job Queue:**
- Problem: Cron jobs run in-memory only. If bot crashes, running job is lost.
- Blocks: Reliable scheduled sends, long-running workflows
- Priority: High (affects business-critical follow-ups)

**No Message Delivery Receipts:**
- Problem: No tracking of whether sent WhatsApp/Telegram messages were delivered
- Blocks: Guaranteed message delivery, retry on failed sends
- Priority: High (customers may miss important messages)

**No Backup/Recovery for Leads Database:**
- Problem: Leads table has no point-in-time recovery
- Blocks: Data recovery if leads table is corrupted
- Priority: Medium (data loss risk)

**No Multi-Workspace Role Isolation:**
- Problem: All users with dashboard token see all workspaces
- Blocks: Multi-tenant usage, per-workspace access control
- Priority: Medium

**No Conversation Threading:**
- Problem: All messages from user stored flat; no thread grouping
- Blocks: Better context management for long conversations
- Priority: Low

## Test Coverage Gaps

**WhatsApp Message Types Not Covered:**
- What's not tested: voice messages, images, documents, location, contacts
- Files: `src/channels/whatsapp-cloud.ts` (processIncomingMessage), `src/channels/whatsapp.ts`
- Risk: Unhandled message type causes null reference or incomplete processing
- Priority: High (affects customer communication)

**Cron Expression Validation:**
- What's not tested: DST transitions, rare patterns, invalid expressions
- Files: `src/index.ts` (matchesCronNow function)
- Risk: Scheduled messages run at wrong time or fail silently
- Priority: High

**Tool Execution Failure Handling:**
- What's not tested: Tool timeout, network errors, partial failures
- Files: `src/agent/agent.ts` (tool execution block)
- Risk: Tool failures cascade; user gets generic "failed" message
- Priority: Medium

**Memory Search with Empty Index:**
- What's not tested: Searching when vector index is empty/corrupt
- Files: `src/agent/memory.ts`
- Risk: Search crashes if sqlite-vec returns invalid data
- Priority: Medium

**Dashboard API Input Validation:**
- What's not tested: Malformed JSON, oversized payloads, invalid enum values
- Files: `src/gateway/server.ts` (all POST endpoints)
- Risk: Invalid input causes 500 errors or corrupts DB
- Priority: Medium

---

*Concerns audit: 2026-03-26*
