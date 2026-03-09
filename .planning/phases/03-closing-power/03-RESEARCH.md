# Phase 3: Closing Power - Research

**Researched:** 2026-03-09
**Domain:** Google Calendar integration, business hours logic, escalation system
**Confidence:** HIGH

## Summary

Phase 3 adds three capabilities: (1) Google Calendar meeting booking with free/busy checks, (2) business hours awareness for Israel timezone, and (3) escalation to Alon with Telegram notifications. The existing codebase already has the Telegram notification module (`notifyAlon`), Monday.com status updates (`updateMondayStatus` with `meeting-scheduled` and `escalated` statuses), and a Claude-based conversation engine that needs extension.

The key architectural decision is to follow AlonBot's proven pattern: use a **Google Apps Script web app** as a proxy to Google Calendar, rather than integrating the Google Calendar API directly. This avoids OAuth2 complexity, service account setup, and Google API client library overhead. The Apps Script exposes simple HTTP endpoints (GET for queries, POST for mutations) that the bot calls with `fetch`.

**Primary recommendation:** Extend the existing AlonBot Google Apps Script with a `freeBusy` action, add a `src/calendar/` module that wraps the HTTP calls, extend the conversation orchestrator to detect meeting-booking and escalation triggers, and add business hours logic as a standalone utility.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Use Google Calendar API via service account or OAuth2 (actual implementation: Apps Script proxy, same pattern as AlonBot)
- Bot checks available slots before suggesting meeting times
- Business hours: Sunday-Thursday 09:00-18:00, Friday 09:00-13:00 (Israel timezone)
- No meetings on Shabbat or Israeli holidays
- Calendar event includes: lead name, phone number, service interest, conversation summary
- Calendar ID via env var GOOGLE_CALENDAR_ID
- Google credentials via service account JSON file or env var (actual: GOOGLE_CALENDAR_SCRIPT_URL)
- Israel timezone (Asia/Jerusalem)
- After hours: bot acknowledges, says will follow up tomorrow, still responds but doesn't push for meetings
- Escalation triggers: 3 failed conversation attempts OR lead explicitly asks for human
- Telegram notification with 3-line summary: what they want, budget signals, concerns
- Monday.com status updates to "escalated" or "meeting-scheduled"
- Escalation uses existing Telegram notification module (grammy)
- Bot suggests 2-3 available time slots
- Lead confirms slot via text
- Bot creates calendar event and confirms

### Claude's Discretion
- How to detect "3 failed attempts" in conversation flow (heuristic or explicit counter)
- Exact escalation message wording
- How to parse time slot confirmation from Hebrew text
- Whether to offer Zoom link or phone call for meeting
- After-hours response tone and exact wording

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CAL-01 | Bot checks Google Calendar free/busy slots before suggesting meeting times | Apps Script `freeBusy` action + `src/calendar/` module; system prompt instructs Claude when to check slots |
| CAL-02 | Bot books discovery meeting on Google Calendar when lead confirms a time | Apps Script `add` action (same as AlonBot); conversation orchestrator detects confirmation and creates event |
| CAL-03 | Business hours awareness — different responses during and after hours | `src/utils/business-hours.ts` utility; system prompt includes current time context; conversation flow adjusts behavior |
| ESC-01 | Bot escalates after 3 failed attempts or when lead requests a human | DB column `escalation_count` on leads; conversation orchestrator increments and checks; system prompt detects "want human" |
| ESC-02 | Escalation sends Telegram notification to Alon with conversation summary | Existing `notifyAlon()` from `src/notifications/telegram.ts`; new `generateEscalationSummary()` using Claude |
| ESC-03 | Bot generates 3-line conversation summary on escalation | Claude call with focused prompt: extract want/budget/concerns from conversation history |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Google Apps Script | N/A (cloud) | Calendar proxy API | Already used by AlonBot, avoids Google API client complexity |
| grammy | ^1.41.1 | Telegram notifications | Already installed and working for escalation |
| better-sqlite3 | ^12.6.2 | Escalation counter persistence | Already installed |
| @anthropic-ai/sdk | ^0.78.0 | Conversation summary generation | Already installed |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | - | - | All needed libraries already installed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Apps Script proxy | googleapis npm package | Direct API adds ~15 deps, OAuth2 token refresh complexity, service account setup; Apps Script is zero-deps and proven |
| Apps Script proxy | Google Calendar API v3 REST directly | Still needs OAuth2/service account auth; Apps Script handles auth internally |

