---
phase: 02-sales-conversation
plan: 01
subsystem: api
tags: [monday.com, graphql, webhook, express, sqlite]

requires:
  - phase: 01-foundation
    provides: Express HTTP server, SQLite database with leads table, config module, pino logger

provides:
  - Monday.com webhook endpoint at POST /webhook/monday
  - GraphQL API module for fetching items and updating status
  - TypeScript types for Monday.com payloads
  - Config fields for ANTHROPIC_API_KEY, MONDAY_API_TOKEN, MONDAY_BOARD_ID, MONDAY_STATUS_COLUMN_ID
  - Schema migration adding monday_item_id, monday_board_id, interest columns
  - express.json() middleware on HTTP server
  - onNewLead callback hook for conversation layer integration

affects: [02-02-conversation-engine, 03-closing-power]

tech-stack:
  added: []
  patterns: [fire-and-forget for non-critical API calls, async processing after 200 response, idempotent ALTER TABLE migrations]

key-files:
  created:
    - src/monday/types.ts
    - src/monday/api.ts
    - src/monday/webhook-handler.ts
    - src/monday/__tests__/config-schema.test.ts
    - src/monday/__tests__/api.test.ts
    - src/monday/__tests__/webhook.test.ts
  modified:
    - src/config.ts
    - src/db/schema.ts
    - src/http/server.ts

key-decisions:
  - "Fire-and-forget pattern for Monday.com status updates -- non-critical sync should never crash the bot"
  - "Phone column detection by multiple possible IDs (phone, phone_number) for Monday.com board flexibility"
  - "Race condition prevention: skip auto-intro if lead has messages within last 5 minutes"

patterns-established:
  - "Async webhook processing: respond 200 immediately, process event in background"
  - "Idempotent schema migrations: try/catch ALTER TABLE for SQLite column additions"
  - "Callback hooks: setOnNewLeadCallback pattern for cross-module integration"

requirements-completed: [MON-01, MON-02, MON-03]

duration: 5min
completed: 2026-03-09
---

# Phase 02 Plan 01: Monday.com Webhook Integration Summary

**Monday.com webhook endpoint with GraphQL API for lead ingestion and bidirectional status sync**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-09T07:42:17Z
- **Completed:** 2026-03-09T07:47:08Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Monday.com webhook handles challenge verification and create_item events
- GraphQL API fetches item data (name, phone, interest) and updates status columns
- Leads created/updated in DB with monday_item_id, monday_board_id, interest fields
- Phone number normalization (Israeli format, 972 prefix)
- Race condition prevention for lead-initiated vs Monday-initiated contacts
- Callback hook ready for conversation engine integration

## Task Commits

Each task was committed atomically:

1. **Task 1: Config, schema, types** - `28a3e1c` (test: RED) -> `f536c5b` (feat: GREEN)
2. **Task 2: Webhook handler and API** - `9455cfa` (test: RED) -> `e1650cd` (feat: GREEN)

_TDD: Each task has separate test commit (RED) and implementation commit (GREEN)_

## Files Created/Modified
- `src/monday/types.ts` - LeadStatus, MondayWebhookPayload, MondayItem type definitions
- `src/monday/api.ts` - fetchMondayItem and updateMondayStatus GraphQL functions
- `src/monday/webhook-handler.ts` - Express router for /webhook/monday with challenge + event handling
- `src/monday/__tests__/config-schema.test.ts` - Tests for config fields, schema migration, types
- `src/monday/__tests__/api.test.ts` - Tests for GraphQL API functions
- `src/monday/__tests__/webhook.test.ts` - Tests for webhook challenge, event processing, DB operations
- `src/config.ts` - Added 4 new env var fields (Anthropic + Monday.com)
- `src/db/schema.ts` - Added idempotent ALTER TABLE for 3 new columns
- `src/http/server.ts` - Added express.json() middleware and webhook router mount

## Decisions Made
- Fire-and-forget for Monday.com status updates (updateMondayStatus never throws)
- Phone column detection uses multiple possible column IDs for board flexibility
- Race condition prevention: 5-minute window check before auto-intro
- Callback hook pattern (setOnNewLeadCallback) for loose coupling with conversation layer

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required

Environment variables needed before Monday.com integration works:
- `MONDAY_API_TOKEN` - Monday.com API token
- `MONDAY_BOARD_ID` - Board ID for leads
- `MONDAY_STATUS_COLUMN_ID` - Status column ID (defaults to 'status')
- `ANTHROPIC_API_KEY` - For Claude API (used in later plans)

## Next Phase Readiness
- Webhook endpoint ready to receive Monday.com events
- onNewLead callback hook ready for Plan 02 (conversation engine) to wire up
- All 40 tests passing, TypeScript clean

## Self-Check: PASSED

All 6 created files verified on disk. All 4 commit hashes verified in git log.

---
*Phase: 02-sales-conversation*
*Completed: 2026-03-09*
