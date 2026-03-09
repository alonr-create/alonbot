# Phase 3: Closing Power - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Google Calendar integration for meeting booking with free/busy checks, business hours awareness (Israel timezone), and escalation to Alon when bot cannot close (after 3 failed attempts or when lead requests a human). Escalation includes Telegram notification with 3-line conversation summary and Monday.com status update.

</domain>

<decisions>
## Implementation Decisions

### Google Calendar Integration
- Use Google Calendar API via service account or OAuth2 for free/busy queries and event creation
- Bot checks available slots before suggesting meeting times to leads
- Meeting slots offered during business hours only: Sunday-Thursday 09:00-18:00, Friday 09:00-13:00 (Israel timezone)
- No meetings on Shabbat (Friday evening through Saturday evening) or Israeli holidays
- Calendar event includes: lead name, phone number, service interest, conversation summary
- Alon's calendar ID configured via env var (GOOGLE_CALENDAR_ID)
- Google credentials via service account JSON file or env var

### Business Hours Awareness
- Israel timezone (Asia/Jerusalem)
- Business hours: Sun-Thu 09:00-18:00, Fri 09:00-13:00
- After hours: bot acknowledges message, says "אחזור אליך מחר בשעות הפעילות" or similar
- Bot still responds to messages after hours (AI conversation continues) but doesn't push for meetings/calls
- Meeting suggestions only during business hours

### Escalation to Alon
- Triggers: 3 failed conversation attempts (lead not engaging) OR lead explicitly asks for a human
- Telegram notification to Alon with 3-line summary: what they want, budget signals, concerns
- Monday.com status updates to "escalated"
- Bot tells the lead: "אלון יחזור אליך בהקדם" or similar
- Escalation uses existing Telegram notification module from Phase 1 (grammy)
- "Failed attempt" = bot sent message but got no meaningful response within conversation context

### Meeting Booking Flow
- Bot suggests 2-3 available time slots in the conversation
- Lead confirms a slot via text ("הראשון" / "בעשר" / etc.)
- Bot creates Google Calendar event and confirms to lead
- Monday.com status updates to "meeting-scheduled"
- Bot sends meeting confirmation with date, time, and Zoom/phone details

### Claude's Discretion
- How to detect "3 failed attempts" in conversation flow (heuristic or explicit counter)
- Exact escalation message wording
- How to parse time slot confirmation from Hebrew text
- Whether to offer Zoom link or phone call for meeting
- After-hours response tone and exact wording

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/notifications/telegram.ts` — Telegram notification to Alon, ready for escalation summaries
- `src/notifications/whatsapp-notify.ts` — WhatsApp backup notification to Alon's personal number
- `src/ai/conversation.ts` — Conversation orchestrator, needs extension for meeting booking and escalation
- `src/ai/system-prompt.ts` — System prompt needs calendar and escalation instructions added
- `src/monday/api.ts` — `updateMondayStatus()` already handles status changes including "meeting-scheduled" and "escalated"
- `src/config.ts` — Environment variable pattern for adding Google Calendar and escalation config

### Established Patterns
- TypeScript ESM with `.js` import extensions
- pino structured logging with `createLogger(module)`
- Express v5 router pattern
- Fire-and-forget for non-critical operations (Monday.com updates)
- Callback hooks for cross-module integration

### Integration Points
- Conversation orchestrator: extend with meeting booking tool use and escalation logic
- System prompt: add calendar availability and escalation instructions
- Config: add GOOGLE_CALENDAR_ID, GOOGLE_CREDENTIALS, escalation thresholds
- Database: may need escalation_count or conversation_attempts tracking on leads table

</code_context>

<specifics>
## Specific Ideas

- AlonBot (existing Telegram bot) already has Google Calendar API integration as reference
- Bot should feel natural when suggesting meeting times — not robotic
- Escalation should feel like a warm handoff, not a failure

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-closing-power*
*Context gathered: 2026-03-09*
