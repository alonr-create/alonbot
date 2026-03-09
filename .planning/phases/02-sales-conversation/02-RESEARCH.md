# Phase 2: Sales Conversation - Research

**Researched:** 2026-03-09
**Domain:** Monday.com webhook integration, Claude API conversational AI, message batching, SQLite persistence
**Confidence:** HIGH

## Summary

Phase 2 transforms the bot from a static test responder into an AI-powered sales agent. It requires three new integrations: (1) Monday.com webhooks to detect new leads, (2) the Anthropic SDK to power Claude-based Hebrew sales conversations, and (3) a per-conversation debounce mechanism for multi-message batching. The existing codebase provides solid foundation -- Express v5 server ready for new routes, better-sqlite3 database with leads/messages tables, and `sendWithTyping()` for rate-limited outbound messages.

A critical discovery: Monday.com's `create_item` webhook delivers **empty `columnValues`**. The webhook only provides `boardId`, `pulseId`, and `pulseName`. To get the lead's phone number and service interest, a follow-up GraphQL query to `https://api.monday.com/v2` is mandatory after receiving each webhook event.

**Primary recommendation:** Use `@anthropic-ai/sdk` for Claude API integration with `claude-sonnet-4-20250514` model, implement a `Map<string, NodeJS.Timeout>` debounce per phone number with 8-second window, and always fetch full item data from Monday.com after webhook events.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions
- Monday.com webhook endpoint at POST /webhook/monday receives new lead notifications
- Extract: lead name, phone number, service interest, Monday.com item ID
- Store monday_item_id on leads table for bidirectional sync
- Monday.com board: the existing Alon.dev leads board (leads come from alon-dev.vercel.app contact form)
- Webhook challenge verification (Monday.com sends challenge on setup)
- Update Monday.com status column via API when conversation progresses
- Claude API (claude-sonnet-4-20250514) for Hebrew sales conversations
- System prompt contains full Alon.dev service catalog with exact pricing ranges (defined in CONTEXT.md)
- Bot personality: aggressive sales, pushy but not rude, creates urgency, uses emojis strategically
- Hebrew-first, informal/friendly but business-oriented tone
- Conversation context: last 20 messages sent to Claude for context continuity
- Bot introduces itself on first contact referencing the lead's stated interest from Monday.com
- Multi-message batching: wait 8 seconds after last message, respond to entire batch
- Use a debounce timer per conversation (phone number)
- Price quotes within defined min/max ranges per service (exact ranges in CONTEXT.md)
- Status progression: new -> contacted -> in-conversation -> quote-sent
- Status column name configurable via env var (MONDAY_STATUS_COLUMN_ID)
- Store monday_item_id and monday_board_id in leads table

### Claude's Discretion
- Exact system prompt wording and conversation strategy
- How to handle non-Hebrew messages (respond in detected language or stick to Hebrew)
- Claude API parameters (temperature, max_tokens)
- Conversation summary format for internal logging
- How to handle media messages (photos, voice notes) -- acknowledge but explain text-only for now

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MON-01 | Webhook endpoint receives new lead notifications from Monday.com | Monday.com webhook challenge verification + create_item event documented; endpoint at POST /webhook/monday |
| MON-02 | Bot extracts lead name, phone number, and service interest from webhook payload | CRITICAL: create_item webhook has EMPTY columnValues -- must follow up with GraphQL query using pulseId to fetch item columns |
| MON-03 | Bot updates lead status column in Monday.com | change_simple_column_value mutation via GraphQL API at https://api.monday.com/v2 with status label |
| AI-01 | Claude API powers Hebrew-first sales conversations | @anthropic-ai/sdk with claude-sonnet-4-20250514, system prompt with service catalog |
| AI-02 | System prompt contains full Alon.dev service catalog | System prompt format documented -- string or TextBlockParam array; pricing ranges locked in CONTEXT.md |
| AI-03 | Conversation context persists in SQLite -- bot remembers prior messages | Existing messages table stores all messages; query last 20 by phone to build conversation history |
| AI-04 | Multi-message batching: wait 8 seconds after last message, respond to batch | Per-key debounce using Map<string, NodeJS.Timeout> with clearTimeout/setTimeout pattern |
| AI-05 | Bot generates dynamic price quotes with guardrails (min/max per service) | System prompt enforces ranges; Claude cannot quote outside defined bounds |

