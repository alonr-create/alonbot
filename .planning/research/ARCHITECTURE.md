# Architecture Patterns

**Domain:** WhatsApp Sales Bot (AI-driven lead engagement)
**Researched:** 2026-03-09

## Recommended Architecture

Event-driven pipeline with 6 distinct components. Each component has a single responsibility and communicates through well-defined interfaces. The system is a **standalone Node.js service** -- not a module inside AlonBot -- but borrows proven patterns from AlonBot's adapter/router/agent architecture.

```
Monday.com Webhook
       |
       v
+------------------+     +-------------------+     +------------------+
|  Webhook Server  |---->| Lead State Machine |---->| WhatsApp Channel |
|  (Express)       |     | (Orchestrator)     |     | (Baileys)        |
+------------------+     +-------------------+     +------------------+
       ^                    |           ^                  |
       |                    v           |                  v
+------------------+  +-----------+  +------------------+  Lead's
| Monday.com API   |  | AI Engine |  | Follow-up        |  WhatsApp
| (status updates) |  | (Claude)  |  | Scheduler (cron) |
+------------------+  +-----------+  +------------------+
                          |
                    +-------------+
                    | Google Cal  |
                    | (API/Script)|
                    +-------------+
```

### Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|---------------|-------------------|
| **Webhook Server** | Receives Monday.com webhooks, health checks, admin endpoints | Lead Orchestrator, Monday.com API |
| **WhatsApp Channel** | Baileys connection, session persistence, send/receive messages | Lead Orchestrator (inbound messages), Follow-up Scheduler (outbound) |
| **Lead Orchestrator** | State machine per lead, decides what happens next, routes to AI or escalation | All other components -- this is the brain |
| **AI Engine** | Claude API conversations with sales context, generates quotes, extracts intents | Lead Orchestrator (called as a service) |
| **Follow-up Scheduler** | Cron-based check for leads needing follow-up (day 1, day 3, day 7) | Lead Orchestrator, WhatsApp Channel, Database |
| **Calendar Service** | Check availability, book meetings via Google Calendar Apps Script | AI Engine (as a tool), Lead Orchestrator |

### Why Standalone (Not Inside AlonBot)

AlonBot is Alon's personal assistant -- it runs on Alon's WhatsApp number and processes messages from Alon. The sales bot is a **different actor**: it sends messages TO leads FROM a business number. Mixing these creates confusion about identity, session management, and message routing. Keep them separate. They can share a Monday.com board and Google Calendar, but the processes are independent.

## Data Flow

### Flow 1: New Lead Arrives

```
1. Lead fills form on alon-dev.vercel.app
2. Form submits to Monday.com board (existing flow)
3. Monday.com fires webhook to bot's /webhook/monday endpoint
4. Webhook Server validates signature, extracts lead data (name, phone, interest)
5. Lead Orchestrator creates lead record in DB with state = "new"
6. Lead Orchestrator calls AI Engine: "Generate first message for [name] interested in [service]"
7. AI Engine returns personalized Hebrew greeting
8. WhatsApp Channel sends message to lead's phone number
9. Lead Orchestrator updates state to "contacted", updates Monday.com status
```

### Flow 2: Lead Replies

```
1. Lead sends WhatsApp message
2. Baileys receives message, WhatsApp Channel normalizes it
3. WhatsApp Channel passes to Lead Orchestrator with lead context
4. Lead Orchestrator loads conversation history + lead state
5. Lead Orchestrator calls AI Engine with full context
6. AI Engine processes with Claude (may invoke tools: calendar check, quote generation)
7. Response sent back via WhatsApp Channel
8. Lead Orchestrator updates state (e.g., "in_conversation" -> "quote_sent")
9. Monday.com status updated via API
```

### Flow 3: Follow-up (No Response)

```
1. Cron runs every hour, checks for leads where:
   - State is "contacted" or "in_conversation"
   - Last message was sent by bot (not lead)
   - Enough time has passed (1 day / 3 days / 7 days)
2. Follow-up Scheduler triggers Lead Orchestrator
3. AI Engine generates contextual follow-up (not generic -- references previous conversation)
4. WhatsApp Channel sends follow-up
5. After 3rd follow-up with no response: state -> "unresponsive", notify Alon
```

### Flow 4: Meeting Booking

