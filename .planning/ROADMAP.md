# Roadmap: Alon.dev WhatsApp Sales Bot

## Overview

From zero to a fully autonomous WhatsApp sales bot in 4 phases. Phase 1 establishes the WhatsApp connection and infrastructure backbone. Phase 2 wires up Monday.com lead detection and Claude-powered Hebrew sales conversations -- the MVP. Phase 3 adds deal-closing capabilities: meeting booking via Google Calendar and human escalation. Phase 4 layers on automated follow-up sequences for unresponsive leads with anti-spam safeguards.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation** - WhatsApp connection via Baileys with session persistence, SQLite database, Docker deployment to Railway (completed 2026-03-09)
- [x] **Phase 2: Sales Conversation** - Monday.com webhook triggers AI-powered Hebrew sales dialogue via Claude, with status sync back to Monday.com (completed 2026-03-09)
- [x] **Phase 3: Closing Power** - Google Calendar meeting booking, dynamic price quotes with guardrails, and escalation to Alon when needed (completed 2026-03-09)
- [ ] **Phase 4: Follow-up** - Automated 3-message follow-up series for unresponsive leads with business hours enforcement

## Phase Details

### Phase 1: Foundation
**Goal**: Bot is connected to WhatsApp, persists its session, and runs on Railway with a working database and health monitoring
**Depends on**: Nothing (first phase)
**Requirements**: WA-01, WA-02, WA-03, WA-04, WA-05, INF-01, INF-02, INF-03, INF-04
**Success Criteria** (what must be TRUE):
  1. Bot connects to WhatsApp via QR code scan and stays connected across process restarts
  2. Bot auto-reconnects within 30 seconds after a network disconnect without manual intervention
  3. Sending a test message from another phone shows a typing indicator followed by a response with natural delay
  4. Health endpoint returns connection status, DB health, and uptime as JSON
  5. Bot runs on Railway with persistent volume -- redeployment does not lose WhatsApp session or database
**Plans:** 3/3 plans complete

Plans:
- [x] 01-01-PLAN.md — Project init, config, SQLite database, pino logging, utilities
- [x] 01-02-PLAN.md — WhatsApp connection (Baileys), rate limiter, typing simulation, message handler, notifications
- [x] 01-03-PLAN.md — HTTP server (health + QR web page), entry point wiring, Dockerfile for Railway

### Phase 2: Sales Conversation
**Goal**: New leads from Monday.com automatically receive a personalized Hebrew WhatsApp conversation powered by Claude that knows all Alon.dev services
**Depends on**: Phase 1
**Requirements**: MON-01, MON-02, MON-03, AI-01, AI-02, AI-03, AI-04, AI-05
**Success Criteria** (what must be TRUE):
  1. When a new lead is created in Monday.com, bot sends a personalized first message within 60 seconds mentioning their stated interest
  2. Bot conducts a multi-turn Hebrew sales conversation that accurately describes Alon.dev services and generates price quotes within defined min/max ranges
  3. When a lead sends multiple messages in quick succession, bot waits for a pause then responds to the full batch as one coherent reply
  4. Lead status in Monday.com updates automatically as the conversation progresses (contacted, in-conversation, quote-sent)
  5. Conversation history persists in SQLite -- bot picks up context correctly after a restart
**Plans:** 2/2 plans complete

Plans:
- [x] 02-01-PLAN.md — Monday.com webhook, GraphQL API, schema migration, config extension
- [x] 02-02-PLAN.md — Claude AI conversation engine, message batcher, message handler rewrite

### Phase 3: Closing Power
**Goal**: Bot can book discovery meetings on Google Calendar and escalate to Alon when it cannot close
**Depends on**: Phase 2
**Requirements**: CAL-01, CAL-02, CAL-03, ESC-01, ESC-02, ESC-03
**Success Criteria** (what must be TRUE):
  1. Bot suggests only genuinely available time slots from Google Calendar (no double-booking)
  2. When lead confirms a time, a calendar event is created with lead name, phone, and conversation context
  3. Bot responds differently during business hours vs. after hours (Israel timezone)
  4. After 3 failed conversation attempts or when lead asks for a human, bot escalates and Alon receives a Telegram notification with a 3-line conversation summary
  5. Monday.com status updates to "meeting-scheduled" or "escalated" accordingly
**Plans:** 2/2 plans complete

Plans:
- [x] 03-01-PLAN.md — Calendar module (Apps Script proxy + business hours) and escalation module (trigger detection + summary + Telegram notification)
- [x] 03-02-PLAN.md — Wire calendar booking and escalation into conversation orchestrator and system prompt

### Phase 4: Follow-up
**Goal**: Unresponsive leads automatically receive a 3-message follow-up series that respects business hours and stops when the lead re-engages
**Depends on**: Phase 3
**Requirements**: FU-01, FU-02, FU-03
**Success Criteria** (what must be TRUE):
  1. A lead who does not reply receives follow-up messages on day 1, day 3, and day 7 -- each with distinct, non-repetitive content
  2. Follow-up stops immediately when the lead sends any reply
  3. Follow-up messages are only sent during business hours (Israel timezone) -- never at night or on Shabbat
**Plans:** 2 plans

Plans:
- [x] 04-01-PLAN.md — Follow-up module: DB schema, DB operations, AI message generation, 15-minute scheduler
- [ ] 04-02-PLAN.md — Wire follow-up into message handler, conversation engine, and boot sequence

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 3/3 | Complete    | 2026-03-09 |
| 2. Sales Conversation | 2/2 | Complete    | 2026-03-09 |
| 3. Closing Power | 2/2 | Complete    | 2026-03-09 |
| 4. Follow-up | 1/2 | In progress | - |