</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @anthropic-ai/sdk | latest (^0.61+) | Claude API client for TypeScript | Official Anthropic SDK, full TypeScript types, system prompt support |
| express | ^5.2.1 | HTTP server (already installed) | Already in project, mount webhook route |
| better-sqlite3 | ^12.6.2 | SQLite database (already installed) | Already in project, schema migration for monday columns |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node built-in fetch | native | Monday.com GraphQL API calls | No additional HTTP client needed -- Node 20+ has global fetch |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @anthropic-ai/sdk | Raw fetch to API | SDK provides types, error handling, retries -- no reason to go raw |
| node fetch | axios | Unnecessary dependency -- native fetch handles GraphQL POST fine |
| monday-sdk-js | Raw GraphQL | SDK is for monday apps (OAuth flow), not simple API token auth. Raw GraphQL is simpler for our use case |

**Installation:**
```bash
npm install @anthropic-ai/sdk
```

Only one new dependency needed. Everything else is already installed or native.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── ai/
│   ├── claude-client.ts       # Anthropic SDK wrapper, messages.create calls
│   ├── system-prompt.ts       # Full Alon.dev service catalog prompt
│   └── conversation.ts        # Build message history from DB, call Claude, store response
├── monday/
│   ├── webhook-handler.ts     # POST /webhook/monday route, challenge verification
│   ├── api.ts                 # GraphQL queries/mutations (fetch item, update status)
│   └── types.ts               # Monday webhook payload types
├── whatsapp/
│   ├── message-handler.ts     # MODIFIED: route to AI conversation instead of TEST_RESPONSE
│   ├── message-batcher.ts     # Per-phone debounce logic (8-second window)
│   └── rate-limiter.ts        # Existing -- unchanged
├── db/
│   ├── schema.ts              # MODIFIED: add monday_item_id, monday_board_id columns
│   └── index.ts               # Existing -- unchanged
└── config.ts                  # MODIFIED: add ANTHROPIC_API_KEY, MONDAY_* env vars
```

### Pattern 1: Monday.com Webhook Challenge Verification
**What:** Monday.com sends a POST with `{ challenge: "token" }` when webhook is created. Endpoint must echo it back.
**When to use:** First request to webhook endpoint during setup.
**Example:**
```typescript
// Source: Monday.com developer docs
router.post('/webhook/monday', async (req, res) => {
  // Challenge verification
  if (req.body.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  // Normal webhook event
  const { event } = req.body;
  // event.type === 'create_pulse' for new items
  // event.pulseId = item ID
  // event.boardId = board ID
  // event.columnValues = {} (ALWAYS EMPTY for create_item!)

  // Must fetch item data via GraphQL
  const itemData = await fetchMondayItem(event.boardId, event.pulseId);
  // ... process lead

  res.status(200).json({ ok: true });
});
```

### Pattern 2: Monday.com GraphQL Fetch After Webhook
**What:** Webhook payload for create_item has empty columnValues. Must query API to get phone, name, interest.
**When to use:** Every time a create_item webhook fires.
**Example:**
```typescript
// Source: Monday.com developer docs
async function fetchMondayItem(boardId: number, itemId: number) {
  const query = `query {
    items(ids: [${itemId}]) {
      name
      column_values {
        id
        text
        value
      }
    }
  }`;

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.MONDAY_API_TOKEN!,
    },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  return data.data.items[0];
}
```

### Pattern 3: Per-Phone Debounce for Multi-Message Batching
**What:** Hebrew speakers send multiple short messages rapidly. Collect them all, wait 8 seconds after the last one, then respond to the batch.
**When to use:** Every incoming message triggers a debounce reset.
**Example:**
```typescript
// Per-conversation debounce timers
const pendingBatches = new Map<string, {
  timer: NodeJS.Timeout;
  messages: string[];
}>();

function addMessageToBatch(phone: string, text: string, onBatchReady: (phone: string, messages: string[]) => void) {
  const existing = pendingBatches.get(phone);

  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(text);
  } else {
    pendingBatches.set(phone, { timer: null as any, messages: [text] });
  }

  const batch = pendingBatches.get(phone)!;
  batch.timer = setTimeout(() => {
    pendingBatches.delete(phone);
    onBatchReady(phone, batch.messages);
  }, 8000); // 8 seconds after last message
}
```

### Pattern 4: Claude Conversation with History
**What:** Build messages array from DB, include system prompt with service catalog, call Claude.
**When to use:** Every time a batch is ready to process.
**Example:**
```typescript
// Source: Anthropic TypeScript SDK docs
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