```
1. During conversation, lead expresses interest in a meeting
2. AI Engine detects intent, calls calendar_check tool
3. Calendar Service returns available slots (next 5 business days)
4. AI Engine presents 3 slot options in Hebrew
5. Lead picks one
6. AI Engine calls calendar_add tool
7. Calendar Service creates event with lead's name and context
8. Confirmation sent to lead via WhatsApp
9. State -> "meeting_scheduled", Monday.com updated
```

## Lead State Machine

This is the core architectural decision. Every lead has exactly one state, and transitions are explicit.

```
                 webhook
                    |
                    v
               +--------+
               |  new   |
               +--------+
                    |
          first message sent
                    |
                    v
             +-----------+
             | contacted |<------ follow-up sent (still no reply)
             +-----------+
                    |
              lead replies
                    |
                    v
          +-----------------+
          | in_conversation |<---+
          +-----------------+    |
            |    |    |          |
            |    |    +----------+  (continued conversation)
            |    |
            |    +---> quote_sent -----> meeting_scheduled
            |                                   |
            |                                   v
            |                               +-------+
            +-----> escalated               | won   |
            |       (human requested        +-------+
            |        or complex case)
            |
            v
       +-------------+
       | unresponsive |
       +-------------+
       (after 3 follow-ups)
```

**States:**

| State | Meaning | Next Actions |
|-------|---------|-------------|
| `new` | Just entered from Monday.com | Send first message |
| `contacted` | First message sent, awaiting reply | Follow-up schedule starts |
| `in_conversation` | Active back-and-forth | AI handles, may quote or book |
| `quote_sent` | Price quote delivered | Wait for response, follow up |
| `meeting_scheduled` | Discovery call booked | Done (or re-engage if cancelled) |
| `escalated` | Handed to Alon | Notify via Telegram, stop automation |
| `unresponsive` | 3 follow-ups, no reply | Archive, maybe re-engage in 30 days |
| `won` | Deal closed or meeting happened | Archive |

## Database Schema (SQLite)

```sql
-- Core lead tracking
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,        -- WhatsApp number (972XXXXXXXXX)
  name TEXT NOT NULL,
  interest TEXT,                      -- "website", "app", "automation", etc.
  source TEXT DEFAULT 'monday',       -- where lead came from
  monday_item_id TEXT,                -- Monday.com item ID for status sync
  state TEXT NOT NULL DEFAULT 'new',
  follow_up_count INTEGER DEFAULT 0,
  last_bot_message_at TEXT,           -- for follow-up timing
  last_lead_message_at TEXT,          -- to detect responsiveness
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Conversation history (per lead)
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  role TEXT NOT NULL CHECK(role IN ('bot', 'lead', 'system')),
  content TEXT NOT NULL,
  metadata TEXT,                      -- JSON: {intent, quote_amount, etc.}
  created_at TEXT DEFAULT (datetime('now'))
);

-- Follow-up schedule
CREATE TABLE follow_ups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  scheduled_at TEXT NOT NULL,
  sent INTEGER DEFAULT 0,
  message_type TEXT NOT NULL,         -- 'day1', 'day3', 'day7'
  created_at TEXT DEFAULT (datetime('now'))
);

-- WhatsApp session (Baileys auth state stored on filesystem, not DB)
-- Quote tracking
CREATE TABLE quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  service_type TEXT NOT NULL,
  description TEXT NOT NULL,
  price_range TEXT NOT NULL,          -- "3,000-5,000 NIS" or exact
  sent_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_leads_state ON leads(state);
CREATE INDEX idx_leads_phone ON leads(phone);
CREATE INDEX idx_conversations_lead ON conversations(lead_id, created_at);
CREATE INDEX idx_follow_ups_pending ON follow_ups(sent, scheduled_at);
```

## Project Structure

