# Feature Landscape

**Domain:** WhatsApp Sales Bot (B2B tech services lead engagement)
**Researched:** 2026-03-09
**Confidence:** MEDIUM (training data + project context; web verification unavailable)

## Table Stakes

Features that a WhatsApp sales bot must have to be functional. Missing any of these and the system cannot serve its core purpose.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| WhatsApp connection with session persistence | Bot is useless if it can't stay connected. Baileys sessions drop; must reconnect automatically. | Medium | Baileys multi-device auth, store session in DB/file, auto-reconnect on disconnect |
| Automatic first-contact message | The entire point — lead enters Monday.com, gets WhatsApp greeting within minutes. Speed-to-lead is the #1 predictor of conversion. | Low | Trigger on Monday.com webhook, send personalized intro based on lead's stated interest |
| AI-powered Hebrew conversation | Must understand and respond naturally in Hebrew. Rigid decision trees feel robotic and kill trust. | Medium | Claude API with system prompt containing Alon.dev service catalog, pricing ranges, and sales persona |
| Conversation context memory | Lead says "I want a website" on message 1 — bot must remember this on message 5. Without context, conversations restart and leads abandon. | Medium | Store messages in SQLite, inject recent history into Claude context window |
| Service knowledge base | Bot must know what Alon.dev offers (websites, apps, games, automation, CRM), rough pricing, timelines, and portfolio examples. Without this, it can't sell. | Low | Static knowledge in system prompt or structured JSON. Update manually when services change. |
| Human escalation / handoff | When lead asks for a human, or conversation goes sideways, Alon must be notified immediately. No bot should trap a lead. | Low | Detect "I want to talk to a person" / frustration signals. Notify Alon via Telegram. Mark lead as escalated. |
| Lead status sync to Monday.com | Alon checks Monday.com to see pipeline. If bot conversations aren't reflected there, Alon loses visibility. | Medium | Update Monday.com column: new -> contacted -> in-conversation -> quote-sent -> meeting-scheduled -> escalated |
| Basic follow-up for unresponsive leads | Leads go cold. A single unanswered message cannot be the end. Industry standard is 2-3 follow-ups over 7 days. | Low | Scheduled messages: Day 1 (gentle nudge), Day 3 (value add), Day 7 (last chance). Stop on reply. |
| Rate limiting and anti-spam guards | WhatsApp bans numbers that send too fast or too many messages. One ban = total system failure. | Medium | Min 3-5 second delay between messages. Max messages per hour. No bulk sends. Typing indicator simulation. |
| Typing indicator / read receipts | Without simulated "typing..." delay, bot responses feel instant and robotic. Leads suspect automation. | Low | Wait 1-3 seconds before responding. Scale delay with message length. |

## Differentiators

Features that set this bot apart from basic chatbots. Not expected, but deliver outsized value.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Dynamic AI price quotes | Most bots say "contact us for pricing." This bot generates ballpark quotes in-conversation based on what the lead describes. Removes friction, qualifies budget fit instantly. | High | Claude generates quote from conversation context + pricing rules. Format as clean WhatsApp message with line items. Must have guardrails (min/max ranges per service type). |
| Google Calendar meeting scheduling | Lead says "let's meet" and bot checks real availability, proposes slots, and books — all in WhatsApp. No external Calendly link needed. | High | Google Calendar API: fetch free/busy, propose 3 slots, create event on confirmation. Handle timezone (Israel). Send calendar invite. |
| Portfolio showcase in-chat | When lead asks "show me your work," bot sends relevant portfolio examples (screenshots, links) matched to the service they're interested in. Visual proof sells. | Medium | Map portfolio items to service categories. Send as WhatsApp images/links. Wealthy Mindset for websites, Dprisha for automation, etc. |
| Intelligent conversation routing | Bot detects lead intent (browsing vs. serious buyer vs. urgent need) and adjusts tone and urgency. Hot leads get fast-tracked to meeting booking. Cold leads get nurtured. | Medium | Claude prompt engineering: classify intent from conversation signals. Adjust follow-up cadence and CTA based on classification. |
| Conversation summary for Alon | When a lead escalates or books a meeting, Alon gets a 3-line summary of the entire conversation — not a wall of messages. Saves prep time. | Low | Claude summarizes conversation history on escalation/booking. Include: what they want, budget signals, timeline, concerns. |
| Multi-message handling (batching) | Leads send 3-4 messages in a row before expecting a response. Bot should wait 5-10 seconds after last message, then respond to all at once. | Medium | Debounce incoming messages. Collect within window. Respond to batch as single context. Prevents awkward mid-thought interruptions. |
| Business hours awareness | Bot behaves differently during business hours (responsive, can offer immediate call) vs. after hours (acknowledges, promises follow-up). | Low | Israel timezone check. After-hours: "Got your message, I'll get back to you tomorrow morning." |
| Objection handling | When lead says "too expensive" or "I'll think about it," bot has trained responses that address common objections rather than just accepting silence. | Medium | Objection patterns in system prompt. "Too expensive" -> value framing, payment options. "I'll think about it" -> offer to send summary, schedule follow-up. |

## Anti-Features

