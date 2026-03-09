---
phase: 04-follow-up
plan: 01
subsystem: follow-up
tags: [sqlite, claude-ai, scheduler, whatsapp, tdd]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: DB schema, rate limiter, config
  - phase: 03-closing-power
    provides: business hours, escalation statuses
provides:
  - follow_ups table with indexes
  - DB operations (schedule, cancel, get-due, mark-sent)
  - AI follow-up message generation with tone escalation
  - 15-minute interval scheduler with business hours enforcement
affects: [04-follow-up]

# Tech tracking
tech-stack:
  added: []
  patterns: [cascading-follow-up-schedule, tone-escalating-ai-prompts, race-condition-guard]

key-files:
  created:
    - src/follow-up/follow-up-db.ts
    - src/follow-up/follow-up-ai.ts
    - src/follow-up/scheduler.ts
    - src/follow-up/__tests__/follow-up-db.test.ts
    - src/follow-up/__tests__/scheduler.test.ts
  modified:
    - src/db/schema.ts

key-decisions:
  - "Used vi.clearAllMocks with beforeEach re-initialization for mock isolation in scheduler tests"
  - "Cascading schedule: #1 -> #2 in 2 days, #2 -> #3 in 4 days, #3 -> stop"
  - "Business hours deferral updates scheduled_at to next business day + 30min (09:30)"

patterns-established:
  - "Follow-up module pattern: separate DB ops, AI generation, and scheduler layers"
  - "Race condition guard: re-read cancellation status before sending"

requirements-completed: [FU-01, FU-03]

# Metrics
duration: 5min
completed: 2026-03-09
---

# Phase 4 Plan 1: Follow-up Module Summary

**SQLite follow-up table with cascading scheduler (day 1/3/7), Claude tone-escalating AI messages, and business hours enforcement**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-09T09:07:22Z
- **Completed:** 2026-03-09T09:12:54Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Follow-ups table with partial indexes for efficient due-query lookups
- 4 DB operations (schedule, cancel, get-due, mark-sent) with alonPhone skip and terminal status filtering
- AI message generation with 3 tone levels: friendly check-in, urgency reminder, respectful close
- 15-minute scheduler with business hours enforcement, deferral to 09:30 next business day, cascading schedule chain

## Task Commits

Each task was committed atomically:

1. **Task 1: Follow-up DB schema + operations** - `bc887f0` (test), `1cd2983` (feat) - TDD RED->GREEN
2. **Task 2: Follow-up AI + scheduler** - `c175579` (test), `9b7f252` (feat) - TDD RED->GREEN

## Files Created/Modified
- `src/db/schema.ts` - Added follow_ups table with CHECK constraint and partial indexes
- `src/follow-up/follow-up-db.ts` - scheduleFollowUp, getDueFollowUps, cancelFollowUps, markFollowUpSent
- `src/follow-up/follow-up-ai.ts` - Claude-powered Hebrew follow-up generation with tone escalation
- `src/follow-up/scheduler.ts` - 15-min interval processor with business hours, cascading, race guard
- `src/follow-up/__tests__/follow-up-db.test.ts` - 9 tests covering all DB operations
- `src/follow-up/__tests__/scheduler.test.ts` - 6 tests covering send, defer, cascade, cancel

## Decisions Made
- Cascading follow-up days: #1 at trigger, #2 at day 3 (2 days later), #3 at day 7 (4 days later)
- Business hours deferral pushes to 09:30 next business day (not just 09:00)
- Race condition guard re-reads cancellation before send to prevent stale-state sends
- Used vi.clearAllMocks with explicit mock re-initialization in beforeEach for reliable test isolation

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Mock state leaking between vitest tests when using vi.restoreAllMocks (clears factory implementations). Resolved by using vi.clearAllMocks with explicit mock re-initialization in beforeEach.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Follow-up module ready for integration with message handler (plan 04-02)
- scheduleFollowUp and cancelFollowUps exports available for cross-module use
- startFollowUpScheduler ready to be called from bot startup

---
*Phase: 04-follow-up*
*Completed: 2026-03-09*