```
src/
  index.ts                    -- Bootstrap: start server, connect WhatsApp, start scheduler
  config.ts                   -- Environment variables, constants

  server/
    webhook.ts                -- Express routes: /webhook/monday, /health
    middleware.ts             -- Monday.com signature verification

  whatsapp/
    connection.ts             -- Baileys setup, session persistence, reconnect logic
    sender.ts                 -- Send message, send typing, rate limiting
    receiver.ts               -- Incoming message handler, normalize to internal format

  orchestrator/
    state-machine.ts          -- Lead state transitions, validation
    router.ts                 -- Incoming message -> decide action -> execute
    follow-up.ts              -- Schedule and execute follow-up series

  ai/
    engine.ts                 -- Claude API wrapper, conversation management
    system-prompt.ts          -- Sales bot persona, service knowledge, pricing
    tools.ts                  -- Tool definitions (calendar, quote generation)
    intents.ts                -- Extract intent from lead messages

  integrations/
    monday.ts                 -- Monday.com API: read leads, update statuses
    calendar.ts               -- Google Calendar: check slots, book meetings

  db/
    database.ts               -- SQLite setup, better-sqlite3
    migrations/               -- Schema versioning

  utils/
    logger.ts                 -- Pino logger
    retry.ts                  -- Retry with backoff (reuse AlonBot pattern)

data/
  whatsapp-session/           -- Baileys auth state (persisted volume)
  salesbot.db                 -- SQLite database
```

## Patterns to Follow

### Pattern 1: Lead-Scoped Conversation Context

Every AI call includes the full lead context, not just message history. This is critical for a sales bot -- the AI needs to know what service they want, what quotes were sent, what follow-up stage they are in.

```typescript
interface LeadContext {
  lead: Lead;
  conversationHistory: ConversationMessage[];
  quotesGiven: Quote[];
  meetingsScheduled: CalendarEvent[];
  followUpStage: number; // 0, 1, 2, 3
}

async function buildMessages(ctx: LeadContext): Promise<ClaudeMessage[]> {
  // System prompt includes service catalog + pricing guidelines
  // Conversation history is the message array
  // Lead metadata is injected as a system message prefix
  const leadInfo = `
    Lead: ${ctx.lead.name}
    Interest: ${ctx.lead.interest}
    State: ${ctx.lead.state}
    Previous quotes: ${ctx.quotesGiven.map(q => q.description).join(', ') || 'none'}
    Follow-up stage: ${ctx.followUpStage}/3
  `;
  // ... build Claude messages array
}
```

### Pattern 2: Outbound-First Message Queue

Unlike AlonBot (which responds to incoming messages), this bot initiates conversations. All outbound messages go through a queue with rate limiting to avoid WhatsApp anti-spam detection.

```typescript
class MessageQueue {
  private queue: OutboundMessage[] = [];
  private processing = false;

  async enqueue(phone: string, text: string, priority: number = 5) {
    this.queue.push({ phone, text, priority, createdAt: Date.now() });
    this.queue.sort((a, b) => a.priority - b.priority);
    this.process();
  }

  private async process() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const msg = this.queue.shift()!;
      await this.send(msg);
      // Anti-spam: random delay 3-8 seconds between messages
      await sleep(3000 + Math.random() * 5000);
    }
    this.processing = false;
  }
}
```

### Pattern 3: Monday.com Webhook with Idempotency

Monday.com webhooks can fire multiple times for the same event. Use idempotency keys to prevent duplicate lead processing.

```typescript
const processedEvents = new Set<string>();

app.post('/webhook/monday', async (req, res) => {
  // Monday.com sends a challenge on first setup
  if (req.body.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  const eventId = req.body.event?.pulseId + '-' + req.body.event?.columnId;
  if (processedEvents.has(eventId)) {
    return res.status(200).send('already processed');
  }
  processedEvents.add(eventId);

  // Clean old entries periodically
  if (processedEvents.size > 1000) {
    processedEvents.clear();
  }

  // Process the event...
  res.status(200).send('ok');
});
```

### Pattern 4: Graceful Baileys Reconnection

Baileys connections drop. The bot must reconnect without losing state or sending duplicate messages. Borrow AlonBot's pattern but add message deduplication.