Features to explicitly NOT build. These add complexity without value for this specific use case.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Multi-agent / multi-user support | Alon is the only salesperson. Building role-based access, team routing, and permission systems is wasted effort. | Single-user bot. Hardcode Alon as the human fallback. |
| Payment processing | Taking payments over WhatsApp adds PCI compliance burden, refund handling, and trust issues. Alon's services require proposals and contracts first. | Generate quotes only. Direct to bank transfer or meeting for payment discussion. |
| Voice/video calls via bot | WhatsApp voice/video requires different infrastructure (WebRTC), adds huge complexity, and Alon can just call the lead directly. | Bot suggests "Alon will call you" and notifies Alon with lead's number. |
| Broadcast / bulk messaging | Mass WhatsApp messages get numbers banned immediately. This is a 1-to-1 sales tool, not a marketing blast platform. | Only message leads who initiated contact or are in the Monday.com pipeline. Never cold-outreach. |
| Complex flow builder / visual editor | Alon is the only user. A drag-and-drop flow builder is engineering effort that replaces editing a system prompt. | Conversation logic lives in Claude's system prompt. Edit the prompt to change behavior. |
| Multi-platform support (Telegram, Instagram, etc.) | Telegram is already handled by AlonBot. Splitting attention across platforms dilutes the product. | WhatsApp only. AlonBot handles Telegram. |
| Customer support / ticketing | This is a sales bot, not a support bot. Post-sale support is a different product with different requirements. | After deal closes, support happens via direct WhatsApp with Alon, not through the bot. |
| Detailed analytics dashboard | For a single-user bot handling ~10-30 leads/month, a full analytics dashboard is overkill. | Simple SQLite queries or Monday.com dashboard for pipeline visibility. Log conversations for review. |
| Auto-generated contracts / proposals | Legal documents require review, customization, and carry liability. Bot-generated contracts are a legal risk. | Bot generates price quotes as conversation messages. Formal proposals are Alon's job after meeting. |
| WhatsApp Business API (official) | Costs money (per-conversation pricing), requires Facebook Business verification, and adds bureaucratic overhead. Baileys is free and already proven in AlonBot. | Use Baileys. Accept the risk of occasional disconnects in exchange for zero cost and fast shipping. |

## Feature Dependencies

```
WhatsApp Connection (Baileys)
  |
  +---> Automatic First Contact
  |       |
  |       +---> AI Conversation (Claude)
  |               |
  |               +---> Service Knowledge Base
  |               +---> Conversation Context Memory
  |               +---> Dynamic Price Quotes
  |               +---> Objection Handling
  |               +---> Intelligent Routing
  |               +---> Conversation Summary
  |
  +---> Rate Limiting / Anti-Spam
  +---> Typing Indicator Simulation
  +---> Multi-Message Batching

Monday.com Webhook
  |
  +---> Automatic First Contact (trigger)
  +---> Lead Status Sync (bidirectional)

Follow-Up Scheduler
  |
  +---> Business Hours Awareness
  +---> Cron/Timer System (node-cron or DB-driven)

Google Calendar API
  |
  +---> Meeting Scheduling
        |
        +---> Free/Busy Check
        +---> Event Creation

Human Escalation
  |
  +---> Telegram Notification to Alon
  +---> Conversation Summary
  +---> Lead Status Update (-> escalated)
```

## MVP Recommendation

**Prioritize (Phase 1 - Core Loop):**

1. **WhatsApp connection with session persistence** — foundation for everything
2. **Monday.com webhook -> automatic first message** — the trigger that starts sales
3. **AI conversation with service knowledge** — the core value: smart Hebrew sales chat
4. **Conversation context memory** — without this, conversations break after 2 messages
5. **Human escalation with Telegram notification** — safety net so no lead is abandoned
6. **Lead status sync to Monday.com** — visibility for Alon

**Prioritize (Phase 2 - Sales Power):**

7. **Follow-up sequences** — recover cold leads
8. **Rate limiting and anti-spam** — protect the WhatsApp number from ban
9. **Dynamic price quotes** — the differentiator that removes friction
10. **Typing indicator simulation** — small effort, big UX impact

**Prioritize (Phase 3 - Meeting & Polish):**

11. **Google Calendar meeting scheduling** — close the loop: lead -> conversation -> meeting
12. **Multi-message batching** — handle real conversation patterns
13. **Business hours awareness** — appropriate responses any time
14. **Conversation summary on escalation** — save Alon prep time

**Defer:**

- **Portfolio showcase**: Nice to have but can be added to system prompt as links. Does not need dedicated feature engineering.
- **Objection handling**: Initially handle via prompt engineering. Formalize only if patterns emerge from real conversations.
- **Intelligent conversation routing**: Requires real conversation data to calibrate. Start with uniform treatment, optimize later.

## Sources

- Project context: `/Users/oakhome/קלוד עבודות/alon-dev-whatsapp/.planning/PROJECT.md`
- AlonBot reference architecture: `/Users/oakhome/קלוד עבודות/alonbot/` (existing Baileys + Claude + Calendar patterns)
- Domain knowledge of WhatsApp sales bot platforms (Respond.io, WATI, Chatfuel, Landbot, Tidio) — MEDIUM confidence, not web-verified in this session
- WhatsApp/Baileys anti-spam patterns — MEDIUM confidence from training data