async function generateResponse(phone: string, newMessages: string[]): Promise<string> {
  // Fetch last 20 messages from DB
  const history = db.prepare(
    'SELECT direction, content FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 20'
  ).all(phone).reverse();

  // Build Claude messages array
  const messages = history.map(m => ({
    role: m.direction === 'in' ? 'user' as const : 'assistant' as const,
    content: m.content,
  }));

  // Add new batch as single user message
  messages.push({ role: 'user', content: newMessages.join('\n') });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT, // Full Alon.dev service catalog
    messages,
  });

  // Extract text from response
  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock?.text || '';
}
```

### Pattern 5: Monday.com Status Update
**What:** Update lead status column via GraphQL mutation when conversation progresses.
**When to use:** After first message sent (contacted), after lead replies (in-conversation), after price mentioned (quote-sent).
**Example:**
```typescript
// Source: Monday.com developer docs
async function updateMondayStatus(itemId: number, boardId: number, status: string) {
  const columnId = process.env.MONDAY_STATUS_COLUMN_ID!;
  const query = `mutation {
    change_simple_column_value(
      item_id: ${itemId},
      board_id: ${boardId},
      column_id: "${columnId}",
      value: "${status}"
    ) {
      id
    }
  }`;

  await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': process.env.MONDAY_API_TOKEN!,
    },
    body: JSON.stringify({ query }),
  });
}
```

### Anti-Patterns to Avoid
- **Trusting webhook columnValues:** Monday.com create_item webhooks deliver EMPTY columnValues. Always fetch via GraphQL API.
- **Blocking webhook response:** Monday.com retries if no 200 within timeout. Respond 200 immediately, process asynchronously.
- **Sending Claude the entire conversation:** Limit to last 20 messages. Older conversations waste tokens and can confuse context.
- **Quoting outside price ranges:** System prompt must explicitly instruct Claude to never go below min or above max for any service category.
- **Forgetting to store monday_item_id:** Without it, you cannot update status back in Monday.com later.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Claude API integration | Raw HTTP calls to api.anthropic.com | @anthropic-ai/sdk | SDK handles auth, types, retries, streaming, error classes |
| Message debouncing | Complex event queue system | Simple Map + setTimeout/clearTimeout | Per-phone debounce is straightforward -- no library needed |
| Monday.com GraphQL | Custom GraphQL client | Native fetch with template literals | Only 2-3 queries needed, no complex query building |
| Conversation history | Custom context window manager | Simple SQL query with LIMIT 20 | Already have messages table with proper indexes |

**Key insight:** This phase needs exactly ONE new npm package (@anthropic-ai/sdk). Everything else is built with existing dependencies, native fetch, and standard patterns.

## Common Pitfalls

### Pitfall 1: Monday.com Webhook Empty columnValues
**What goes wrong:** Developer assumes create_item webhook includes all column data. It does not -- columnValues is always `{}`.
**Why it happens:** Monday.com webhook design sends minimal payload for create events.
**How to avoid:** Always make a follow-up GraphQL query using the `pulseId` from the webhook to fetch full item data.
**Warning signs:** Phone number and service interest are undefined/null after webhook processing.

### Pitfall 2: Monday.com Webhook Challenge Not Handled
**What goes wrong:** Webhook setup fails because endpoint doesn't echo the challenge token.
**Why it happens:** Monday.com sends a `{ challenge: "..." }` POST on first setup. If not echoed back, webhook creation fails.
**How to avoid:** Check for `req.body.challenge` before processing normal events. Return `{ challenge: req.body.challenge }` with 200 status.
**Warning signs:** Webhook shows as "failed" in Monday.com integrations panel.

### Pitfall 3: Race Condition Between Webhook and Lead-Initiated Message
**What goes wrong:** Lead fills out form, webhook fires, bot sends first message. But lead also messages first from WhatsApp. Now there are two conversation threads.
**Why it happens:** Time gap between form submission and webhook delivery.
**How to avoid:** Check if lead already exists in DB (by phone) before creating. If lead exists and has recent messages, skip the auto-intro and let the conversation continue naturally.
**Warning signs:** Lead receives duplicate greetings or conflicting conversation contexts.

### Pitfall 4: Monday.com formula/mirror Columns Return Null
**What goes wrong:** Trying to read formula or mirror column values via API returns null.
**Why it happens:** Known Monday.com API limitation (documented in project memory for Dprisha).
**How to avoid:** Use only regular column types (text, phone, status, dropdown) for webhook data extraction. Never rely on formula/mirror columns.
**Warning signs:** Specific column values consistently null despite having values in the UI.

### Pitfall 5: Debounce Timer Not Cleared on Process Restart
**What goes wrong:** In-flight debounce timers are lost on restart, causing messages to be silently dropped.
**Why it happens:** setTimeout timers are in-memory and don't survive process restarts.
**How to avoid:** Store pending messages in the messages table immediately. On startup, check for any unprocessed incoming messages (messages with no corresponding outgoing response within a reasonable window).
**Warning signs:** Lead sends messages right before a deploy, gets no response.

### Pitfall 6: Claude Generating Prices Outside Guardrails
**What goes wrong:** Claude invents prices below minimum or above maximum despite system prompt instructions.
**Why it happens:** LLMs can hallucinate, especially with specific numbers under pressure from creative conversation flows.
**How to avoid:** Make price ranges extremely explicit and repeated in system prompt. Consider post-processing to detect and flag any monetary values in Claude's response that fall outside defined ranges.
**Warning signs:** Lead reports receiving a suspiciously low/high quote.

## Code Examples

### Claude SDK Initialization
```typescript
// Source: Anthropic TypeScript SDK README
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // defaults to ANTHROPIC_API_KEY env var
});
```

### System Prompt Structure (Recommended)
```typescript
// Claude's discretion on exact wording, but must include these elements:
const SYSTEM_PROMPT = `
אתה נציג מכירות של Alon.dev - שירותי טכנולוגיה ודיגיטל לעסקים.

## שירותים ומחירים

### אתרים
- דפי נחיתה: ₪2,000-5,000
- אתרי עסק: ₪5,000-15,000
- חנויות אונליין: ₪10,000-30,000

### אפליקציות
- אפליקציות מובייל: ₪15,000-50,000
- אפליקציות ווב: ₪10,000-40,000

### משחקים
- משחקי דפדפן: ₪5,000-20,000
- משחקי מובייל: ₪20,000-60,000

### אוטומציה ו-CRM
- תהליכי אוטומציה: ₪3,000-10,000
- הקמת CRM: ₪5,000-15,000

### שיווק דיגיטלי
- רשתות חברתיות: ₪2,000-5,000/חודש
- SEO: ₪3,000-8,000/חודש

## כללי מחיר
- לעולם אל תציע מחיר מתחת למינימום או מעל למקסימום
- כשההיקף לא ברור, ציין טווח: "בין ₪X ל-₪Y תלוי בהיקף"
- כשהלקוח מפרט היקף ספציפי, צמצם לטווח מדויק יותר

## סגנון
- עברית, לא פורמלי, ידידותי אך עסקי
- יוצר דחיפות ("יש לי חלון פנוי השבוע")
- משתמש באימוג'ים בתבונה
- מציג את אלון כיזם בודד + AI = כוח של צוות שלם
- דוחף לסגירה אך לא גס

## הקשר ליד
שם הליד: {lead_name}
התעניינות: {lead_interest}
`;
```

### Schema Migration for Monday.com Fields
```typescript
// Add to schema.ts or as migration
db.exec(`
  ALTER TABLE leads ADD COLUMN monday_item_id INTEGER;
  ALTER TABLE leads ADD COLUMN monday_board_id INTEGER;
  ALTER TABLE leads ADD COLUMN interest TEXT;
`);
// Note: SQLite ALTER TABLE ADD COLUMN is safe -- won't fail if column exists
// But should use IF NOT EXISTS pattern or try/catch for idempotency
```

### Express Webhook Route with JSON Body Parsing
```typescript
// IMPORTANT: Express v5 server.ts must add JSON body parsing for webhook
import express from 'express';

