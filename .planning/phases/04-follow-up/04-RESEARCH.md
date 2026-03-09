# Phase 4: Follow-up - Research

**Researched:** 2026-03-09
**Domain:** Scheduled follow-up messaging, SQLite-based job queue, business hours enforcement
**Confidence:** HIGH

## Summary

Phase 4 adds an automated 3-message follow-up series (day 1, day 3, day 7) for leads who stop responding. The implementation is straightforward because the project already has all the building blocks: a `follow_ups` table schema pattern from Phase 1, `isBusinessHours()` and `getNextBusinessDay()` from Phase 3's calendar module, Claude API for generating personalized follow-up content, and `sendWithTyping()` for delivery. The core new code is a scheduler that runs every 15 minutes checking for due follow-ups, and integration hooks in the message handler to cancel follow-ups when a lead replies.

This is a database-driven job queue pattern -- the `follow_ups` table IS the queue. The scheduler reads due rows, sends messages, and marks them sent. No external job queue library is needed for this scale (single bot, low volume).

**Primary recommendation:** Use `setInterval` (15-minute cycle) over `node-cron` -- the project has zero cron dependencies and a simple interval check is sufficient for "check every 15 minutes" semantics. Add a `follow_ups` table via migration in schema.ts, create a `src/follow-up/` module with scheduler + logic, and hook into the message handler for cancellation.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- 3 messages at day 1, day 3, day 7 after last bot message with no reply
- Each message has distinct, non-repetitive content -- escalating urgency
- Message 1 (day 1): friendly check-in
- Message 2 (day 3): value reminder with urgency
- Message 3 (day 7): last chance
- Claude generates the actual follow-up text based on conversation context -- not static templates
- Follow-up content is personalized based on the lead's interest and conversation history
- Follow-up stops immediately when lead sends ANY reply
- Follow-up stops if lead status changes to escalated, meeting-scheduled, or closed-won/lost
- Follow-up stops after the 3rd message (no infinite follow-up)
- If lead replies to a follow-up, conversation resumes normally through the AI engine
- Follow-ups only sent during business hours: Sun-Thu 09:00-18:00, Fri 09:00-13:00
- If scheduled time falls outside business hours, defer to next business day morning (09:30)
- Never send follow-ups on Shabbat
- Use the existing isBusinessHours() and getNextBusinessDay() from Phase 3's calendar module
- Use node-cron or setInterval to check for pending follow-ups every 15 minutes
- Check the follow_ups table for due messages
- Mark follow-ups as sent after successful delivery
- The follow_ups table already exists in the schema from Phase 1

### Claude's Discretion
- Exact follow-up message tone and content (within the 3-message escalating pattern)
- How to summarize conversation context for follow-up generation
- Whether to use a separate system prompt for follow-ups or extend the existing one

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FU-01 | Automatic follow-up series for unresponsive leads: day 1, day 3, day 7 | Scheduler module with setInterval (15 min), follow_ups table as job queue, Claude generates personalized content per message number |
| FU-02 | Follow-up stops immediately when lead replies | Message handler hook: on any incoming message, DELETE or mark cancelled all pending follow-ups for that phone |
| FU-03 | Follow-ups only sent during business hours | Reuse existing `isBusinessHours()` and `getNextBusinessDay()` from `src/calendar/business-hours.ts` |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^12.6.2 | Follow-up job queue (follow_ups table) | Already in project, WAL mode, synchronous queries |
| @anthropic-ai/sdk | ^0.78.0 | Generate personalized follow-up messages | Already in project via claude-client.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | - | - | All dependencies already exist in project |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| setInterval | node-cron | node-cron adds a dependency for no benefit -- "every 15 minutes" is trivially expressed as setInterval(fn, 15*60*1000) |
| SQLite job queue | bull/bullmq/agenda | Massive overkill for ~10-50 follow-ups/day on a single-process bot |

**Installation:**
```bash
# No new packages needed -- all dependencies already installed
```

## Architecture Patterns

