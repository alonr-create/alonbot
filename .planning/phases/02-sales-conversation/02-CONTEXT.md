# Phase 2: Sales Conversation - Context

**Gathered:** 2026-03-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Monday.com webhook integration to detect new leads, Claude API-powered Hebrew sales conversations with full Alon.dev service knowledge, conversation persistence in SQLite, multi-message batching, dynamic price quotes with min/max guardrails, and lead status sync back to Monday.com. This phase transforms the bot from a test responder into an active AI salesperson.

</domain>

<decisions>
## Implementation Decisions

### Monday.com Webhook
- Webhook endpoint at POST /webhook/monday receives new lead notifications
- Extract: lead name, phone number, service interest, Monday.com item ID
- Store monday_item_id on leads table for bidirectional sync
- Monday.com board: the existing Alon.dev leads board (leads come from alon-dev.vercel.app contact form)
- Webhook challenge verification (Monday.com sends challenge on setup)
- Update Monday.com status column via API when conversation progresses

### AI Conversation Engine
- Claude API (claude-sonnet-4-20250514) for Hebrew sales conversations — fast, cost-effective, excellent Hebrew
- System prompt contains full Alon.dev service catalog with pricing ranges:
  - אתרים (Landing pages: ₪2,000-5,000, Business sites: ₪5,000-15,000, E-commerce: ₪10,000-30,000)
  - אפליקציות (Mobile apps: ₪15,000-50,000, Web apps: ₪10,000-40,000)
  - משחקים (Browser games: ₪5,000-20,000, Mobile games: ₪20,000-60,000)
  - אוטומציה ו-CRM (Automation flows: ₪3,000-10,000, CRM setup: ₪5,000-15,000)
  - שיווק דיגיטלי (Social media: ₪2,000-5,000/month, SEO: ₪3,000-8,000/month)
- Bot personality: aggressive sales, pushy but not rude, creates urgency, uses emojis strategically
- Hebrew-first, informal/friendly but business-oriented tone
- Conversation context: last 20 messages sent to Claude for context continuity
- Bot introduces itself on first contact referencing the lead's stated interest from Monday.com

### Multi-Message Batching
- When multiple messages arrive in quick succession, wait 8 seconds after last message
- Then respond to the entire batch as one coherent reply
- Use a debounce timer per conversation (phone number)
- If only one message after 8 seconds, respond to that single message

### Price Quotes
- Claude generates quotes within the defined min/max ranges per service
- System prompt enforces guardrails — Claude cannot quote below minimum or above maximum
- Quotes presented as ranges when scope is unclear ("בין ₪5,000 ל-₪15,000 תלוי בהיקף")
- When lead shows interest in specific scope, narrow to more precise quote
- Status updates to 'quote-sent' in Monday.com when a price is mentioned

### Lead Status Sync
- Status progression: new → contacted → in-conversation → quote-sent
- Update Monday.com via API when status changes
- Store monday_item_id and monday_board_id in leads table
- Status column name in Monday.com: configurable via env var (MONDAY_STATUS_COLUMN_ID)

### Claude's Discretion
- Exact system prompt wording and conversation strategy
- How to handle non-Hebrew messages (respond in detected language or stick to Hebrew)
- Claude API parameters (temperature, max_tokens)
- Conversation summary format for internal logging
- How to handle media messages (photos, voice notes) — acknowledge but explain text-only for now

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/whatsapp/message-handler.ts` — Current test responder, will be replaced with AI conversation router
- `src/whatsapp/rate-limiter.ts` — `sendWithTyping()` already handles rate limiting and typing simulation
- `src/db/schema.ts` — leads and messages tables exist, need schema migration for monday_item_id
- `src/http/server.ts` — Express v5 server ready to mount webhook route
- `src/config.ts` — Environment variable loading pattern established

### Established Patterns
- TypeScript ESM with `.js` import extensions
- pino structured logging with `createLogger(module)`
- Express v5 router pattern (see health.ts, qr.ts)
- better-sqlite3 with WAL mode
- Notifications module for alerts to Alon

### Integration Points
- Message handler: replace TEST_RESPONSE with Claude AI conversation
- Express server: mount Monday.com webhook route at `/webhook/monday`
- Database: add monday_item_id column to leads, possibly add conversation_context table
- Config: add ANTHROPIC_API_KEY, MONDAY_API_TOKEN, MONDAY_BOARD_ID, MONDAY_STATUS_COLUMN_ID

</code_context>

<specifics>
## Specific Ideas

- Bot should reference the lead's specific interest from the Monday.com form (e.g., "ראיתי שאתה מעוניין באתר לעסק — מעולה!")
- Price ranges are Alon's actual pricing — not placeholder values
- Multi-message batching is critical for Hebrew speakers who tend to send multiple short messages in quick succession
- Monday.com MCP server is available for API interaction during development

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-sales-conversation*
*Context gathered: 2026-03-09*