const app = express();
app.use(express.json()); // Required for webhook POST body parsing

// Mount webhook routes
app.use('/webhook', mondayWebhookRouter);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Anthropic SDK v0.x | @anthropic-ai/sdk 0.61+ | 2025 | Stable TypeScript types, system prompt as parameter |
| Monday.com API v1 | Monday.com GraphQL API v2 | 2019 | All mutations/queries use GraphQL, REST deprecated |
| Monday.com REST webhooks | Monday.com GraphQL webhook creation | 2024 | create_webhook mutation, JWT auth for apps |

**Deprecated/outdated:**
- Monday.com REST API v1: Fully deprecated, use GraphQL v2
- Anthropic completion API: Replaced by Messages API

## Open Questions

1. **Monday.com Column IDs for Alon's Board**
   - What we know: Board exists, leads come from alon-dev.vercel.app contact form
   - What's unclear: Exact column IDs for phone, name, interest, status columns
   - Recommendation: Use Monday.com MCP server (available per CONTEXT.md) to inspect the board schema during implementation. Or hardcode based on inspection and make configurable via env vars.

2. **Monday.com Webhook Creation Method**
   - What we know: Can create via Monday.com UI (Integrations > Webhook) or via GraphQL API mutation
   - What's unclear: Whether to automate webhook creation or set up manually in Monday.com UI
   - Recommendation: Manual setup via Monday.com UI is simpler and a one-time operation. Document the setup steps.

