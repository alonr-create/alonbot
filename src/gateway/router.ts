import type { ChannelAdapter, UnifiedMessage } from '../channels/types.js';
import { handleMessage } from '../agent/agent.js';

const adapters = new Map<string, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter) {
  adapters.set(adapter.name, adapter);

  adapter.onMessage(async (msg: UnifiedMessage) => {
    console.log(`[${msg.channel}] ${msg.senderName}: ${msg.text.slice(0, 80)}`);

    // Send typing indicator
    if (adapter.sendTyping) {
      const typingInterval = setInterval(() => {
        adapter.sendTyping!(msg).catch(() => {});
      }, 4000);
      adapter.sendTyping(msg).catch(() => {});

      try {
        const reply = await handleMessage(msg);
        clearInterval(typingInterval);
        await adapter.sendReply(msg, reply);
        console.log(`[${msg.channel}] Reply sent (${reply.text.length} chars)`);
      } catch (error: any) {
        clearInterval(typingInterval);
        console.error(`[${msg.channel}] Error:`, error.message);
        try {
          await adapter.sendReply(msg, { text: 'סליחה, קרתה שגיאה. נסה שוב.' });
        } catch {}
      }
    } else {
      try {
        const reply = await handleMessage(msg);
        await adapter.sendReply(msg, reply);
        console.log(`[${msg.channel}] Reply sent (${reply.text.length} chars)`);
      } catch (error: any) {
        console.error(`[${msg.channel}] Error:`, error.message);
        try {
          await adapter.sendReply(msg, { text: 'סליחה, קרתה שגיאה. נסה שוב.' });
        } catch {}
      }
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