### Recommended Project Structure
```
src/
  follow-up/
    scheduler.ts      # setInterval loop, reads due follow-ups, sends them
    follow-up-db.ts   # DB operations: schedule, cancel, get-due, mark-sent
    follow-up-ai.ts   # Claude prompt for generating follow-up content
    __tests__/
      scheduler.test.ts
      follow-up-db.test.ts
```

### Pattern 1: SQLite as Job Queue
**What:** The `follow_ups` table stores scheduled follow-up jobs. Each row represents a single message to send at a specific time. The scheduler polls for due rows every 15 minutes.
**When to use:** Low-volume, single-process applications where a full job queue (Redis/Bull) is overkill.

```typescript
// follow_ups table schema (migration in schema.ts)
CREATE TABLE IF NOT EXISTS follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  message_number INTEGER NOT NULL CHECK(message_number IN (1, 2, 3)),
  scheduled_at TEXT NOT NULL,  -- ISO datetime in UTC
  sent_at TEXT,                -- NULL until sent
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_due
  ON follow_ups(scheduled_at) WHERE sent_at IS NULL AND cancelled = 0;
CREATE INDEX IF NOT EXISTS idx_follow_ups_phone
  ON follow_ups(phone) WHERE sent_at IS NULL AND cancelled = 0;
```

### Pattern 2: Schedule on Last Outbound Message
**What:** When the bot sends a message to a lead (in `handleConversation`), schedule follow-up #1 for 24 hours later. When follow-up #1 is sent, schedule #2 for 48 hours later. When #2 is sent, schedule #3 for 96 hours later. This cascading approach means only one pending follow-up exists at a time per phone.
**When to use:** Simpler than scheduling all 3 upfront -- avoids orphan cleanup when lead replies between follow-ups.

```typescript
// After sending a bot message in conversation.ts:
scheduleFollowUp(phone, 1, addDays(new Date(), 1));

// After sending follow-up #1 in scheduler.ts:
scheduleFollowUp(phone, 2, addDays(new Date(), 2)); // day 3 total

// After sending follow-up #2 in scheduler.ts:
scheduleFollowUp(phone, 3, addDays(new Date(), 4)); // day 7 total
```

### Pattern 3: Cancel on Any Reply
**What:** When a lead sends ANY message, immediately cancel all pending follow-ups for that phone number.
**When to use:** Always -- this is requirement FU-02.

```typescript
// In message-handler.ts, early in the message processing:
cancelFollowUps(phone);
```

### Pattern 4: Business Hours Deferral
**What:** Before sending, check `isBusinessHours()`. If outside business hours, defer to next business day at 09:30 (not 09:00, to avoid a burst of messages exactly at open).
**When to use:** For every follow-up send attempt.

```typescript
if (!isBusinessHours()) {
  const nextBiz = getNextBusinessDay();
  // Adjust to 09:30 instead of 09:00
  nextBiz.setMinutes(nextBiz.getMinutes() + 30);
  updateScheduledTime(followUpId, nextBiz);
  return; // Will be picked up in next scheduler cycle
}
```

### Pattern 5: Follow-up System Prompt
**What:** Use a dedicated system prompt for follow-up generation that includes the message number context and conversation summary.
**When to use:** For generating follow-up messages via Claude.

```typescript
function buildFollowUpPrompt(messageNumber: number, leadName: string, interest: string): string {
  const toneMap: Record<number, string> = {
    1: 'friendly check-in, casual and warm',
    2: 'value reminder with gentle urgency, mention other interested clients',
    3: 'final message, respectful closing, leave door open',
  };
  return `You are a Hebrew sales assistant for Alon.dev.
Generate a follow-up message #${messageNumber} of 3 for ${leadName}.
Tone: ${toneMap[messageNumber]}
Their interest: ${interest}
Keep it short (2-3 sentences), natural, and in Hebrew.
Do NOT mention that this is automated.`;
}
```