**Installation:**
```bash
# No new packages needed -- all dependencies already installed
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── calendar/
│   ├── api.ts              # HTTP calls to Apps Script (getSlots, bookMeeting)
│   ├── business-hours.ts   # Israel timezone, business hours logic, holiday awareness
│   └── __tests__/
│       ├── api.test.ts
│       └── business-hours.test.ts
├── escalation/
│   ├── handler.ts          # Escalation logic (detect triggers, notify, update status)
│   ├── summary.ts          # Generate 3-line summary via Claude
│   └── __tests__/
│       ├── handler.test.ts
│       └── summary.test.ts
├── ai/
│   ├── conversation.ts     # Extended: meeting booking flow + escalation detection
│   └── system-prompt.ts    # Extended: calendar + business hours + escalation instructions
├── db/
│   └── schema.ts           # Extended: escalation_count column on leads
└── config.ts               # Extended: GOOGLE_CALENDAR_SCRIPT_URL
```

### Pattern 1: Apps Script Calendar Proxy
**What:** Google Apps Script deployed as web app, called via simple HTTP fetch
**When to use:** Always for calendar operations
**Example:**
```typescript
// Source: AlonBot pattern (alonbot/src/tools/handlers/calendar.ts)
// GET free/busy slots
const res = await fetch(
  `${config.googleCalendarScriptUrl}?action=freeBusy&date=${date}&days=3`,
  { signal: AbortSignal.timeout(10000) }
);
const data = await res.json();
// data.slots = [{ date: "2026-03-10", time: "10:00", available: true }, ...]

// POST create event
const res = await fetch(config.googleCalendarScriptUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'add',
    title: `פגישת היכרות - ${leadName}`,
    date: '2026-03-10',
    time: '10:00',
    duration_minutes: 30,
    description: `טלפון: ${phone}\nעניין: ${interest}\n\n${summary}`,
  }),
});
```

### Pattern 2: Business Hours Check
**What:** Utility that checks if current Israel time is within business hours
**When to use:** Before suggesting meetings, adjusting conversation tone
**Example:**
```typescript
// src/calendar/business-hours.ts
const ISRAEL_TZ = 'Asia/Jerusalem';

export function isBusinessHours(date: Date = new Date()): boolean {
  const israelTime = new Date(date.toLocaleString('en-US', { timeZone: ISRAEL_TZ }));
  const day = israelTime.getDay(); // 0=Sun, 6=Sat
  const hour = israelTime.getHours();
  const minute = israelTime.getMinutes();
  const timeDecimal = hour + minute / 60;

  if (day === 6) return false; // Saturday
  if (day === 5) return timeDecimal >= 9 && timeDecimal < 13; // Friday 09:00-13:00
  if (day === 0) return timeDecimal >= 9 && timeDecimal < 18; // Sunday
  if (day >= 1 && day <= 4) return timeDecimal >= 9 && timeDecimal < 18; // Mon-Thu
  return false;
}

export function getNextBusinessDay(from: Date = new Date()): Date {
  // Returns next business day start (09:00 Israel time)
  // Skips Friday afternoon, Saturday, handles timezone
}
```

### Pattern 3: Escalation via Conversation Context
**What:** Claude detects escalation triggers in its response, conversation orchestrator acts on them
**When to use:** Every conversation turn
**Example:**
```typescript
// Approach: Use system prompt to instruct Claude to output special markers
// when escalation is needed, then detect in post-processing

// In system prompt:
// "אם הלקוח מבקש לדבר עם אדם, או שאתה מרגיש שהשיחה לא מתקדמת,
//  הוסף בסוף ההודעה שלך: [ESCALATE]"

// In conversation.ts:
const response = await generateResponse(messages, systemPrompt);
if (response.includes('[ESCALATE]')) {
  const cleanResponse = response.replace('[ESCALATE]', '').trim();
  await triggerEscalation(phone, lead);
  return cleanResponse;
}

// Alternative: counter-based approach for "no meaningful response"
// Increment escalation_count when lead doesn't engage
```

