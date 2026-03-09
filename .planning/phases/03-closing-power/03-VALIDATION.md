---
phase: 3
slug: closing-power
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-09
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.18 |
| **Config file** | vitest.config.ts (exists from Phase 1) |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | CAL-01 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | CAL-02 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 1 | CAL-03 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 2 | ESC-01 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 03-02-02 | 02 | 2 | ESC-02 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |
| 03-02-03 | 02 | 2 | ESC-03 | unit | `npx vitest run` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/calendar/__tests__/calendar.test.ts` — free/busy, booking, business hours (CAL-01, CAL-02, CAL-03)
- [ ] `src/escalation/__tests__/escalation.test.ts` — trigger logic, summary, notification (ESC-01, ESC-02, ESC-03)

*Existing test infrastructure from Phase 1 covers all framework needs.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Google Calendar shows available slots | CAL-01 | Requires live Google Calendar API | Check calendar for booked slots, verify bot doesn't suggest them |
| Calendar event created with details | CAL-02 | Requires live Google Calendar | Confirm booking via conversation, check calendar for event |
| Telegram notification received | ESC-02 | Requires live Telegram delivery | Trigger escalation, check Alon's Telegram for summary |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
