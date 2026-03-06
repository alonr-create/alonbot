# AlonBot

AI-powered personal and business assistant via Telegram. Built with Claude API, SQLite, and Node.js.

## Features

- **AI Chat** — Claude Sonnet 4 with Gemini fallback on rate limits
- **Voice Messages** — STT (Groq Whisper) + TTS (ElevenLabs) voice-to-voice
- **Memory System** — Semantic memory with vector search (sqlite-vec), auto-summarization
- **Image Generation** — Gemini Flash image generation sent directly to chat
- **Image Analysis** — Vision API for photos and screenshots
- **Web Search & Research** — DuckDuckGo + Gemini grounded search with sources
- **Monday.com Integration** — GraphQL queries for business boards
- **Email** — Send Gmail with whitelisted recipients
- **Task Management** — Add, list, complete tasks with priorities and due dates
- **Cron Reminders** — Set custom cron-based reminders
- **File Transfer** — Send files from Mac to Telegram
- **Screenshot** — Capture and send Mac screen
- **Project Management** — Git status/log/pull/diff for local projects
- **Cost Tracking** — Per-request API cost logging and reports
- **Proactive Alerts** — Overdue tasks (daily 18:00), weekly summary (Sunday 09:00)
- **Quiet Mode** — Shorter responses at night (23:00-07:00) and Shabbat
- **Cloud + Local** — Run on Render (cloud) with Cloudflare tunnel to Mac for local tools

## Architecture

```
Telegram User
    |
    v
[Cloud: Render]          [Local: Mac]
  - Telegram bot           - Shell, files, screenshots
  - Claude API             - Cloudflare tunnel
  - Cron jobs              - Tool API server
  - SQLite (memory)        - Auto-registers with cloud
    |                          |
    +---- proxy local tools ---+
```

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USER/alonbot.git
cd alonbot
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your API keys (at minimum: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM)
```

### 3. Run locally

```bash
# Development (auto-reload)
npm run dev

# Production
npm run build
npm start
```

### 4. Deploy to Render (cloud)

The project includes `render.yaml` for one-click deploy:

1. Push to GitHub
2. Connect repo on [Render](https://render.com)
3. Set environment variables in Render dashboard
4. Set `MODE=cloud` in env vars

### 5. Deploy with Docker

```bash
docker build -t alonbot .
docker run -d --name alonbot \
  --env-file .env \
  -e MODE=cloud \
  -v alonbot-data:/app/data \
  -p 3700:3700 \
  alonbot
```

## Cloud + Local Mac Setup

To use local tools (shell, files, screenshots) from cloud:

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/):
   ```bash
   brew install cloudflared
   ```

2. Run the tunnel script:
   ```bash
   ./scripts/start-tunnel.sh
   ```

3. Or set up auto-start on boot:
   ```bash
   # Copy the LaunchAgent (edit paths in the plist first)
   cp scripts/com.alonbot-tunnel.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.alonbot-tunnel.plist
   ```

## Project Structure

```
alonbot/
  src/
    agent/
      agent.ts          # Main agent loop (Claude + Gemini fallback)
      tools.ts          # 22 tool definitions and execution
      memory.ts         # Memory system (save, retrieve, embed, summarize)
      system-prompt.ts  # Dynamic system prompt with context
    channels/
      telegram.ts       # Telegram adapter (text, voice, photo, document, menu)
      whatsapp.ts       # WhatsApp adapter (Baileys)
      types.ts          # Unified message/reply types
    gateway/
      router.ts         # Channel router (adapters, message dispatch)
      server.ts         # Express server (health, tool API, registration)
    cron/
      scheduler.ts      # DB-driven cron job scheduler
    skills/
      loader.ts         # Markdown skill loader
    utils/
      config.ts         # Environment config
      db.ts             # SQLite setup (tables, indexes, vectors, migrations)
      embeddings.ts     # Gemini embedding for semantic search
  skills/               # Skill markdown files
  scripts/              # Tunnel and setup scripts
  data/                 # SQLite database (auto-created, gitignored)
```

## API Keys Required

| Key | Required | Free? | Used For |
|-----|----------|-------|----------|
| `ANTHROPIC_API_KEY` | Yes | No ($3/M input, $15/M output) | Main AI model |
| `TELEGRAM_BOT_TOKEN` | Yes | Yes | Telegram bot |
| `GEMINI_API_KEY` | Recommended | Yes | Image gen, vision, web research, fallback |
| `GROQ_API_KEY` | Optional | Yes | Voice transcription (Whisper) |
| `ELEVENLABS_API_KEY` | Optional | Freemium | Text-to-speech |
| `MONDAY_API_KEY` | Optional | With Monday account | Business board queries |
| `GMAIL_APP_PASSWORD` | Optional | Yes | Send emails |

## Tools (22)

| Tool | Cloud | Local | Description |
|------|-------|-------|-------------|
| `web_search` | V | V | DuckDuckGo search |
| `web_research` | V | V | Deep research via Gemini + Google |
| `browse_url` | V | V | Fetch web page content |
| `analyze_image` | V | V | Analyze image from URL |
| `generate_image` | V | V | Generate image with Gemini |
| `remember` | V | V | Save memory about user |
| `set_reminder` | V | V | Set cron reminder |
| `list_reminders` | V | V | List all reminders |
| `delete_reminder` | V | V | Delete a reminder |
| `monday_api` | V | V | Monday.com GraphQL |
| `send_voice` | V | V | TTS voice message |
| `send_email` | V | V | Send Gmail |
| `api_costs` | V | V | API usage report |
| `add_task` | V | V | Add task |
| `list_tasks` | V | V | List pending tasks |
| `complete_task` | V | V | Mark task done |
| `shell` | proxy | V | Run whitelisted shell command |
| `read_file` | proxy | V | Read project file |
| `write_file` | proxy | V | Write project file |
| `screenshot` | proxy | V | Screenshot Mac screen |
| `manage_project` | proxy | V | Git operations |
| `send_file` | proxy | V | Send file to user |

*proxy = cloud forwards to local Mac via Cloudflare tunnel*

## Security

- **User whitelist** — Only configured Telegram/WhatsApp IDs can interact
- **Shell whitelist** — Only safe commands allowed (ls, cat, date, etc.)
- **No command injection** — Shell metacharacters blocked (;|&`$)
- **File path restrictions** — Only project directories accessible
- **SSRF prevention** — No internal/private IPs for URL tools
- **Email whitelist** — Only known addresses/domains
- **Rate limiting** — 10 messages/minute per user
- **No secret exposure** — .env, .git, credentials blocked from file tools

## Customization

### Adding Tools
Edit `src/agent/tools.ts`:
1. Add tool definition to `allToolDefinitions` array
2. Add `case` in `executeTool` switch
3. If local-only, add to `LOCAL_ONLY_TOOLS`

### Adding Skills
Create a markdown file in `skills/` directory. Skills are loaded and injected into the system prompt.

### Changing the Persona
Edit `src/agent/system-prompt.ts` to modify the bot's personality, language, and behavior.

## License

MIT
