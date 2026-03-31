---
phase: "09-whatsapp-cloud-api-infrastructure"
plan: "09-02"
subsystem: "whatsapp-cloud-api"
tags: ["cloud-api", "webhook", "conversation-routing", "bot-adapter"]
dependency-graph:
  requires: ["09-01"]
  provides: ["cloud-api-full-conversation-routing"]
  affects: ["src/whatsapp/cloud-api.ts", "src/http/routes/whatsapp-cloud-webhook.ts", "src/whatsapp/connection.ts"]
tech-stack:
  added: []
  patterns: ["CloudBotAdapter implements BotAdapter interface", "webhook-to-batcher-to-conversation pipeline"]
key-files:
  created: []
  modified:
    - "src/whatsapp/cloud-api.ts"
    - "src/whatsapp/connection.ts"
    - "src/http/routes/whatsapp-cloud-webhook.ts"
    - "tests/whatsapp-cloud-routing.test.ts"
decisions:
  - "BotAdapter is now a proper interface in connection.ts (not ReturnType<createAdapter>) so CloudBotAdapter and wwebjs adapter both implement it"
  - "CloudBotAdapter sendPresenceUpdate is a no-op — Cloud API has no typing indicator support"
  - "Webhook routes each message through addMessageToBatch to preserve 8-second debounce behavior"
metrics:
  duration: "7min"
  completed: "2026-03-31"
  tasks: 3
  files: 4
---

# Phase 09 Plan 02: Wire Cloud API Webhook to Conversation Handler Summary

**One-liner:** Cloud API webhook now routes incoming messages through message batcher and AI conversation handler using a `CloudBotAdapter` that implements the `BotAdapter` interface.

## What Was Built

The 09-01 plan built the Cloud API adapter and webhook endpoint, but the webhook POST only logged messages. This plan wired those messages into the full conversation pipeline.

### Task 1: CloudBotAdapter factory

Added `createCloudAdapter(phoneNumberId): CloudBotAdapter` to `src/whatsapp/cloud-api.ts`:
- `sendMessage` delegates to `sendCloudMessage` with the caller's `phoneNumberId`
- `sendPresenceUpdate` is a no-op (Cloud API has no typing indicators)
- `sendAudio`, `sendImage`, `sendDocument` are no-ops (phase 9 scope)

Also promoted `BotAdapter` in `src/whatsapp/connection.ts` from `ReturnType<typeof createAdapter>` (which baked in the whatsapp-web.js `Client` type) to a proper exported interface. This allows `CloudBotAdapter` to satisfy the same contract without carrying wweb.js dependencies.

### Task 2: Webhook routing

Updated `src/http/routes/whatsapp-cloud-webhook.ts`:
- For each parsed message: creates `CloudBotAdapter` scoped to the message's `phoneNumberId`
- Cancels pending follow-ups for the sender (same behavior as wweb.js handler)
- Skips admin phone (boss messages not processed via Cloud API)
- Routes text through `addMessageToBatch` → `handleConversation`
- Always returns 200 regardless (prevents Meta retry storms)

### Task 3: Tests

Added 9 new tests to `tests/whatsapp-cloud-routing.test.ts`:
- `createCloudAdapter` — phoneNumberId in URL, jid stripping, no-ops
- Webhook routing — routes to batcher, cancels follow-ups, skips admin, handles status-only

## Verification

- `npm run build` passes (TypeScript clean)
- `npm test`: 136 pass / 4 fail — same 4 pre-existing failures, 9 new tests all pass

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] BotAdapter type included whatsapp-web.js Client dependency**

- **Found during:** Task 2
- **Issue:** `BotAdapter = ReturnType<typeof createAdapter>` structurally required `_wwebClient: Client`, making `CloudBotAdapter` not assignable
- **Fix:** Changed `BotAdapter` to an explicit interface in `connection.ts` with only the public API methods; removed the `ReturnType` typedef
- **Files modified:** `src/whatsapp/connection.ts`
- **Commit:** 9ce53c3

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | c1f3de5 | feat(09-02): add CloudBotAdapter factory to cloud-api.ts |
| 2 | 9ce53c3 | feat(09-02): wire Cloud API webhook to conversation handler |
| 3 | 5206bf6 | test(09-02): add tests for CloudBotAdapter and webhook routing |

## Self-Check: PASSED

- `src/whatsapp/cloud-api.ts` — contains `createCloudAdapter` export
- `src/whatsapp/connection.ts` — `BotAdapter` is now an interface
- `src/http/routes/whatsapp-cloud-webhook.ts` — routes to `addMessageToBatch`
- `tests/whatsapp-cloud-routing.test.ts` — 36 tests pass
