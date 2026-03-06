import type { ChannelAdapter, UnifiedMessage } from '../channels/types.js';
import { handleMessage, type StreamCallback } from '../agent/agent.js';
import { matchKeywordWorkflows } from '../agent/workflows.js';
import { executeWorkflowActions } from '../agent/tools.js';

const adapters = new Map<string, ChannelAdapter>();

// Tool name → Hebrew label for streaming display
const TOOL_LABELS: Record<string, string> = {
  web_search: 'מחפש באינטרנט...',
  web_research: 'עושה מחקר...',
  browse_url: 'קורא דף אינטרנט...',
  analyze_image: 'מנתח תמונה...',
  generate_image: 'יוצר תמונה...',
  remember: 'שומר לזיכרון...',
  monday_api: 'שולף נתונים מ-Monday...',
  shell: 'מריץ פקודה...',
  send_email: 'שולח מייל...',
};

export function registerAdapter(adapter: ChannelAdapter) {
  adapters.set(adapter.name, adapter);

  adapter.onMessage(async (msg: UnifiedMessage) => {
    console.log(`[${msg.channel}] ${msg.senderName}: ${msg.text.slice(0, 80)}`);

    // Check for keyword workflows (fire-and-forget, don't block response)
    try {
      const matched = matchKeywordWorkflows(msg.text);
      for (const wf of matched) {
        console.log(`[Workflow] Triggered: "${wf.name}"`);
        executeWorkflowActions(wf.actions, { channel: msg.channel, targetId: msg.senderId }).catch(err =>
          console.error(`[Workflow] ${wf.name} error:`, err.message)
        );
      }
    } catch {}

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

        // Send media separately (image/voice can't be edited into text message)
        if (reply.image) {
          await adapter.sendReply(msg, { text: '', image: reply.image });
        }
        if (reply.voice) {
          await adapter.sendReply(msg, { text: '', voice: reply.voice });
        }
      } else {
        await adapter.sendReply(msg, reply);
      }
      console.log(`[${msg.channel}] Reply sent (${reply.text.length} chars${streamCallback ? ', streamed' : ''})`);
    } catch (error: any) {
      if (typingInterval) clearInterval(typingInterval);
      console.error(`[${msg.channel}] Error:`, error.message, error.stack?.slice(0, 500));
      try {
        if (streamMessageId && adapter.editStreamMessage) {
          await adapter.editStreamMessage(msg, streamMessageId, 'סליחה, קרתה שגיאה. נסה שוב בעוד כמה רגעים.');
        } else {
          await adapter.sendReply(msg, { text: 'סליחה, קרתה שגיאה. נסה שוב בעוד כמה רגעים.' });
        }
      } catch {}
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
    console.error(`[Router] Agent message error:`, error.message);
  }
}

export async function sendToChannel(channel: string, targetId: string, text: string) {
  const adapter = adapters.get(channel);
  if (!adapter) {
    console.warn(`[Router] No adapter for channel: ${channel}`);
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
