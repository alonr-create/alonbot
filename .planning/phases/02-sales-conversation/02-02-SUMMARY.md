---
phase: 02-sales-conversation
plan: 02
subsystem: ai
tags: [claude-api, anthropic-sdk, conversation, message-batching, hebrew-sales, whatsapp]

requires:
  - phase: 01-foundation
    provides: WhatsApp connection, SQLite database, rate limiter, message handler
  - phase: 02-sales-conversation
    plan: 01
    provides: Monday.com webhook, GraphQL API, lead status types, config fields

provides:
  - Claude API client with Anthropic SDK wrapper and error handling
  - Full Hebrew system prompt with Alon.dev service catalog and exact price ranges
  - Conversation orchestrator with DB history, Claude call, response delivery, status sync
  - Per-phone 8-second message batcher (debounce)
  - Rewritten message handler routing to batcher+AI instead of TEST_RESPONSE
  - sendFirstMessage for Monday.com webhook auto-intro
  - Media message handling with text-only notice
  - Lead status auto-progression (new->contacted->in-conversation->quote-sent)

affects: [03-closing-power, 04-follow-up]

tech-stack:
  added: ["@anthropic-ai/sdk"]
  patterns: [message batching with debounce timer per phone, Claude conversation history from DB, quote detection via regex, fire-and-forget Monday.com status sync]

key-files:
  created:
    - src/ai/claude-client.ts
    - src/ai/system-prompt.ts
    - src/ai/conversation.ts
    - src/whatsapp/message-batcher.ts
    - src/ai/__tests__/system-prompt.test.ts
    - src/ai/__tests__/conversation.test.ts
    - src/whatsapp/__tests__/message-batcher.test.ts
  modified:
    - src/whatsapp/message-handler.ts
    - package.json

key-decisions:
  - "Message batcher uses Map with clearTimeout/setTimeout for debounce -- simple, no external dependency"
  - "Claude conversation context limited to last 20 messages for token cost control"
  - "Quote detection via shekel sign regex (₪[\\d,]+) -- simple, effective for Hebrew price patterns"
  - "vi.resetModules() + vi.doMock() per test for proper module isolation with dynamic imports"

patterns-established:
  - "Lazy singleton pattern for Anthropic client initialization"
  - "Conversation orchestrator pattern: DB history -> Claude call -> send -> store -> status"
  - "Per-phone debounce batching with configurable timeout"
  - "Hebrew system prompt with service catalog, price guardrails, and personality directives"

requirements-completed: [AI-01, AI-02, AI-03, AI-04, AI-05]

duration: 5min
completed: 2026-03-09
---

# Phase 02 Plan 02: AI Conversation Engine Summary

**Claude-powered Hebrew sales conversation engine with 8-second message batching, full Alon.dev service catalog, and automatic lead status progression**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-09T07:50:34Z
- **Completed:** 2026-03-09T07:55:58Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Bot now responds with Claude-generated Hebrew sales conversation instead of static TEST_RESPONSE
- Multi-message batching collects rapid messages for 8 seconds per phone before responding
- System prompt includes complete Alon.dev service catalog with all price ranges and guardrails
- Lead status auto-progresses through conversation lifecycle with Monday.com sync
- Media messages (images, audio, video, documents) handled with friendly text-only notice

## Task Commits

Each task was committed atomically:

1. **Task 1: Claude client, system prompt, message batcher** - `9c8c7f5` (test: RED) -> `a974119` (feat: GREEN)
2. **Task 2: Conversation orchestrator and message handler rewrite** - `0ced654` (test: RED) -> `4cf1bb2` (feat: GREEN)

_TDD: Each task has separate test commit (RED) and implementation commit (GREEN)_

## Files Created/Modified
- `src/ai/claude-client.ts` - Anthropic SDK wrapper with lazy singleton, error handling, token logging
- `src/ai/system-prompt.ts` - Full Hebrew system prompt with service catalog, prices, personality, guardrails
- `src/ai/conversation.ts` - Conversation orchestrator: history from DB, Claude call, send, store, status sync
- `src/whatsapp/message-batcher.ts` - Per-phone 8-second debounce timer with Map-based batch tracking
- `src/whatsapp/message-handler.ts` - Rewritten: routes to batcher+AI, handles media, wires Monday callback
- `src/ai/__tests__/system-prompt.test.ts` - 8 tests for prompt content, prices, guardrails, personality
- `src/ai/__tests__/conversation.test.ts` - 9 tests for history, storage, status, quotes, limits
- `src/whatsapp/__tests__/message-batcher.test.ts` - 6 tests for debounce, batching, cleanup
- `package.json` - Added @anthropic-ai/sdk dependency

## Decisions Made
- Message batcher uses Map with clearTimeout/setTimeout -- simple, no external dependency needed
- Claude context limited to last 20 messages for token cost control
- Quote detection via shekel sign regex -- simple, effective for Hebrew price patterns
- vi.resetModules() per test for proper isolation with vi.doMock + dynamic imports

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Conversation tests initially failed due to vi.doMock accumulating across tests. Fixed by moving vi.resetModules() to beforeEach and recreating mock functions per test.

## User Setup Required

Environment variables needed before AI conversation works:
- `ANTHROPIC_API_KEY` - Anthropic API key for Claude (from Anthropic Console)

(Monday.com env vars from Plan 02-01 also required for full status sync)

## Next Phase Readiness
- Full conversation engine operational, ready for Phase 3 closing features
- All 63 tests passing across 11 test files, TypeScript clean
- Message flow: incoming -> batcher (8s) -> conversation (history+Claude) -> sendWithTyping -> store -> status
- Monday.com flow: webhook -> create lead -> auto-intro via sendFirstMessage -> status sync

## Self-Check: PASSED

All 7 created files verified on disk. All 4 commit hashes verified in git log.

---
*Phase: 02-sales-conversation*
*Completed: 2026-03-09*