```typescript
const processedMessageIds = new Set<string>();

sock.ev.on('messages.upsert', ({ messages, type }) => {
  if (type !== 'notify') return;
  for (const msg of messages) {
    if (msg.key.fromMe || !msg.message) continue;
    // Deduplicate (Baileys can replay messages on reconnect)
    if (processedMessageIds.has(msg.key.id!)) continue;
    processedMessageIds.add(msg.key.id!);
    // Process...
  }
});
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Sharing AlonBot's Baileys Session
**What:** Using the same WhatsApp number/session for both AlonBot and the sales bot.
**Why bad:** Two processes fighting over one WebSocket connection. Baileys does not support multiple consumers. One will get disconnected.
**Instead:** Use a separate WhatsApp number for the sales bot with its own Baileys session.

### Anti-Pattern 2: Stateless AI Conversations
**What:** Sending only the last few messages to Claude without lead context.
**Why bad:** The AI cannot generate relevant quotes, remember what service the lead wants, or maintain a coherent sales flow.
**Instead:** Always include full lead metadata (state, interest, quotes, follow-up stage) in every AI call.

### Anti-Pattern 3: Synchronous Monday.com Updates
**What:** Waiting for Monday.com API responses in the message handling pipeline.
**Why bad:** Monday.com API can be slow (500ms-2s). This blocks the WhatsApp response.
**Instead:** Fire-and-forget Monday.com updates. Queue them. If they fail, retry in background.

### Anti-Pattern 4: Hard-coded Follow-up Messages
**What:** Pre-written follow-up templates like "Hey, just checking in!"
**Why bad:** Feels robotic. Leads detect it instantly. The whole point of using AI is personalization.
**Instead:** Generate follow-ups with Claude, passing the full conversation history. The AI writes contextual follow-ups that reference the actual discussion.

### Anti-Pattern 5: Processing All Incoming WhatsApp Messages
**What:** Handling every message that arrives on the WhatsApp number, like AlonBot does.
**Why bad:** The sales bot should ONLY respond to known leads. Random messages, group chats, or spam should be ignored.
**Instead:** Maintain a leads table. Only process messages from phone numbers in the leads table. Unknown numbers get a polite "I don't recognize this number" or are silently ignored.

## Scalability Considerations

| Concern | At 10 leads/week | At 100 leads/week | At 1000 leads/week |
|---------|-------------------|--------------------|--------------------|
| WhatsApp rate limiting | No issue, 3-8s delay sufficient | May need longer delays, stagger by hour | Baileys won't scale -- need WhatsApp Business API |
| SQLite | Perfect | Still fine | Consider PostgreSQL |
| Claude API costs | ~$5/month | ~$50/month | ~$500/month, consider Gemini for follow-ups |
| Single process | Fine | Fine | Need queue system (BullMQ) |
| Baileys stability | Occasional reconnects | Need health monitoring | Unreliable at scale, consider official API |

**Realistic scale for Alon.dev:** 10-30 leads/week. SQLite + Baileys + single process is the right call. Do not over-engineer.

## Suggested Build Order

Based on component dependencies:

1. **Database + Config** (no dependencies) -- Foundation everything builds on
2. **WhatsApp Channel** (depends on: config) -- Baileys connection, send/receive. Test manually.
3. **AI Engine** (depends on: config) -- Claude API with sales system prompt. Test in isolation.
4. **Lead Orchestrator + State Machine** (depends on: DB, WhatsApp, AI) -- Wires everything together
5. **Webhook Server + Monday.com Integration** (depends on: Orchestrator) -- Triggers from CRM
6. **Follow-up Scheduler** (depends on: Orchestrator, WhatsApp) -- Cron-based follow-ups
7. **Calendar Integration** (depends on: AI Engine) -- Add as AI tool
8. **Quote Generation** (depends on: AI Engine) -- Add as AI capability in system prompt
9. **Alon Notification** (depends on: Orchestrator) -- Telegram alert on escalation

**Phase grouping recommendation:**
- Phase 1 (Foundation): items 1-3 -- can work independently, test each in isolation
- Phase 2 (Core Loop): item 4 -- the integration point, needs all three foundations
- Phase 3 (CRM Integration): item 5 -- connects to Monday.com
- Phase 4 (Automation): items 6-8 -- follow-ups, calendar, quotes
- Phase 5 (Polish): item 9 + monitoring, error handling, deploy to Railway

## Sources

- AlonBot codebase (`/Users/oakhome/קלוד עבודות/alonbot/src/`) -- proven Baileys + Claude + Monday.com patterns
- AlonBot WhatsApp adapter -- Baileys connection, session persistence, message normalization
- AlonBot gateway router -- adapter registration, message routing, streaming pattern
- AlonBot agent -- Claude API tool loop, conversation history, rate limiting
- AlonBot calendar tool -- Google Calendar via Apps Script (reusable pattern)
- AlonBot Monday.com tool -- GraphQL API wrapper (reusable pattern)
- AlonBot schedule-message handler -- DB-driven scheduled message pattern
- Confidence: HIGH for Baileys/Claude/Monday.com patterns (proven in production AlonBot). MEDIUM for state machine design (standard pattern but untested in this specific context). LOW for WhatsApp anti-spam thresholds (no official documentation, community-reported values).
