import type { ChannelAdapter, UnifiedMessage } from '../channels/types.js';
import { handleMessage, type StreamCallback } from '../agent/agent.js';
import { matchKeywordWorkflows } from '../agent/workflows.js';
import { executeWorkflowActions } from '../agent/tools.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('router');

const adapters = new Map<string, ChannelAdapter>();

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
    log.info({ channel: msg.channel, sender: msg.senderName, text: msg.text.slice(0, 80) }, 'incoming message');

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
