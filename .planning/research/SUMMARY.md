# Research Summary: Alon.dev WhatsApp Sales Bot

**Domain:** WhatsApp Sales Bot / AI-driven Lead Engagement
**Researched:** 2026-03-09
**Overall confidence:** HIGH

## Executive Summary

This project has an unusually strong starting position: nearly every required technology is already proven in production across Alon's existing projects. AlonBot provides a working Baileys WhatsApp adapter, Claude AI integration, Monday.com GraphQL client, and Google Calendar proxy -- all in TypeScript ESM on Node.js. The sales bot is architecturally a new standalone service that reuses these exact patterns with a different purpose: outbound sales engagement rather than personal assistant.

The primary risks are operational, not technical. WhatsApp account bans from automated outbound messaging is the single biggest threat. Baileys library instability (as an unofficial reverse-engineered client) is the second. AI hallucinating pricing or commitments is the third. None of these are showstoppers, but all require deliberate mitigation from day one.

The recommended architecture is an event-driven pipeline: Monday.com webhook triggers lead creation, a state machine orchestrates the conversation lifecycle, Claude handles the actual dialogue, and node-cron manages follow-up scheduling. SQLite stores everything. The system deploys to Railway with a persistent volume for the WhatsApp session and database.

The stack is intentionally conservative -- no new frameworks, no new patterns, no new infrastructure. Every library is already in `package.json` of another Alon project. This reduces risk and development time significantly. The only genuinely new code is the sales conversation logic (system prompt, state machine, follow-up rules) and the Monday.com webhook receiver.

## Key Findings

**Stack:** Node.js 22 + TypeScript + Baileys ^6.7 + Claude API + Express v5 + SQLite + node-cron. All versions verified from AlonBot and Aliza production code.

**Architecture:** Event-driven pipeline with 6 components (Webhook Server, WhatsApp Channel, Lead Orchestrator, AI Engine, Follow-up Scheduler, Calendar Service). Standalone service, not a module inside AlonBot.

**Critical pitfall:** WhatsApp account ban from automated outbound messages. Must use a dedicated SIM (not Alon's personal number), warm up gradually, enforce strict rate limits, and personalize every message.

## Implications for Roadmap

Based on research, suggested phase structure:

1. **Foundation** - WhatsApp connection + SQLite database + project scaffolding
   - Addresses: Session persistence, database schema, config management
   - Avoids: Building on unstable foundation (Pitfall #2: session loss)
   - Must resolve: Get dedicated SIM card (Pitfall #4: personal number risk)

2. **Core Loop** - Monday.com webhook + AI conversation + status sync
   - Addresses: New lead detection, first message, basic conversation, Monday.com updates
   - Avoids: AI hallucination (Pitfall #3) via strict system prompt with price ranges
   - This is the MVP -- a working end-to-end sales conversation

3. **Sales Power** - Price quotes + meeting booking + escalation
   - Addresses: Dynamic quotes, Google Calendar integration, human handoff
   - Avoids: Timezone bugs (Pitfall #10) via explicit Asia/Jerusalem handling

4. **Persistence** - Follow-up scheduler + business hours + polish
   - Addresses: Day 1/3/7 follow-ups, opt-out handling, anti-spam guards
   - Avoids: Harassment/ban risk (Pitfalls #1, #6) via rate limits and business hours logic

5. **Deploy** - Railway Docker + monitoring + Telegram notifications
   - Addresses: Production deployment, health monitoring, session loss alerts
   - Avoids: Silent failures (Pitfall #5: Baileys breaking) via monitoring and fallback notifications

**Phase ordering rationale:**
- Phase 1 before all else because WhatsApp connection is the foundation everything depends on
- Phase 2 is the MVP -- proves the concept works end-to-end
- Phase 3 adds sales differentiation (quotes + meetings) which is the value beyond a simple chatbot
- Phase 4 adds persistence (follow-ups) which requires careful anti-spam handling -- better to ship the core loop first and iterate on follow-up messaging
- Phase 5 is deployment hardening -- can run locally during development

**Research flags for phases:**
- Phase 1: Standard patterns from AlonBot. Unlikely to need research. But MUST verify dedicated SIM card is obtained.
- Phase 2: Monday.com webhook payload structure may need phase-specific research (webhook format varies by board configuration).
- Phase 3: Google Calendar Apps Script proxy may need extension (currently supports list + add, may need free/busy check).
- Phase 4: WhatsApp anti-spam thresholds need careful testing. No official documentation exists. Start conservative.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Every library verified from existing production projects (AlonBot, Aliza). Versions confirmed from package.json files. |
| Features | MEDIUM | Feature landscape is well-defined but sales bot conversation design (system prompt, state machine transitions) needs real conversation data to tune. |
| Architecture | HIGH | Architecture follows proven AlonBot patterns. State machine and orchestrator are standard software patterns. |
| Pitfalls | HIGH for technical pitfalls (Baileys session, Monday.com webhooks). MEDIUM for operational pitfalls (WhatsApp anti-spam thresholds -- no official docs). |

## Gaps to Address

- **WhatsApp anti-spam exact thresholds**: No official documentation. Community-reported values vary. Must test conservatively and monitor.
- **Monday.com webhook payload structure**: Varies by board configuration. Need to inspect actual webhook payloads from Alon's leads board.
- **Google Calendar free/busy API**: AlonBot's Apps Script proxy supports list and add but may not support free/busy queries needed for slot suggestions. May need to extend the Apps Script.
- **Alon.dev service catalog and pricing**: The AI system prompt needs detailed, accurate pricing ranges for each service. This is business knowledge that Alon must provide -- cannot be researched.
- **Dedicated phone number**: Must be obtained before any development begins. This is a prerequisite, not a technical gap.