### Pattern 4: Meeting Booking via System Prompt Instructions
**What:** System prompt tells Claude about available slots, Claude formats the offer naturally
**When to use:** When conversation reaches meeting-booking stage
**Example:**
```typescript
// Before calling Claude, inject available slots into system prompt context
const slots = await getAvailableSlots(3); // next 3 business days
const slotsText = slots.map(s => `${s.date} בשעה ${s.time}`).join(', ');

// Add to system prompt:
// ## זמנים פנויים לפגישה
// הזמנים הבאים פנויים: ${slotsText}
// כשהלקוח מאשר זמן, הוסף: [BOOK:YYYY-MM-DD:HH:mm]
```

### Anti-Patterns to Avoid
- **Direct Google API integration:** Adds OAuth complexity, token refresh, and 15+ dependencies. The Apps Script proxy is simpler and already proven.
- **Timezone math with manual offsets:** Use `toLocaleString` with `timeZone: 'Asia/Jerusalem'` or Intl.DateTimeFormat. Never hardcode UTC+2/+3 (DST changes).
- **Blocking on calendar API:** Calendar checks should not block the conversation. If the API is slow/down, offer to follow up with times.
- **Storing escalation state only in memory:** Must be in DB (survives restarts).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Timezone conversion | Manual UTC offset math | `Intl.DateTimeFormat` with `timeZone: 'Asia/Jerusalem'` | DST transitions (Israel switches March/October), edge cases |
| Calendar API auth | OAuth2 token refresh flow | Google Apps Script web app proxy | Zero auth complexity, AlonBot proves it works |
| Hebrew date parsing | Regex for "יום שלישי בעשר" | System prompt markers like `[BOOK:2026-03-10:10:00]` | Claude handles Hebrew NLU, bot just parses the marker |
| Conversation summary | Manual text extraction | Claude API call with focused prompt | Claude is already integrated, summary is a natural language task |
| Holiday detection | Hardcoded holiday list | Apps Script `CalendarApp` checks against Hebrew calendar | Google Calendar already knows Israeli holidays if configured |

**Key insight:** The bot already uses Claude for conversation -- leverage Claude for all natural language tasks (detecting escalation triggers, parsing time confirmations, generating summaries) rather than building custom NLU.

## Common Pitfalls

### Pitfall 1: Israel DST Changes
**What goes wrong:** Business hours check returns wrong results during DST transition weeks
**Why it happens:** Israel switches clocks on different dates than US/EU. Hardcoding UTC+2 or UTC+3 breaks twice a year.
**How to avoid:** Always use `Intl.DateTimeFormat` or `toLocaleString` with `timeZone: 'Asia/Jerusalem'`. Never store/compare raw UTC offsets.
**Warning signs:** Tests pass in winter but fail in summer (or vice versa).

### Pitfall 2: Race Condition on Double-Booking
**What goes wrong:** Two leads confirm the same slot before either event is created
**Why it happens:** Free/busy check and event creation are not atomic
**How to avoid:** (1) After creating the event, verify it was created successfully. (2) Offer multiple slots so one conflict doesn't block everything. (3) If creation fails with conflict, apologize and offer new slots.
**Warning signs:** Calendar shows overlapping events for same time.

### Pitfall 3: Apps Script Timeout
**What goes wrong:** Google Apps Script has a 30-second execution limit (6 minutes for complex scripts)
**Why it happens:** Querying a busy calendar or network latency
**How to avoid:** Set `AbortSignal.timeout(10000)` on fetch calls. Have a graceful fallback: "אני בודק את הלוח ואחזור אליך עם זמנים פנויים."
**Warning signs:** Fetch calls hanging, conversation flow stalling.

