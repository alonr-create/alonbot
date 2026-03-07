# Phase 3: Reliability & Observability — Plan

**Created:** 2026-03-07
**Requirements:** REL-01, REL-02, REL-03, REL-04

## Wave 1 (Parallel — no dependencies)

### Plan 01: REL-04 — Structured Logging with pino
- Install pino dependency
- Create `src/utils/logger.ts` with `createLogger(module)` factory
- Replace all `console.log/warn/error` calls across 13+ files with pino child loggers
- Each file gets module context: `const log = createLogger('agent')`
- Output: valid JSON with `level`, `msg`, `module`, `time` fields

### Plan 02: REL-03 — Retry with Exponential Backoff
- Create `src/utils/retry.ts` with `withRetry()` wrapper
- Exponential backoff: base 1s, max 10s, 3 retries
- Retry on 429, 5xx, network errors (ECONNRESET, ETIMEDOUT)
- Wrap 12+ external API calls: Gemini, ElevenLabs, DuckDuckGo, Monday, GitHub, Groq, Calendar

## Wave 2 (Depends on Wave 1 — needs logger)

### Plan 03: REL-01 — Async Shell Execution
- Create `src/utils/shell.ts` with `execAsync()` wrapper using `spawn`
- Migrate `execSync` calls in shell, cron, auto-improve, build-website, manage-project, screenshot
- Keep shell blocklist check before async execution
- code_agent already uses spawn (no changes needed)

### Plan 04: REL-02 — Fix Empty Catch Blocks
- Replace 17 empty `catch {}` blocks with proper error logging via pino
- Low-severity: add `log.debug()` (temp file cleanup, JSON parse, process kill)
- Medium-severity: add `log.warn()` (DB operations, knowledge search)
- Keep intentional fire-and-forget patterns (router stream edits) but log at debug level

## Success Criteria
1. `sleep 10` in shell doesn't freeze the bot
2. Transient 500 from Gemini/ElevenLabs retries automatically
3. Every previously swallowed error appears in structured log output
4. Log output is valid JSON with `level`, `msg`, `module`, `time` fields

---
*Created: 2026-03-07*
