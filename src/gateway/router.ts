import type { ChannelAdapter, UnifiedMessage } from '../channels/types.js';
import { handleMessage, type StreamCallback } from '../agent/agent.js';
import { matchKeywordWorkflows } from '../agent/workflows.js';
import { executeWorkflowActions } from '../agent/tools.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';

const log = createLogger('router');

const adapters = new Map<string, ChannelAdapter>();

// Sync messages to cloud DB when running in local mode
// This ensures the dashboard on Render can see all conversations
async function syncToCloud(messages: Array<{ channel: string; sender_id: string; sender_name?: string; role: string; content: string; created_at: string }>) {
  if (config.mode !== 'local') return; // only local syncs to cloud
  const cloudUrl = process.env.RENDER_URL || 'https://alonbot.onrender.com';
  const secret = process.env.LOCAL_API_SECRET;
  if (!secret) return;
  try {
    await fetch(`${cloudUrl}/api/sync/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': secret },
      body: JSON.stringify({ messages }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e: any) {
    log.debug({ err: e.message }, 'cloud sync failed');
  }
}

// Deduplication: prevent processing the same message twice (e.g. Telegram polling restarts, webhook retries)
const recentMessageIds = new Map<string, number>(); // messageKey -> timestamp
const DEDUP_WINDOW_MS = 300_000; // 5 minutes — Meta Cloud API retries webhooks

// Cleanup stale dedup entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentMessageIds) {
    if (now - ts > DEDUP_WINDOW_MS) recentMessageIds.delete(key);
  }
}, 120_000);

// Tool name → Hebrew label for streaming display
const TOOL_LABELS: Record<string, string> = {
  web_search: '🔍 מחפש באינטרנט...',
  web_research: '📚 עושה מחקר מעמיק...',
  browse_url: '🌐 קורא דף אינטרנט...',
  analyze_image: '👁️ מנתח תמונה...',
  generate_image: '🎨 יוצר תמונה...',
  remember: '🧠 שומר לזיכרון...',
  monday_api: '📊 שולף נתונים מ-Monday...',
  shell: '💻 מריץ פקודה...',
  send_email: '📧 שולח מייל...',
  send_voice: '🎤 מייצר הודעה קולית...',
  read_file: '📖 קורא קובץ...',
  write_file: '✍️ כותב קובץ...',
  create_github_repo: '🐙 יוצר ריפו ב-GitHub...',
  deploy_app: '🚀 מפרס אפליקציה...',
  build_website: '🏗️ בונה אתר...',
  auto_improve: '🧬 משדרג את עצמי...',
  scrape_site: '🕷️ סורק אתר...',
  cron_script: '⏰ מתזמן סקריפט...',
  set_reminder: '🔔 מגדיר תזכורת...',
  schedule_message: '📅 מתזמן הודעה...',
  add_task: '📋 מוסיף משימה...',
  search_knowledge: '🔎 מחפש בבסיס הידע...',
  learn_url: '📥 טוען תוכן...',
  calendar_list: '📆 בודק יומן...',
  calendar_add: '📆 מוסיף אירוע...',
  screenshot: '📸 מצלם מסך...',
  camera: '📷 מצלם מהמצלמה...',
  api_costs: '💰 מחשב עלויות...',
  manage_project: '📂 בודק פרויקט...',
  send_file: '📎 שולח קובץ...',
  send_document: '📎 שולח מסמך...',
  code_agent: '🤖 Claude Code עובד על הפרויקט...',
};

export function registerAdapter(adapter: ChannelAdapter) {
  adapters.set(adapter.name, adapter);

  adapter.onMessage(async (msg: UnifiedMessage) => {
    // Deduplicate: skip if we already processed this exact message
    const dedupKey = `${msg.channel}:${msg.senderId}:${msg.id}`;
    if (recentMessageIds.has(dedupKey)) {
      log.warn({ dedupKey }, 'duplicate message skipped');
      return;
    }
    recentMessageIds.set(dedupKey, Date.now());

    log.info({ channel: msg.channel, sender: msg.senderName, text: msg.text.slice(0, 80) }, 'incoming message');

    // Log ALL WhatsApp messages to DB for dashboard visibility
    if (msg.channel === 'whatsapp') {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const content = (msg.text || '(מדיה)').substring(0, 2000);
      try {
        const { db: logDb } = await import('../utils/db.js');
        logDb.prepare(`INSERT INTO messages (channel, sender_id, sender_name, role, content, created_at) VALUES ('whatsapp-inbound', ?, ?, 'user', ?, ?)`)
          .run(msg.senderId, msg.senderName || msg.senderId, content, now);
      } catch { /* non-critical */ }
      // Sync user message to cloud dashboard
      syncToCloud([{ channel: 'whatsapp-inbound', sender_id: msg.senderId, sender_name: msg.senderName || msg.senderId, role: 'user', content, created_at: now }]).catch(() => {});
    }

    // Notify Alon on Telegram when a lead/non-Alon sends a WhatsApp message
    if (msg.channel === 'whatsapp' && !config.allowedWhatsApp.includes(msg.senderId)) {
      notifyLeadMessage(msg).catch(() => {});
    }

    // Push notification + WebSocket broadcast for all inbound WhatsApp messages
    if (msg.channel === 'whatsapp') {
      import('./server.js').then(({ sendPushNotification, wsBroadcast }) => {
        const payload = {
          title: msg.senderName || msg.senderId,
          body: (msg.text || '(מדיה)').slice(0, 200),
          phone: msg.senderId,
          tag: `wa-${msg.senderId}`,
        };
        sendPushNotification(payload);
        wsBroadcast({
          type: 'new_message',
          phone: msg.senderId,
          name: msg.senderName || msg.senderId,
          text: (msg.text || '(מדיה)').slice(0, 200),
          role: 'user',
          timestamp: new Date().toISOString(),
        });
      }).catch(() => {});
    }

    // Check for keyword workflows (fire-and-forget, don't block response)
    try {
      const matched = matchKeywordWorkflows(msg.text);
      for (const wf of matched) {
        log.info({ workflow: wf.name }, 'workflow triggered');
        executeWorkflowActions(wf.actions, { channel: msg.channel, targetId: msg.senderId }).catch(err =>
          log.error({ workflow: wf.name, err: err.message }, 'workflow error')
        );
      }
    } catch (e: any) { log.debug({ err: e.message }, 'workflow match failed'); }

    // Set up streaming if adapter supports it
    let streamCallback: StreamCallback | undefined;
    let streamMessageId: number | null = null;
    let accumulatedText = '';
    let lastEditTime = 0;
    const EDIT_INTERVAL = 1500; // ms between edits (Telegram rate limit friendly)

    if (adapter.sendStreamStart && adapter.editStreamMessage) {
      // Send initial placeholder
      streamMessageId = await adapter.sendStreamStart(msg, '...').catch(() => null);

      if (streamMessageId) {
        streamCallback = (text: string, toolName?: string) => {
          if (toolName) {
            // Tool notification
            const label = TOOL_LABELS[toolName] || `${toolName}...`;
            accumulatedText += `\n⚙️ _${label}_\n`;
          } else {
            accumulatedText += text;
          }

          // Throttle edits to avoid Telegram rate limits
          const now = Date.now();
          if (now - lastEditTime >= EDIT_INTERVAL && accumulatedText.length > 3) {
            lastEditTime = now;
            adapter.editStreamMessage!(msg, streamMessageId!, accumulatedText).catch(() => {});
          }
        };
      }
    }

    // Send typing indicator (only if not streaming)
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    if (!streamCallback && adapter.sendTyping) {
      typingInterval = setInterval(() => {
        adapter.sendTyping!(msg).catch(() => {});
      }, 4000);
      adapter.sendTyping(msg).catch(() => {});
    }

    try {
      const reply = await handleMessage(msg, streamCallback);
      if (typingInterval) clearInterval(typingInterval);

      if (streamMessageId && adapter.editStreamMessage) {
        // Final edit with complete text (including footer)
        await adapter.editStreamMessage(msg, streamMessageId, reply.text).catch(() => {});

        // Send media separately (image/voice/document can't be edited into text message)
        if (reply.document) {
          await adapter.sendReply(msg, { text: '', document: reply.document, documentName: reply.documentName, documentMimetype: reply.documentMimetype });
        }
        if (reply.image) {
          await adapter.sendReply(msg, { text: '', image: reply.image });
        }
        if (reply.voice) {
          await adapter.sendReply(msg, { text: '', voice: reply.voice });
        }
      } else {
        await adapter.sendReply(msg, reply);
      }
      log.info({ channel: msg.channel, chars: reply.text.length, streamed: !!streamCallback }, 'reply sent');

      // Log bot reply for ALL WhatsApp conversations (dashboard visibility)
      if (msg.channel === 'whatsapp') {
        const replyNow = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const replyContent = reply.text.substring(0, 2000);
        try {
          const { db } = await import('../utils/db.js');
          db.prepare(`INSERT INTO messages (channel, sender_id, role, content, created_at) VALUES ('whatsapp-inbound', ?, 'assistant', ?, ?)`)
            .run(msg.senderId, replyContent, replyNow);
        } catch { /* non-critical */ }
        // Sync bot reply to cloud dashboard
        syncToCloud([{ channel: 'whatsapp-inbound', sender_id: msg.senderId, role: 'assistant', content: replyContent, created_at: replyNow }]).catch(() => {});
        // WebSocket broadcast for bot reply
        import('./server.js').then(({ wsBroadcast }) => {
          wsBroadcast({
            type: 'new_message',
            phone: msg.senderId,
            name: 'Bot',
            text: replyContent.slice(0, 200),
            role: 'assistant',
            timestamp: replyNow,
          });
        }).catch(() => {});
      }

      // Monday.com sync for leads only
      if (msg.channel === 'whatsapp' && !config.allowedWhatsApp.includes(msg.senderId)) {
        // Sync chat to Monday.com (fire-and-forget)
        import('../utils/monday-leads.js').then(({ syncChatToMonday, extractLeadName, updateMondayItemName }) => {
          syncChatToMonday(msg.senderId, msg.text, reply.text).catch(() => {});

          // Auto-detect lead name if not set yet
          const name = extractLeadName(msg.text);
          if (name) {
            import('../utils/db.js').then(({ db: leadDb }) => {
              const lead = leadDb.prepare('SELECT name FROM leads WHERE phone = ?').get(msg.senderId) as any;
              if (lead && !lead.name) {
                updateMondayItemName(msg.senderId, name).catch(() => {});
              }
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    } catch (error: any) {
      if (typingInterval) clearInterval(typingInterval);
      log.error({ channel: msg.channel, err: error.message, stack: error.stack?.slice(0, 500) }, 'message handling error');
      try {
        if (streamMessageId && adapter.editStreamMessage) {
          await adapter.editStreamMessage(msg, streamMessageId, 'סליחה, קרתה שגיאה. נסה שוב בעוד כמה רגעים.');
        } else {
          await adapter.sendReply(msg, { text: 'סליחה, קרתה שגיאה. נסה שוב בעוד כמה רגעים.' });
        }
      } catch (e: any) { log.debug({ err: e.message }, 'error recovery failed'); }
    }
  });
}

export function getAdapter(name: string): ChannelAdapter | undefined {
  return adapters.get(name);
}

// Send a message through the agent (processes with Claude + tools)
export async function sendAgentMessage(channel: string, targetId: string, text: string) {
  const adapter = adapters.get(channel);
  if (!adapter) return;

  const fakeMsg: UnifiedMessage = {
    id: 'cron-agent',
    channel: channel as any,
    senderId: targetId,
    senderName: 'Alon',
    text,
    timestamp: Date.now(),
    raw: null,
  };

  try {
    const reply = await handleMessage(fakeMsg);
    // For cron messages, we need to send directly via bot API since raw is null
    await sendToChannel(channel, targetId, reply.text);
  } catch (error: any) {
    log.error({ err: error.message }, 'agent message error');
  }
}

// Notify Alon via Telegram when a lead messages on WhatsApp
async function notifyLeadMessage(msg: UnifiedMessage) {
  const targetId = config.allowedTelegram[0];
  if (!targetId || !config.telegramBotToken) return;
  try {
    const { db } = await import('../utils/db.js');
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(msg.senderId) as any;

    // Detect hot lead: responded to campaign, or first message from unknown number
    const isHot = !lead || lead.source === 'alon_dev_whatsapp' || lead.source === 'alon_dev' || lead.source === 'campaign';
    const isFirstReply = !lead || !db.prepare("SELECT 1 FROM messages WHERE channel = 'whatsapp-inbound' AND sender_id = ? AND role = 'user' LIMIT 1").get(msg.senderId);

    const hotTag = isHot && isFirstReply ? '🔥 ליד חם! תגובה ראשונה לקמפיין!\n' : '';
    const statusTag = lead?.lead_status ? `📋 סטטוס: ${lead.lead_status}\n` : '';

    const { Bot } = await import('grammy');
    const bot = new Bot(config.telegramBotToken);
    const preview = msg.text ? msg.text.slice(0, 200) : '(תמונה/קובץ/קולי)';
    await bot.api.sendMessage(Number(targetId),
      `📩 הודעת WhatsApp חדשה!\n${hotTag}\n👤 ${msg.senderName || msg.senderId}\n${statusTag}💬 ${preview}`
    );
  } catch (e: any) {
    log.debug({ err: e.message }, 'lead notification failed');
  }

  // User message logging is now handled centrally in registerAdapter (all WhatsApp messages)
}

export async function sendToChannel(channel: string, targetId: string, text: string) {
  const adapter = adapters.get(channel);
  if (!adapter) {
    log.warn({ channel }, 'no adapter for channel');
    return;
  }

  const fakeMsg: UnifiedMessage = {
    id: 'cron',
    channel: channel as any,
    senderId: targetId,
    senderName: '',
    text: '',
    timestamp: Date.now(),
    raw: null,
  };

  await adapter.sendReply(fakeMsg, { text });
}