### Pitfall 4: Escalation Counter Not Resetting
**What goes wrong:** Lead gets escalated even after re-engaging because counter was never reset
**Why it happens:** Counter only increments, never resets on meaningful response
**How to avoid:** Reset `escalation_count` to 0 whenever lead sends a substantive message (not just a single emoji or "ok")
**Warning signs:** Leads who had a slow start get escalated despite active conversation.

### Pitfall 5: Claude Inconsistent Markers
**What goes wrong:** Claude sometimes forgets to add `[BOOK:...]` or `[ESCALATE]` markers
**Why it happens:** System prompt instructions can be "forgotten" in long conversations
**How to avoid:** (1) Place marker instructions at the END of system prompt (recency bias). (2) Use explicit examples. (3) Add a post-processing fallback: if response mentions "פגישה" + a date/time, try to parse it.
**Warning signs:** Meeting confirmations in conversation but no calendar event created.

## Code Examples

### Available Slots Query
```typescript
// src/calendar/api.ts
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('calendar');

interface TimeSlot {
  date: string;   // YYYY-MM-DD
  time: string;   // HH:mm
  dayName: string; // יום ראשון, etc.
}

export async function getAvailableSlots(days: number = 3): Promise<TimeSlot[]> {
  if (!config.googleCalendarScriptUrl) {
    log.warn('Google Calendar not configured');
    return [];
  }

  try {
    const res = await fetch(
      `${config.googleCalendarScriptUrl}?action=freeBusy&days=${days}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) {
      log.error({ status: res.status }, 'Calendar API error');
      return [];
    }
    const data = await res.json() as { slots: TimeSlot[] };
    return data.slots || [];
  } catch (err) {
    log.error({ err }, 'Calendar request failed');
    return [];
  }
}
```

### Book Meeting
```typescript
// src/calendar/api.ts (continued)
interface BookingResult {
  success: boolean;
  eventId?: string;
  error?: string;
}

export async function bookMeeting(
  date: string,
  time: string,
  leadName: string,
  phone: string,
  interest: string,
  summary: string,
): Promise<BookingResult> {
  try {
    const res = await fetch(config.googleCalendarScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        title: `פגישת היכרות - ${leadName}`,
        date,
        time,
        duration_minutes: 30,
        description: [
          `שם: ${leadName}`,
          `טלפון: ${phone}`,
          `עניין: ${interest}`,
          '',
          'סיכום שיחה:',
          summary,
        ].join('\n'),
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json() as BookingResult;
    return data;
  } catch (err) {
    log.error({ err }, 'Calendar booking failed');
    return { success: false, error: 'Calendar request failed' };
  }
}
```

### Escalation Summary
```typescript
// src/escalation/summary.ts
import { generateResponse } from '../ai/claude-client.js';

export async function generateEscalationSummary(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  leadName: string,
): Promise<string> {
  const summaryPrompt = `סכם את השיחה הבאה עם ${leadName} ב-3 שורות בדיוק:
1. מה הלקוח מחפש (שירות/מוצר)
2. סימנים לגבי תקציב (אם יש)
3. חששות או התנגדויות עיקריות

תן רק את 3 השורות, בלי כותרות.`;

  return generateResponse(
    [
      ...messages,
      { role: 'user', content: summaryPrompt },
    ],
    'אתה עוזר שמסכם שיחות מכירה. תן סיכום קצר ומדויק.',
  );
}
```

### Business Hours in System Prompt
```typescript
// In system-prompt.ts extension
import { isBusinessHours } from '../calendar/business-hours.js';

// Add to buildSystemPrompt():
const now = new Date();
const israelFormatter = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  weekday: 'long',
  hour: '2-digit',
  minute: '2-digit',
});
const currentTime = israelFormatter.format(now);
const duringHours = isBusinessHours(now);

// Append to system prompt:
`
## שעות פעילות
השעה עכשיו: ${currentTime}
${duringHours
  ? 'אנחנו בשעות פעילות — אפשר להציע פגישות ולדחוף לסגירה.'
  : 'אנחנו מחוץ לשעות פעילות — תגיב בחום אבל אל תדחוף לפגישה. אמור שתחזור עם הצעה מחר.'}
`
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| googleapis npm + OAuth2 | Apps Script web app proxy | AlonBot pattern (2025) | Zero dependencies, no token management |
| Manual timezone offsets | Intl.DateTimeFormat API | Native in Node.js 18+ | Correct DST handling automatically |
| Custom NLU for Hebrew | Claude system prompt markers | Claude 3.5+ (2024) | Claude handles Hebrew understanding natively |

