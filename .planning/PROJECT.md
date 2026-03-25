# Alon.dev WhatsApp Sales Bot

## What This Is

A Hebrew-first WhatsApp sales bot for Alon.dev that automatically engages new leads from Monday.com, presents relevant services (websites, apps, games, automation, CRM), generates AI-powered price quotes, schedules discovery meetings via Google Calendar, and follows up with unresponsive leads — all through WhatsApp using Baileys.

## Core Value

Every lead that enters Monday.com gets a fast, personalized WhatsApp conversation that either closes a deal, books a meeting, or escalates to Alon — no lead falls through the cracks.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] WhatsApp connection via Baileys with session persistence
- [ ] Monday.com webhook integration to detect new leads
- [ ] Automatic first message to new leads based on their interest
- [ ] AI-powered conversation flow using Claude API (Hebrew)
- [ ] Knowledge of all Alon.dev services (websites, apps, games, automation, CRM)
- [ ] Dynamic AI-generated price quotes based on conversation context
- [ ] Google Calendar integration for scheduling discovery meetings
- [ ] Available time slots check before suggesting meeting times
- [ ] Follow-up series (3 messages: day 1, day 3, day 7) for unresponsive leads
- [ ] Escalation to Alon after 3 failed attempts or when lead requests a human
- [ ] Lead status updates back to Monday.com (contacted, in conversation, meeting scheduled, quote sent, escalated)
- [ ] Conversation history storage for context continuity
- [ ] Notification to Alon on escalation (via Telegram or WhatsApp)

### Out of Scope

- Multi-user support — single sales agent (Alon)
- Payment processing — quotes only, no online payment
- Voice/video calls — text-based WhatsApp only
- Other messaging platforms — WhatsApp only (Telegram handled by AlonBot)
- Contract/proposal generation — just price quotes in chat

## Context

- Alon.dev is a tech services business: websites, apps, games, automation, CRM
- Leads come from alon-dev.vercel.app contact form → Monday.com board
- Alon currently handles leads manually via WhatsApp
- AlonBot (existing Telegram bot) already has Baileys WhatsApp integration as reference
- Monday.com MCP server available for API interaction
- Google Calendar API already used in AlonBot
- Contact: 054-630-0783, alondevoffice@gmail.com

## Constraints

- **WhatsApp**: Baileys (unofficial API) — risk of disconnects, no official support
- **Stack**: Node.js + TypeScript ESM (consistent with Alon.dev ecosystem)
- **Deployment**: Railway or Render (Docker) — needs persistent storage for WhatsApp session
- **Rate limits**: WhatsApp anti-spam — careful message timing, no bulk blasts
- **Hebrew**: All conversations in Hebrew, RTL-aware
- **Single number**: One WhatsApp number for the bot (054-630-0783 or separate number)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Baileys over WhatsApp Business API | Free, already familiar from AlonBot, quick to ship | — Pending |
| Claude API for conversation | Best Hebrew AI, already integrated in ecosystem | — Pending |
| Monday.com webhooks for lead detection | Real-time trigger vs polling, native integration | — Pending |
| 3-message follow-up series | Enough persistence without being annoying | — Pending |
| Google Calendar for meetings | Already in use, API familiar from AlonBot | — Pending |

---
*Last updated: 2026-03-09 after initialization*
