# AlonBot — Implementation Plan: Lead Workflows

## Overview
This document outlines the implementation of three integrated workflows for automatic lead management via WhatsApp, Monday.com, and Google Calendar.

**Target Workflows:**
1. Auto-create lead in Monday.com when new WhatsApp contact messages
2. Sales follow-up conversation flow (already partially implemented via system prompt)
3. Book 15-min Zoom on Google Calendar (alon12@gmail.com)

---

## Architecture Analysis

### Current State

#### 1. WhatsApp Message Processing
**File:** `src/channels/whatsapp.ts` (lines 174-331)

**Current Flow:**
1. Message received from WhatsApp (line 161-171)
2. Security check (lines 207-222):
   - Allow if sender in `allowedWhatsApp` config
   - Allow if sender phone is registered in `leads` table
3. Message content extracted and unified (lines 224-328)
4. Handler invoked with `UnifiedMessage` (line 330)

**Integration Point:** The security check (line 215) already queries the leads table:
```typescript
const lead = db.prepare('SELECT phone FROM leads WHERE phone = ?').get(senderId) as any;
isLead = !!lead;
```

**Opportunity:** After this security check passes, we can trigger Monday.com lead creation for new contacts.

#### 2. Database Schema
**File:** `src/utils/db.ts` (lines 155-171)

