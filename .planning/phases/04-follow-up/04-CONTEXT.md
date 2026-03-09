# Phase 4: Follow-up - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Automated 3-message follow-up series for unresponsive leads (day 1, day 3, day 7) that respects business hours (Israel timezone) and stops immediately when the lead re-engages. Uses the existing follow_ups table in SQLite and node-cron or similar scheduler.

</domain>

<decisions>
## Implementation Decisions

### Follow-up Series
- 3 messages at day 1, day 3, day 7 after last bot message with no reply
- Each message has distinct, non-repetitive content — escalating urgency
- Message 1 (day 1): friendly check-in ("היי, רציתי לוודא שקיבלת את ההודעה שלי...")
- Message 2 (day 3): value reminder with urgency ("יש לי עוד כמה לקוחות שמתעניינים...")
- Message 3 (day 7): last chance ("זו ההודעה האחרונה שלי, אם תרצה לחזור...")
- Claude generates the actual follow-up text based on conversation context — not static templates
- Follow-up content is personalized based on the lead's interest and conversation history

### Stop Conditions
- Follow-up stops immediately when lead sends ANY reply
- Follow-up stops if lead status changes to escalated, meeting-scheduled, or closed-won/lost
- Follow-up stops after the 3rd message (no infinite follow-up)
- If lead replies to a follow-up, conversation resumes normally through the AI engine

### Business Hours Enforcement
- Follow-ups only sent during business hours: Sun-Thu 09:00-18:00, Fri 09:00-13:00
- If scheduled time falls outside business hours, defer to next business day morning (09:30)
- Never send follow-ups on Shabbat
- Use the existing `isBusinessHours()` and `getNextBusinessDay()` from Phase 3's calendar module

### Scheduler
- Use node-cron or setInterval to check for pending follow-ups every 15 minutes
- Check the follow_ups table for due messages
- Mark follow-ups as sent after successful delivery
- The follow_ups table already exists in the schema from Phase 1

### Claude's Discretion
- Exact follow-up message tone and content (within the 3-message escalating pattern)
- How to summarize conversation context for follow-up generation
- Whether to use a separate system prompt for follow-ups or extend the existing one

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/db/schema.ts` — follow_ups table already exists (created in Phase 1)
- `src/calendar/business-hours.ts` — `isBusinessHours()`, `getNextBusinessDay()`, `formatIsraelTime()`
- `src/ai/claude-client.ts` — Claude API wrapper for generating follow-up content
- `src/ai/system-prompt.ts` — can extend for follow-up context
- `src/whatsapp/rate-limiter.ts` — `sendWithTyping()` for sending follow-up messages
- `src/config.ts` — env var pattern for follow-up config

### Established Patterns
- TypeScript ESM with `.js` import extensions
- pino structured logging
- Fire-and-forget for non-critical operations
- better-sqlite3 with WAL mode

### Integration Points
- Message handler: when lead replies, cancel pending follow-ups
- Follow-up scheduler: reads from follow_ups table, sends via WhatsApp socket
- Database: follow_ups table needs phone, scheduled_at, sent_at, message_number columns

</code_context>

<specifics>
## Specific Ideas

- Follow-ups should feel natural, not automated — Claude generates unique text each time
- The 3-message pattern creates increasing urgency without being annoying
- After the 3rd follow-up with no reply, the lead is considered cold — no more contact

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 04-follow-up*
*Context gathered: 2026-03-09*