**Deprecated/outdated:**
- `moment-timezone`: Use native `Intl.DateTimeFormat` instead (zero deps)
- Direct Google API client: Unnecessary complexity for simple calendar operations

## Open Questions

1. **Apps Script Deployment**
   - What we know: AlonBot already has a deployed Apps Script with `list` and `add` actions
   - What's unclear: Can we extend the same script with `freeBusy`, or do we need a separate deployment?
   - Recommendation: Extend the existing AlonBot Apps Script with a `freeBusy` action. Same script URL, new action parameter. If not possible, deploy a copy.

2. **Israeli Holiday Handling**
   - What we know: CONTEXT.md says "no meetings on Israeli holidays"
   - What's unclear: How to detect Israeli holidays programmatically
   - Recommendation: Google Calendar can have a Hebrew holidays calendar subscribed. The `freeBusy` Apps Script action should check against it. Alternatively, start without holiday detection (most leads won't book on holidays anyway) and add later.

3. **Meeting Type (Zoom vs Phone)**
   - What we know: CONTEXT.md doesn't specify
   - What's unclear: Does Alon prefer Zoom or phone for discovery calls?
   - Recommendation: Default to phone call (simpler, no Zoom API needed). Bot says "אלון יתקשר אליך ב-[time]". Can add Zoom later.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run --reporter=verbose` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CAL-01 | getAvailableSlots returns free slots from Apps Script | unit | `npx vitest run src/calendar/__tests__/api.test.ts -t "available slots"` | Wave 0 |
| CAL-02 | bookMeeting creates calendar event | unit | `npx vitest run src/calendar/__tests__/api.test.ts -t "book meeting"` | Wave 0 |
| CAL-03 | isBusinessHours returns correct values for Israel timezone | unit | `npx vitest run src/calendar/__tests__/business-hours.test.ts` | Wave 0 |
| ESC-01 | Escalation triggers after 3 failed attempts or human request | unit | `npx vitest run src/escalation/__tests__/handler.test.ts` | Wave 0 |
| ESC-02 | Escalation calls notifyAlon with formatted message | unit | `npx vitest run src/escalation/__tests__/handler.test.ts -t "telegram"` | Wave 0 |
| ESC-03 | generateEscalationSummary produces 3-line summary | unit | `npx vitest run src/escalation/__tests__/summary.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run --reporter=verbose`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/calendar/__tests__/api.test.ts` -- covers CAL-01, CAL-02
- [ ] `src/calendar/__tests__/business-hours.test.ts` -- covers CAL-03
- [ ] `src/escalation/__tests__/handler.test.ts` -- covers ESC-01, ESC-02
- [ ] `src/escalation/__tests__/summary.test.ts` -- covers ESC-03

## Sources

### Primary (HIGH confidence)
- AlonBot codebase (`/Users/oakhome/קלוד עבודות/alonbot/src/tools/handlers/calendar.ts`) -- proven Apps Script proxy pattern
- WhatsApp bot codebase (`/Users/oakhome/קלוד עבודות/alon-dev-whatsapp/src/`) -- existing architecture, modules, patterns
- [Google Apps Script Calendar Service](https://developers.google.com/apps-script/reference/calendar) -- CalendarApp.getEvents() for free/busy
- [Google Calendar Freebusy API](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query) -- Advanced Calendar Service in Apps Script

### Secondary (MEDIUM confidence)
- [Apps Script Calendar Availability](https://support.google.com/docs/thread/216159453/app-script-calendar-availability) -- community patterns for availability checking

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already installed and proven in this project or AlonBot
- Architecture: HIGH -- follows established patterns (Apps Script proxy, pino logging, ESM TypeScript)
- Pitfalls: HIGH -- based on actual AlonBot production experience and timezone/calendar domain knowledge

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable stack, no fast-moving dependencies)