**Leads Table Structure:**
```sql
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,           -- WhatsApp sender phone (e.g., "972123456789")
  name TEXT,                            -- Contact name (from WhatsApp pushName or phonebook)
  source TEXT NOT NULL DEFAULT 'voice_agent',
  monday_item_id TEXT,                  -- Link to Monday.com board item ID
  last_call_summary TEXT,               -- Not used for WhatsApp yet
  last_call_sentiment TEXT,             -- Not used for WhatsApp yet
  last_call_duration_sec INTEGER,       -- Not used for WhatsApp yet
  was_booked INTEGER NOT NULL DEFAULT 0,
  call_mode TEXT,
  lead_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Critical Notes:**
- `phone` is UNIQUE key → prevents duplicate lead creation
- `monday_item_id` exists to link WhatsApp lead to Monday.com item
- `source` field allows differentiating voice_agent vs whatsapp_contact origins
- No existing auto-update trigger on Monday.com board_id or item_id creation

#### 3. Monday.com Integration
**File:** `src/tools/handlers/monday.ts` (lines 5-40)

**Current Tool:**
- Generic GraphQL query executor
- Takes raw GraphQL query string as input
- Returns JSON response (max 8000 chars)
- Requires `MONDAY_API_KEY` environment variable

**System Prompt Reference:**
- Board ID: `1443363020` (mentioned in system-prompt.ts)
- Supported tools in Dekel sales prompt: `monday_api`, `calendar_list`, `calendar_add`, `calendar_update`

**Gap:** No structured lead creation logic. GraphQL mutation must be constructed and executed as a raw query.

#### 4. Google Calendar Integration
**File:** `src/tools/handlers/calendar.ts` (lines 6-166)

**Existing Tools:**
- `calendar_list`: List upcoming events (respects lead mode for privacy)
- `calendar_add`: Create new event with title, date (YYYY-MM-DD), time (HH:mm), duration_minutes (default 60), description
- `calendar_update`: Modify event by eventId
- `calendar_delete`: Remove event by eventId

**Configuration:**
- Backend endpoint: `GOOGLE_CALENDAR_SCRIPT_URL` environment variable
- All requests include `AbortSignal.timeout(10000)` (10s timeout)
- Responses include `eventId` for subsequent updates/deletes

**Unknown:** Whether backend script supports `alon12@gmail.com` calendar or defaults to logged-in user's calendar.

#### 5. System Prompt & Agent Context
**File:** `src/agent/system-prompt.ts` (lines 62-130 for Dekel sales flow)

**Lead Detection Logic (lines 336-351):**
```typescript
if (sender in allowedWhatsApp) {
  // Use Alon context
  context.isLeadConversation = false;
} else {
  // Check leads table by phone
  const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(sender);
  if (lead?.source === 'voice_agent') {
    // Use Dekel sales prompt (pre-filtered for voice calls)
  } else if (!lead) {
    // Unknown contact → use Alon.dev sales prompt
  }
}
```

**Sales Flow (Lines 87-93 behavioral guidelines):**
1. Greet naturally
2. Qualify interest in Dekel services
3. Describe 3-month success stories
4. Propose discovery call or trial
5. Book via calendar_add tool if interested
6. Never cancel existing events
7. Respect customer preferences

**Calendar Privacy (Lines 116-129):**
- Never expose other attendees or event titles
- Lead mode redacts busy/free information

---

## Implementation Plan

### Phase 1: Auto-Create Lead in Monday.com

#### 1A. Design GraphQL Mutation
**Objective:** Create structured Monday.com board item for new WhatsApp contacts

**Research Needed:**
- Exact column_ids for the leads board (board_id=1443363020)
- Required vs optional fields for item creation
- Whether we need to set custom status, priority, or other fields

**Mutation Structure (template):**
```graphql
mutation CreateLead($boardId: Int!, $itemName: String!, $columnValues: JSON!) {
  create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
    id
  }
}
```

**Column Mapping (to be validated):**
| WhatsApp Field | Monday Column | Type |
|---|---|---|
| sender phone | phone | text |
| msg.pushName | name | text |
| 'whatsapp_contact' | source | dropdown/status |
| (empty) | last_call_summary | text/long_text |
| (empty) | lead_status | dropdown/status |

#### 1B. Modify WhatsApp Adapter
**File:** `src/channels/whatsapp.ts`

**Changes:**
1. After security check (line 219), if new contact detected:
   - Extract `senderId` and `senderName`
   - Call new function `createLeadInMonday(senderId, senderName, leadSource)`
   - Insert into local leads table immediately (to prevent duplicate API calls)
   - Log success/failure

2. New Function: `createLeadInMonday(phone, name, source)`
   ```typescript
   async function createLeadInMonday(
     phone: string,
     name: string,
     source: 'whatsapp_contact' | 'voice_agent'
   ): Promise<string | null> {
     // 1. Check if lead already exists locally
     const existing = db.prepare('SELECT id, monday_item_id FROM leads WHERE phone = ?').get(phone);
     if (existing?.monday_item_id) return existing.monday_item_id; // Already synced
     
     // 2. Build Monday.com GraphQL mutation
     const mutation = `
       mutation {
         create_item(
           board_id: 1443363020,
           item_name: "${name || phone}",
           column_values: {
             phone: "${phone}",
             name: "${name || ''}",
             source: "whatsapp_contact",
             lead_status: "new_contact"
           }
         ) {
           id
         }
       }
     `;
     
     // 3. Execute via monday_api tool
     try {
       const response = await monday_api_execute(mutation);
       const itemId = response.data?.create_item?.id;
       
       // 4. Store monday_item_id in local leads table
       db.prepare(`
         INSERT INTO leads (phone, name, source, monday_item_id, lead_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       `).run(phone, name, 'whatsapp_contact', itemId, 'new_contact');
       
       log.info({ phone, mondayId: itemId }, 'lead created in Monday.com');
       return itemId;
     } catch (err) {
       log.error({ phone, err: err.message }, 'failed to create lead in Monday.com');
       return null;
     }
   }
   ```

**Call Point:** Insert in `handleIncomingMessage()` after security check:
```typescript
async function handleIncomingMessage(msg: WAMessage) {
  // ... existing code ...
  
  // Security check
  if (!isAllowed && !isLead) {
    log.debug({ senderId }, 'blocked — not in allowed list and not a registered lead');
    return;
  }
  
  // NEW: Auto-create lead if new contact
  if (!isLead && isAllowed === false && config.mondayApiKey) {
    await createLeadInMonday(senderId, senderName, 'whatsapp_contact');
  }
  
  // ... continue with message handling ...
}
```

#### 1C. Environment Variables
**Required:**
- `MONDAY_API_KEY` — already documented as required
- `LEADS_BOARD_ID` — optional, default to 1443363020

---

### Phase 2: Sales Follow-Up Conversation Flow

#### 2A. Analysis
**Current Status:** Already implemented via system prompt (mostly complete)

**Existing Behavior:**
1. WhatsApp message arrives from new contact
2. Agent queries leads table by phone
3. If `source === 'whatsapp_contact'`, agent uses `buildLeadSalesPrompt()`
4. Sales flow includes:
   - Greeting + qualification
   - Discovery of pain points
   - Proposal of Dekel services
   - Calendar booking (via calendar_add tool)

**Gaps:**
1. **No follow-up scheduling** — single message flow only
2. **No conversation summarization** — doesn't update `last_call_summary` in leads table
3. **No sentiment analysis** — doesn't track `last_call_sentiment`
4. **No reminder system** — no cron job to remind about follow-ups

#### 2B. Enhancements
**Priority 1 (Essential for MVP):**
1. Add conversation summarization after each exchange
   - Use Claude to summarize the conversation
   - Store in `leads.last_call_summary`
   - Include topics, objections, next steps

2. Add sentiment tracking
   - Analyze agent's perception of lead engagement
   - Store in `leads.last_call_sentiment` (hot/warm/cold)

**Priority 2 (Future):**
1. Schedule follow-up messages via `scheduled_messages` table
   - Set `send_at` based on lead engagement level
   - Implement cron job to send pending messages

2. Implement workflow automation via `workflows` table
   - Trigger follow-up based on keywords (e.g., "interested" → schedule 24h follow-up)
   - Track engagement stages (initial_contact → qualified → proposal → negotiation)

#### 2C. Implementation
**Conversation Summarization:**
After agent responds (in agent/agent.ts):
```typescript
async function summarizeConversationIfLead(ctx) {
  if (!ctx.isLeadConversation) return;
  
  const messages = db.prepare(`
    SELECT sender_name, content, role FROM messages
    WHERE channel = ? AND sender_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(ctx.channel, ctx.senderId);
  
  const summary = await claudeAPI.call({
    messages: [...messages, {
      role: 'user',
      content: 'Summarize this sales conversation: topics discussed, objections raised, next steps, lead sentiment (hot/warm/cold)'
    }]
  });
  
  db.prepare(`
    UPDATE leads SET last_call_summary = ?, last_call_sentiment = ?, updated_at = datetime('now')
    WHERE phone = ?
  `).run(summary.topics, summary.sentiment, ctx.senderId);
}
```

---

### Phase 3: Book 15-Min Zoom on Google Calendar

#### 3A. Verification Needed
**Before Implementation:**
1. Verify that `GOOGLE_CALENDAR_SCRIPT_URL` backend supports specific email parameter
2. Determine if calendar_add tool can specify event organizer (alon12@gmail.com)

**Research:**
```typescript
// Test if backend accepts calendar parameter
const testRes = await fetch(`${config.googleCalendarScriptUrl}?action=list&calendar=alon12@gmail.com`, ...);
// OR
const testRes = await fetch(config.googleCalendarScriptUrl, {
  method: 'POST',
  body: JSON.stringify({
    action: 'add',
    calendar: 'alon12@gmail.com',  // explicit calendar email
    title: 'Test Meeting'
  })
});
```

**Assumption (if not supported):** We'll need to implement a separate endpoint or modify the existing script to accept calendar parameter.

#### 3B. Calendar Booking Workflow

**Trigger:** When agent/lead conversation reaches booking stage (detected via system prompt)

**Current Tool:** `calendar_add` (calendar.ts lines 50-90)
- Takes: title, date (YYYY-MM-DD), time (HH:mm), duration_minutes, description
- Returns: success message with event details

**Enhancement Needed:**
1. Add `calendar` parameter to calendar_add tool to specify alon12@gmail.com
2. Add `generate_zoom_link` flag to create Zoom meeting (if backend supports)

**Updated calendar_add Tool (proposed):**
```typescript
{
  name: 'calendar_add',
  definition: {
    // ... existing ...
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:mm 24h format' },
        duration_minutes: { type: 'number', description: 'Duration in minutes (default 60)' },
        description: { type: 'string' },
        calendar: { type: 'string', description: 'Calendar email (default: user calendar)' },
        create_zoom_link: { type: 'boolean', description: 'Add Zoom meeting link' },
      },
      required: ['title', 'date'],
    },
  },
  async execute(input, ctx) {
    // ... existing code ...
    body: JSON.stringify({
      action: 'add',
      title: input.title,
      date: input.date,
      time: input.time || null,
      duration_minutes: input.duration_minutes || 15,  // Default to 15 for Zoom
      description: input.description || '',
      calendar: input.calendar || 'alon12@gmail.com',  // NEW
      create_zoom_link: input.create_zoom_link || true, // NEW
    }),
  }
}
```

**System Prompt Integration:**
Add to `buildLeadSalesPrompt()` (system-prompt.ts lines 87-93):
```
If lead is ready to book:
- Use calendar_add with:
  - title: "Discovery Call — Dekel"
  - duration_minutes: 15
  - calendar: "alon12@gmail.com"
  - create_zoom_link: true
- Extract eventId from response and store in context
- Confirm booking with lead: "בחרנו לך את [date/time] לשיחה. היא תהיה דרך Zoom"
```

**Booking Confirmation:**
After successful calendar_add:
```typescript
// Update lead record
db.prepare(`
  UPDATE leads SET was_booked = 1, updated_at = datetime('now')
  WHERE phone = ?
`).run(ctx.senderId);

// Optionally update Monday.com item
await createTaskInMonday({
  itemId: lead.monday_item_id,
  title: 'Scheduled: Discovery Call',
  status: 'booked'
});
```

#### 3C. Calendar Sync Back to Monday.com
After booking, update Monday.com item with event link:
```typescript
// After calendar_add succeeds with eventId
const updateMutation = `
  mutation {
    update_item_column_value(
      item_id: ${lead.monday_item_id},
      board_id: 1443363020,
      column_id: "calendar_event_id",
      value: "${eventId}"
    ) {
      id
    }
  }
`;
```

---

## Integration Sequence

### Workflow Execution Order (MVP)

```
1. New WhatsApp message arrives (any contact)
   ↓
2. WhatsApp adapter security check
   ↓
3. If NEW contact (not in leads, not in allowedWhatsApp):
   → Create lead in Monday.com (Phase 1A)
   → Insert in local leads table with source='whatsapp_contact'
   ↓
4. Route message to agent with lead context
   ↓
5. Agent uses sales prompt (buildLeadSalesPrompt)
   ↓
6. Sales conversation flow:
   - Qualify interest
   - Describe services
   - Propose booking
   ↓
7. If lead agrees to booking:
   → calendar_add with alon12@gmail.com, 15 min, Zoom (Phase 3B)
   → Update leads.was_booked = 1
   → Update Monday.com item with eventId
   ↓
8. [Future] Schedule follow-up message via cron (Phase 2B Priority 2)
```

---

## Dependencies & Blockers

### Blocker: GOOGLE_CALENDAR_SCRIPT_URL Backend
**Status:** Unknown if alon12@gmail.com calendar is supported

**Resolution:**
1. Check env var value: `echo $GOOGLE_CALENDAR_SCRIPT_URL`
2. Test with curl:
   ```bash
   curl -X POST "$GOOGLE_CALENDAR_SCRIPT_URL" \
     -H "Content-Type: application/json" \
     -d '{"action":"add","title":"Test","date":"2026-03-24","calendar":"alon12@gmail.com"}'
   ```
3. If returns error → modify backend script or use alternative calendar service

### Dependency: MONDAY_API_KEY
**Status:** Already required, should be set in env

**Validation:**
```bash
echo $MONDAY_API_KEY  # Should output key (not error)
```

### Dependency: Board Column IDs
**Status:** Need to fetch exact column_ids for leads board (1443363020)

**Query:**
```graphql
query {
  board(id: 1443363020) {
    columns {
      id
      title
      type
    }
  }
}
```

---

## Testing Strategy

### Unit Tests (Phase 1)
```typescript
// Test 1: New contact detection
const newContact = { phone: '972999999999', pushName: 'Test User' };
const created = await createLeadInMonday(newContact.phone, newContact.pushName);
assert(created); // Should return monday_item_id

// Test 2: Duplicate prevention
const duplicate = await createLeadInMonday(newContact.phone, newContact.pushName);
assert(duplicate === created); // Should return existing ID
```

### Integration Tests (Phase 2-3)
```typescript
// Test: Full workflow
1. Send WhatsApp message from new number
2. Verify lead created in Monday.com
3. Check leads table for entry
4. Verify agent uses sales prompt
5. Simulate booking request
6. Verify calendar event created with alon12@gmail.com
7. Verify leads.was_booked = 1
```

### Manual Testing (Phase 3)
1. Set up test WhatsApp number (non-Alon)
2. Send message to AlonBot
3. Monitor logs for lead creation
4. Check Monday.com board for new item
5. Complete sales conversation
6. Book calendar slot
7. Verify event appears in alon12@gmail.com calendar

---

## Rollout Plan

### Week 1: Phase 1 (Auto-Create Lead)
- [ ] Verify Monday.com board column IDs
- [ ] Implement createLeadInMonday() function
- [ ] Integrate into WhatsApp adapter
- [ ] Test with non-Alon contact
- [ ] Verify Monday.com board updates

### Week 2: Phase 2 (Sales Follow-Up)
- [ ] Add conversation summarization
- [ ] Add sentiment tracking
- [ ] Test sales flow end-to-end
- [ ] Collect feedback from Alon

### Week 3: Phase 3 (Calendar Booking)
- [ ] Verify GOOGLE_CALENDAR_SCRIPT_URL backend
- [ ] Implement alon12@gmail.com calendar support
- [ ] Update calendar_add tool
- [ ] Test 15-min booking flow
- [ ] Verify Zoom link generation (if supported)

### Week 4: QA & Refinement
- [ ] Full workflow testing
- [ ] Error handling edge cases
- [ ] Performance monitoring
- [ ] Alon sign-off

---

## File Modifications Summary

### New/Modified Files
1. `src/channels/whatsapp.ts` — Add createLeadInMonday() + integration
2. `src/tools/handlers/calendar.ts` — Add calendar parameter + zoom_link support
3. `src/agent/system-prompt.ts` — Add lead sentiment/summary tracking (optional)
4. `.env` — Ensure MONDAY_API_KEY, GOOGLE_CALENDAR_SCRIPT_URL are set

### No Changes Needed
- `src/utils/db.ts` — Schema already supports monday_item_id
- `src/tools/handlers/monday.ts` — Generic GraphQL executor ready
- `src/agent/agent.ts` — Already handles lead context routing

---

## Success Criteria

✓ **Phase 1:** New WhatsApp contact → Monday.com item created automatically within 5 seconds
✓ **Phase 2:** Sales conversation flows naturally with context from lead record
✓ **Phase 3:** Lead can book 15-min Zoom on alon12@gmail.com calendar during conversation

