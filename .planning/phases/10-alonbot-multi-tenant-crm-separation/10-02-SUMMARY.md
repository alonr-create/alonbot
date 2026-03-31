---
phase: "10-alonbot-multi-tenant-crm-separation"
plan: "10-02"
subsystem: "multi-tenant"
tags: [tenant, cloud-api, conversation, system-prompt, routing]
dependency_graph:
  requires: []
  provides: ["tenant-aware-conversation", "per-tenant-system-prompt", "per-tenant-cloud-token"]
  affects: ["conversation-handler", "system-prompt", "cloud-webhook"]
tech_stack:
  added: []
  patterns: ["optional-tenant-param-threading", "per-tenant-fallback-config"]
key_files:
  created: []
  modified:
    - src/ai/conversation.ts
    - src/ai/system-prompt.ts
    - src/whatsapp/cloud-api.ts
    - src/http/routes/whatsapp-cloud-webhook.ts
    - tests/whatsapp-cloud-routing.test.ts
decisions:
  - "Tenant param is optional (not required) so existing callers are backward-compatible"
  - "buildSystemPrompt uses tenant fields only when tenant is provided; otherwise falls back to global getConfig singletons"
  - "createCloudAdapter accepts optional token for per-tenant Cloud API tokens, falls back to WA_CLOUD_TOKEN env var"
  - "Cloud webhook logs a warning (not error) when phoneNumberId has no matching tenant — fallback to global config keeps bot running"
metrics:
  duration: "8min"
  completed: "2026-03-31"
  tasks: 4
  files: 5
---

# Phase 10 Plan 02: Wire Tenant Context Through Cloud Webhook Into Conversation Handler Summary

Tenant lookup wired into Cloud API webhook so each incoming message resolves a TenantRow from `phoneNumberId`, threads it through the message batcher into `handleConversation`, which uses tenant-specific business name, owner name, service catalog, personality, and admin phone instead of the global `tenant_config` singleton.

## What Was Built

### Task 1 — handleConversation accepts optional TenantRow
`handleConversation(phone, messages, adapter, tenant?)` — fourth optional param. All internal `isAdminPhone(phone)` calls updated to `isAdminPhone(phone, tenant)`, and `buildSystemPrompt` receives the tenant.

### Task 2 — buildSystemPrompt accepts optional TenantRow
`buildSystemPrompt(name, interest, phone?, isWebsite?, tenant?)` — fifth optional param. When tenant is provided, uses `tenant.owner_name`, `tenant.business_name`, `tenant.personality`, and parses JSON from `tenant.service_catalog`, `tenant.portfolio`, `tenant.sales_faq`, `tenant.sales_objections`. Falls back to global getters when tenant is absent (backward compatible).

### Task 3 — Cloud webhook resolves tenant
`whatsapp-cloud-webhook.ts` now:
1. Calls `lookupTenantByPhoneNumberId(msg.phoneNumberId)` for each parsed message
2. Uses `isAdminPhone(phone, tenant)` (tenant-aware admin skip)
3. Calls `createCloudAdapter(phoneNumberId, tenant?.wa_cloud_token)` for per-tenant tokens
4. Passes tenant to `handleConversation` via batcher callback

`createCloudAdapter` and `sendCloudMessage` updated to accept optional `token` param.

### Task 4 — Tests
5 new tests in `tests/whatsapp-cloud-routing.test.ts` under "Tenant-aware Cloud webhook routing (10-02)":
- `lookupTenantByPhoneNumberId` called with correct phoneNumberId
- Resolved tenant passed through to `handleConversation`
- undefined tenant when phoneNumberId not in DB (graceful fallback)
- `isAdminPhone` called with tenant arg
- `createCloudAdapter` uses per-tenant token for Authorization header

## Test Results

- New tests: 5/5 passing
- Total passing: 161 (unchanged from pre-plan baseline)
- Pre-existing failures: 4 (calendar API mock + Monday webhook tests — not caused by this plan)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

Files exist:
- src/ai/conversation.ts — FOUND
- src/ai/system-prompt.ts — FOUND
- src/whatsapp/cloud-api.ts — FOUND
- src/http/routes/whatsapp-cloud-webhook.ts — FOUND
- tests/whatsapp-cloud-routing.test.ts — FOUND

Commits:
- 235c57e — FOUND
- 2229239 — FOUND
- 8bd949e — FOUND
- 6938305 — FOUND