### Anti-Patterns to Avoid
- **Scheduling all 3 follow-ups upfront:** Creates orphan rows when lead replies after message 1. Use cascading schedule instead.
- **Using cron expressions for "every 15 minutes":** `setInterval` is simpler, more readable, and matches the existing project style (no cron anywhere).
- **Storing follow-up message text in the DB at schedule time:** Text should be generated at send time by Claude for freshness and personalization.
- **Blocking the main thread during follow-up check:** The scheduler should be async and non-blocking -- wrap in try/catch, log errors, continue.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Business hours checking | Custom timezone math | Existing `isBusinessHours()` / `getNextBusinessDay()` | Already handles DST, Friday, Shabbat |
| Message sending with delays | Direct sock.sendMessage | Existing `sendWithTyping()` | Rate limiting and typing simulation built in |
| AI text generation | Hardcoded follow-up templates | Existing `generateResponse()` + custom prompt | Personalized, natural-sounding messages |

**Key insight:** This phase is primarily integration work -- connecting existing modules (DB, business hours, Claude, WhatsApp sender) with a thin scheduler layer. Very little net-new logic is needed.

## Common Pitfalls

### Pitfall 1: Race Condition Between Scheduler and Reply
**What goes wrong:** Scheduler picks up a follow-up to send, but lead replies between the DB read and the actual send. Lead gets both their response AND an unwanted follow-up.
**Why it happens:** 15-minute poll cycle means state can change between check and action.
**How to avoid:** Re-check cancellation status immediately before sending. Use a transaction: mark as sent THEN send (if send fails, mark as unsent).
**Warning signs:** Lead complains about getting a "check-in" message right after they just replied.

### Pitfall 2: Follow-up Scheduled for Leads in Terminal States
**What goes wrong:** A lead gets escalated or books a meeting, but follow-ups were already scheduled.
**Why it happens:** Status change happens but nobody cancels the follow-ups.
**How to avoid:** Cancel follow-ups whenever lead status changes to `escalated`, `meeting-scheduled`, `closed-won`, or `closed-lost`. Add cancellation calls in the escalation handler and booking flow.

### Pitfall 3: Duplicate Follow-ups After Restart
**What goes wrong:** Bot restarts, scheduler runs immediately, sends follow-ups that were already sent moments before the crash.
**Why it happens:** `sent_at` wasn't persisted before the crash.
**How to avoid:** Mark `sent_at` BEFORE sending (optimistic), then clear it on failure. Or: use a short deduplication window (don't send if last sent message to this phone was < 5 minutes ago).

### Pitfall 4: getNextBusinessDay Skips Friday
**What goes wrong:** The existing `getNextBusinessDay()` skips both Friday and Saturday (lines 60-63 of business-hours.ts). A follow-up due Friday morning would be deferred to Sunday.
**Why it happens:** The function was designed for "start of next business day" not "next business moment".
**How to avoid:** For follow-up deferral, check `isBusinessHours()` first. Only call `getNextBusinessDay()` if currently outside hours. If it's Friday 10:00, that IS business hours -- send normally.

### Pitfall 5: Follow-up for Alon's Own Phone
**What goes wrong:** If Alon sends a test message, the bot schedules follow-ups for Alon himself.
**Why it happens:** No exclusion list for phone numbers.
**How to avoid:** Skip follow-up scheduling for `config.alonPhone`.

## Code Examples

### Scheduler Main Loop
```typescript
// Source: project pattern from setInterval usage
export function startFollowUpScheduler(sock: WASocket): void {
  const INTERVAL = 15 * 60 * 1000; // 15 minutes

  const check = async () => {
    try {
      const dueFollowUps = getDueFollowUps();
      for (const fu of dueFollowUps) {
        if (!isBusinessHours()) {
          deferToNextBusinessDay(fu.id);
          continue;
        }
        await processFollowUp(fu, sock);
      }
    } catch (err) {
      log.error({ err }, 'follow-up scheduler error');
    }
  };

  // Run immediately on startup, then every 15 minutes
  check();
  setInterval(check, INTERVAL);
  log.info({ intervalMs: INTERVAL }, 'follow-up scheduler started');
}
```

### DB Operations
```typescript
// Source: project pattern from schema.ts migrations
export function getDueFollowUps(): FollowUpRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT fu.*, l.name, l.interest, l.status
    FROM follow_ups fu
    JOIN leads l ON l.phone = fu.phone
    WHERE fu.sent_at IS NULL
      AND fu.cancelled = 0
      AND fu.scheduled_at <= datetime('now')
      AND l.status NOT IN ('escalated', 'meeting-scheduled', 'closed-won', 'closed-lost')
    ORDER BY fu.scheduled_at ASC
  `).all() as FollowUpRow[];
}