3. **Express v5 JSON Body Parsing**
   - What we know: Current server.ts does not call `app.use(express.json())`
   - What's unclear: Whether any existing routes need raw body access
   - Recommendation: Add `express.json()` middleware -- health and QR routes don't use request bodies, so no conflict.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | none -- uses package.json script `vitest run --reporter=verbose` |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npx vitest run --reporter=verbose` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MON-01 | Webhook endpoint handles challenge + events | unit | `npx vitest run src/monday/webhook-handler.test.ts -t "webhook"` | No -- Wave 0 |
| MON-02 | Extract lead data from Monday.com API response | unit | `npx vitest run src/monday/api.test.ts -t "fetch item"` | No -- Wave 0 |
| MON-03 | Update Monday.com status column | unit | `npx vitest run src/monday/api.test.ts -t "update status"` | No -- Wave 0 |
| AI-01 | Claude API call with Hebrew conversation | unit | `npx vitest run src/ai/conversation.test.ts -t "claude"` | No -- Wave 0 |
| AI-02 | System prompt contains all services and prices | unit | `npx vitest run src/ai/system-prompt.test.ts -t "prompt"` | No -- Wave 0 |
| AI-03 | Conversation history built from DB correctly | unit | `npx vitest run src/ai/conversation.test.ts -t "history"` | No -- Wave 0 |
| AI-04 | Message batching waits 8s, combines messages | unit | `npx vitest run src/whatsapp/message-batcher.test.ts -t "batch"` | No -- Wave 0 |
| AI-05 | Price ranges enforced in system prompt | unit | `npx vitest run src/ai/system-prompt.test.ts -t "price"` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run --reporter=verbose`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/monday/webhook-handler.test.ts` -- covers MON-01
- [ ] `src/monday/api.test.ts` -- covers MON-02, MON-03 (mock fetch)
- [ ] `src/ai/conversation.test.ts` -- covers AI-01, AI-03 (mock Anthropic client)
- [ ] `src/ai/system-prompt.test.ts` -- covers AI-02, AI-05 (prompt content assertions)
- [ ] `src/whatsapp/message-batcher.test.ts` -- covers AI-04 (fake timers)

## Sources

### Primary (HIGH confidence)
- [Anthropic TypeScript SDK README](https://github.com/anthropics/anthropic-sdk-typescript) - SDK usage, initialization, messages.create API
- [Anthropic Messages API Reference](https://platform.claude.com/docs/en/api/typescript/messages/create) - Full parameter reference, system prompt format, response structure
- [Monday.com Developer Docs - Webhooks](https://developer.monday.com/api-reference/reference/webhooks) - Webhook creation, event types
- [Monday.com Developer Docs - Column Values](https://developer.monday.com/api-reference/docs/change-column-values) - change_simple_column_value mutation
- [Monday.com Developer Docs - Authentication](https://developer.monday.com/api-reference/docs/authentication) - API token in Authorization header

### Secondary (MEDIUM confidence)
- [Hookdeck - Guide to Monday Webhooks](https://hookdeck.com/webhooks/platforms/guide-to-monday-webhooks-features-and-best-practices) - Verified webhook payload structures for create_item and change_column_value events
- [Monday.com Community - create_item webhook returns empty columnValues](https://community.monday.com/t/create-item-webhook-returns-empty-columnvalues/74343) - Confirmed empty columnValues is by design

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - @anthropic-ai/sdk is the official SDK, verified via npm and GitHub
- Architecture: HIGH - patterns follow existing project conventions (Express routes, pino logging, better-sqlite3)
- Monday.com integration: HIGH - webhook payload and GraphQL mutations verified across multiple official sources
- Debounce pattern: HIGH - standard JavaScript pattern, well-documented
- Pitfalls: HIGH - Monday.com empty columnValues confirmed by community and official behavior

**Research date:** 2026-03-09
**Valid until:** 2026-04-09 (stable domain, 30-day validity)
