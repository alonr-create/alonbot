# Requirements: Alon.dev WhatsApp Sales Bot

**Defined:** 2026-03-09
**Core Value:** Every lead that enters Monday.com gets a fast, personalized WhatsApp conversation that either closes a deal, books a meeting, or escalates to Alon.

## v1 Requirements

### WhatsApp Connection

- [ ] **WA-01**: Bot connects to WhatsApp via Baileys with multi-device auth
- [ ] **WA-02**: WhatsApp session persists across restarts (file/DB storage)
- [ ] **WA-03**: Bot auto-reconnects on disconnect without manual intervention
- [ ] **WA-04**: Rate limiting enforces minimum 3-5 second delay between outbound messages
- [ ] **WA-05**: Typing indicator simulation (1-3 seconds scaled by message length) before each response

### Monday.com Integration

- [ ] **MON-01**: Webhook endpoint receives new lead notifications from Monday.com
- [ ] **MON-02**: Bot extracts lead name, phone number, and service interest from webhook payload
- [ ] **MON-03**: Bot updates lead status column in Monday.com (contacted, in-conversation, quote-sent, meeting-scheduled, escalated)

### AI Conversation

- [ ] **AI-01**: Claude API powers Hebrew-first sales conversations
- [ ] **AI-02**: System prompt contains full Alon.dev service catalog (websites, apps, games, automation, CRM)
- [ ] **AI-03**: Conversation context persists in SQLite — bot remembers prior messages
- [ ] **AI-04**: Multi-message batching: wait 5-10 seconds after last message, respond to batch
- [ ] **AI-05**: Bot generates dynamic price quotes based on conversation context with guardrails (min/max per service)

### Scheduling

- [ ] **CAL-01**: Bot checks Google Calendar free/busy slots before suggesting meeting times
- [ ] **CAL-02**: Bot books discovery meeting on Google Calendar when lead confirms a time
- [ ] **CAL-03**: Business hours awareness — different responses during and after hours (Israel timezone)

### Follow-up

- [ ] **FU-01**: Automatic follow-up series for unresponsive leads: day 1, day 3, day 7
- [ ] **FU-02**: Follow-up stops immediately when lead replies
- [ ] **FU-03**: Follow-ups only sent during business hours

### Escalation

- [ ] **ESC-01**: Bot escalates to Alon after 3 failed conversation attempts or when lead requests a human
- [ ] **ESC-02**: Escalation sends Telegram notification to Alon with conversation summary
- [ ] **ESC-03**: Bot generates 3-line conversation summary on escalation (what they want, budget signals, concerns)

### Infrastructure

- [x] **INF-01**: SQLite database for leads, conversations, follow-up schedule
- [ ] **INF-02**: Docker deployment to Railway with persistent volume for session + DB
- [ ] **INF-03**: Health endpoint with connection status, DB health, uptime
- [x] **INF-04**: Structured logging (pino) for all operations

## v2 Requirements

### Enhanced Sales

- **SALE-01**: Portfolio showcase — send relevant project screenshots/links matched to lead interest
- **SALE-02**: Objection handling — trained responses for "too expensive", "I'll think about it"
- **SALE-03**: Intelligent routing — detect lead temperature (hot/cold) and adjust conversation pace

### Analytics

- **ANAL-01**: Conversion tracking — leads → conversations → quotes → meetings → deals
- **ANAL-02**: Response time metrics

### Resilience

- **RES-01**: Baileys breakage monitoring with auto-alert to Alon
- **RES-02**: Graceful degradation — leads still land in Monday.com if bot is down

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-user support | Alon is the only salesperson |
| Payment processing | Quotes only, payment happens outside bot |
| Voice/video calls | Text-based only, Alon calls directly |
| Broadcast/bulk messaging | Ban risk, this is 1-to-1 sales |
| WhatsApp Business API | Costs money, Baileys is free and proven |
| Visual flow builder | System prompt is the conversation logic |
| Multi-platform | WhatsApp only, Telegram handled by AlonBot |
| Customer support/ticketing | Sales bot, not support bot |
| Contract generation | Legal risk, Alon handles proposals post-meeting |
| Analytics dashboard | SQLite queries + Monday.com dashboard sufficient |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| WA-01 | Phase 1 | Pending |
| WA-02 | Phase 1 | Pending |
| WA-03 | Phase 1 | Pending |
| WA-04 | Phase 1 | Pending |
| WA-05 | Phase 1 | Pending |
| MON-01 | Phase 2 | Pending |
| MON-02 | Phase 2 | Pending |
| MON-03 | Phase 2 | Pending |
| AI-01 | Phase 2 | Pending |
| AI-02 | Phase 2 | Pending |
| AI-03 | Phase 2 | Pending |
| AI-04 | Phase 2 | Pending |
| AI-05 | Phase 2 | Pending |
| CAL-01 | Phase 3 | Pending |
| CAL-02 | Phase 3 | Pending |
| CAL-03 | Phase 3 | Pending |
| FU-01 | Phase 4 | Pending |
| FU-02 | Phase 4 | Pending |
| FU-03 | Phase 4 | Pending |
| ESC-01 | Phase 3 | Pending |
| ESC-02 | Phase 3 | Pending |
| ESC-03 | Phase 3 | Pending |
| INF-01 | Phase 1 | Complete |
| INF-02 | Phase 1 | Pending |
| INF-03 | Phase 1 | Pending |
| INF-04 | Phase 1 | Complete |

**Coverage:**
- v1 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0

---
*Requirements defined: 2026-03-09*
*Last updated: 2026-03-09 after roadmap creation*