export function cancelFollowUps(phone: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE follow_ups SET cancelled = 1
    WHERE phone = ? AND sent_at IS NULL AND cancelled = 0
  `).run(phone);
  return result.changes;
}
```

### Integration with Message Handler
```typescript
// In message-handler.ts, add early in message processing:
import { cancelFollowUps } from '../follow-up/follow-up-db.js';

// Inside the message loop, after extracting phone:
const cancelled = cancelFollowUps(phone);
if (cancelled > 0) {
  log.info({ phone, cancelled }, 'follow-ups cancelled on reply');
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Static follow-up templates | AI-generated personalized follow-ups | Current best practice | More natural, higher response rates |
| External job queue (Bull/Redis) | SQLite as job queue for low-volume | Appropriate for single-process bots | Zero additional infrastructure |
| node-cron for interval tasks | setInterval for simple intervals | Always valid for fixed intervals | No dependency needed |

**Deprecated/outdated:**
- Nothing relevant -- the patterns here are stable and well-established.

## Open Questions

1. **Should follow-up #1 be scheduled on EVERY outbound bot message, or only after specific conversation states?**
   - What we know: CONTEXT says "day 1 after last bot message with no reply"
   - What's unclear: Does this mean every single bot response resets the follow-up timer? Or only after meaningful exchanges?
   - Recommendation: Schedule after every bot response, but cancel+reschedule on each new exchange. This means only truly unresponsive leads get follow-ups. The "last bot message" is the anchor.

2. **Does the follow_ups table already exist or does it need to be created?**
   - What we know: CONTEXT says "The follow_ups table already exists in the schema from Phase 1", but inspecting `src/db/schema.ts` shows NO follow_ups table -- only `leads` and `messages` tables.
   - What's unclear: This is a discrepancy -- the table was planned but not implemented.
   - Recommendation: Create the table via migration in schema.ts (same idempotent pattern used for Monday.com columns).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | Implicit (vitest finds `**/__tests__/*.test.ts`) |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run --reporter=verbose` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FU-01 | Follow-ups scheduled at day 1/3/7, distinct content generated | unit | `npx vitest run src/follow-up/__tests__/scheduler.test.ts -x` | No -- Wave 0 |
| FU-01 | Follow-up DB operations (schedule, get-due, mark-sent) | unit | `npx vitest run src/follow-up/__tests__/follow-up-db.test.ts -x` | No -- Wave 0 |
| FU-02 | Follow-ups cancelled when lead replies | unit | `npx vitest run src/follow-up/__tests__/follow-up-db.test.ts -x` | No -- Wave 0 |
| FU-03 | Business hours check before sending, defer if outside | unit | `npx vitest run src/follow-up/__tests__/scheduler.test.ts -x` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run --reporter=verbose`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/follow-up/__tests__/follow-up-db.test.ts` -- covers FU-01, FU-02 (DB operations)
- [ ] `src/follow-up/__tests__/scheduler.test.ts` -- covers FU-01, FU-03 (scheduler logic)

## Sources

### Primary (HIGH confidence)
- Project codebase inspection: `src/db/schema.ts`, `src/calendar/business-hours.ts`, `src/whatsapp/message-handler.ts`, `src/ai/conversation.ts`, `src/ai/claude-client.ts`, `src/config.ts`, `src/index.ts`, `package.json`
- Phase CONTEXT.md -- locked decisions from user discussion

### Secondary (MEDIUM confidence)
- [node-cron npm page](https://www.npmjs.com/package/node-cron) -- confirmed setInterval is sufficient for fixed-interval scheduling

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all existing code inspected
- Architecture: HIGH -- straightforward DB job queue pattern, all integration points identified
- Pitfalls: HIGH -- race conditions and edge cases identified from codebase inspection

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable patterns, no fast-moving dependencies)
