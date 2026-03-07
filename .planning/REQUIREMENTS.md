# Requirements: AlonBot v25

**Defined:** 2026-03-07
**Core Value:** Alon can ask for anything and the bot handles it end-to-end through Telegram, reliably and without breaking.

## v1 Requirements

### Security

- [x] **SEC-01**: Shell tool executes commands in a sandboxed environment with blocked destructive patterns (rm -rf /, curl | sh, etc.)
- [x] **SEC-02**: GITHUB_TOKEN is never embedded in git remote URLs or visible in tool output sent to Telegram
- [x] **SEC-03**: Dashboard auth uses HttpOnly cookie instead of query parameter token
- [x] **SEC-04**: Tool parameters are validated (types, ranges, required fields) before execution
- [x] **SEC-05**: Auth token for dashboard and cloud-local bridge are separate secrets

### Architecture

- [x] **ARCH-01**: Each tool lives in its own module under `src/tools/` with a common `ToolHandler` interface
- [x] **ARCH-02**: Tool registry auto-discovers and loads tools from `src/tools/` directory
- [x] **ARCH-03**: `tools.ts` god file is eliminated — only re-exports the registry
- [x] **ARCH-04**: Dashboard and chat HTML are served from static `.html` files, not inline template literals
- [x] **ARCH-05**: HTML stripping logic is extracted to a shared `src/utils/html.ts` utility
- [x] **ARCH-06**: Deploy logic (Vercel/Railway) is deduplicated into a shared deploy helper

### Reliability

- [x] **REL-01**: Shell and code_agent use async `spawn` instead of `execSync` (non-blocking)
- [x] **REL-02**: All empty `catch {}` blocks are replaced with proper error logging
- [x] **REL-03**: External API calls (Claude, Telegram, Gemini, ElevenLabs) have retry with exponential backoff
- [x] **REL-04**: pino is wired as the logger with structured JSON output and `[module]` context

### Quality

- [x] **QAL-01**: Vitest is configured with at least one test file per `src/` module category
- [x] **QAL-02**: Pure utility functions (date formatting, URL validation, HTML stripping) have unit tests
- [x] **QAL-03**: Health endpoint checks DB connectivity, memory usage, and uptime details
- [x] **QAL-04**: Database schema has a versioned migration system (migration files + version table)

## v2 Requirements

### New Features

- **FEAT-01**: WhatsApp adapter handles image, voice, and document messages (not just text)
- **FEAT-02**: Plugin system — tools can be added as standalone files without modifying core code
- **FEAT-03**: Monitoring dashboard with error rates, API latency, and cost tracking graphs
- **FEAT-04**: CI pipeline (GitHub Actions) with build + test on push

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-user support | Single-user personal assistant by design |
| Postgres migration | SQLite fits single-user, no need for complexity |
| Web UI redesign | Dashboard is functional, not priority |
| WhatsApp feature parity | Telegram is primary channel |
| Mobile app | Telegram IS the mobile app |
| Worker processes/queues | Single-process is sufficient for one user |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 | 1 | Complete |
| SEC-02 | 1 | Complete |
| SEC-03 | 1 | Complete |
| SEC-04 | 1 | Complete |
| SEC-05 | 1 | Complete |
| ARCH-01 | 2 | Complete |
| ARCH-02 | 2 | Complete |
| ARCH-03 | 2 | Complete |
| ARCH-04 | 2 | Complete |
| ARCH-05 | 2 | Complete |
| ARCH-06 | 2 | Complete |
| REL-01 | 3 | Complete |
| REL-02 | 3 | Complete |
| REL-03 | 3 | Complete |
| REL-04 | 3 | Complete |
| QAL-01 | 4 | Complete |
| QAL-02 | 4 | Complete |
| QAL-03 | 4 | Complete |
| QAL-04 | 4 | Complete |

**Coverage:**
- v1 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0

---
*Requirements defined: 2026-03-07*
*Last updated: 2026-03-07 after initial definition*
