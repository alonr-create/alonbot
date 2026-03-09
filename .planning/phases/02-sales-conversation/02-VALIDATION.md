---
phase: 2
slug: sales-conversation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.18 |
| **Config file** | vitest.config.ts (exists from Phase 1) |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~8 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 8 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-01-01 | 01 | 1 | MON-01 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 02-01-02 | 01 | 1 | MON-02 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 02-01-03 | 01 | 1 | MON-03 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 02-02-01 | 02 | 1 | AI-01 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 02-02-02 | 02 | 1 | AI-02 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 02-02-03 | 02 | 1 | AI-03 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 02-02-04 | 02 | 1 | AI-04 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 02-02-05 | 02 | 1 | AI-05 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/monday/__tests__/webhook.test.ts` — webhook challenge + event handling (MON-01)
- [ ] `src/monday/__tests__/api.test.ts` — fetch item + update status (MON-02, MON-03)
- [ ] `src/ai/__tests__/conversation.test.ts` — Claude call + history building (AI-01, AI-03)
- [ ] `src/ai/__tests__/system-prompt.test.ts` — prompt content + price ranges (AI-02, AI-05)
- [ ] `src/whatsapp/__tests__/message-batcher.test.ts` — debounce + batching (AI-04)

*Existing test infrastructure from Phase 1 covers all framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Monday.com webhook receives real events | MON-01 | Requires actual Monday.com board setup | Create webhook in Monday.com UI pointing to bot URL, create test lead, verify processing |
| Claude generates appropriate Hebrew responses | AI-01 | Requires live Claude API call | Send test message, verify Hebrew response is relevant and sales-oriented |
| Price quotes within defined ranges | AI-05 | Requires live Claude API judgment | Ask about specific services, verify quoted prices are within min/max ranges |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 8s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
