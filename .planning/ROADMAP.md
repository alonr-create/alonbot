# Roadmap: AlonBot v25

**Created:** 2026-03-07
**Phases:** 4
**Requirements:** 19

## Phase 1: Security Hardening

**Goal:** Eliminate all critical and high-severity security vulnerabilities so the bot cannot be exploited through shell injection, token leakage, or auth bypass.

**Requirements:** SEC-01, SEC-02, SEC-03, SEC-04, SEC-05

**Success Criteria:**
1. Sending a message that triggers `rm -rf /` or `curl | sh` via the shell tool is blocked and returns an error
2. Dashboard loads via a cookie-based session -- no token visible in the browser URL bar
3. Running `git remote -v` inside the bot's shell tool never shows a GitHub token in the output sent to Telegram
4. Passing an invalid type (e.g., a string where a number is expected) to any tool returns a validation error instead of crashing

## Phase 2: Architecture Refactor

**Goal:** Break the monolithic tools.ts god file into a modular registry and extract all inline HTML so each component is independently editable and testable.

**Requirements:** ARCH-01, ARCH-02, ARCH-03, ARCH-04, ARCH-05, ARCH-06

**Success Criteria:**
1. Each tool exists as a separate file under `src/tools/` -- adding a new tool means creating one file, no other files need editing
2. The old `tools.ts` file contains only imports and re-exports (under 50 lines)
3. Dashboard and chat pages load from `.html` files on disk -- editing the HTML does not require touching any `.ts` file
4. Deploying to Vercel and Railway uses the same shared helper function (no duplicated deploy logic)

## Phase 3: Reliability & Observability

**Goal:** Make the bot non-blocking, resilient to transient API failures, and fully observable through structured logs.

**Requirements:** REL-01, REL-02, REL-03, REL-04

**Success Criteria:**
1. Running a slow shell command (e.g., `sleep 10`) does not freeze the bot -- other messages are still processed during execution
2. A transient 500 error from Claude or Gemini API is retried automatically and succeeds on the next attempt without user intervention
3. Every error that was previously swallowed silently now appears in the structured JSON log output with module context
4. Log output is valid JSON with `level`, `msg`, `module`, and `time` fields on every line

## Phase 4: Quality & Maintainability

**Goal:** Establish automated testing, meaningful health checks, and a migration system so the codebase can evolve safely.

**Requirements:** QAL-01, QAL-02, QAL-03, QAL-04

**Success Criteria:**
1. Running `npm test` executes Vitest and passes with at least one test file per module category (agent, utils, gateway)
2. Pure functions like date formatting, URL validation, and HTML stripping have dedicated unit tests that catch regressions
3. The `/health` endpoint returns DB status, memory usage in MB, and uptime in seconds -- not just static "ok"
4. A new DB column can be added by creating a numbered migration file that runs automatically on startup

## Dependency Graph

Phase 1 -> Phase 2 (security fixes establish safe patterns that the tool registry must preserve)
Phase 2 -> Phase 3 (modular tools are needed before converting each from execSync to async spawn)
Phase 3 -> Phase 4 (structured logging and error handling must be in place before writing meaningful tests)

---
*Created: 2026-03-07*
