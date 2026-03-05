import type { ChannelAdapter, UnifiedMessage } from '../channels/types.js';
import { handleMessage } from '../agent/agent.js';

const adapters = new Map<string, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter) {
  adapters.set(adapter.name, adapter);

  adapter.onMessage(async (msg: UnifiedMessage) => {
    console.log(`[${msg.channel}] ${msg.senderName}: ${msg.text.slice(0, 80)}`);

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
  });
}

export function getAdapter(name: string): ChannelAdapter | undefined {
  return adapters.get(name);
}

export async function sendToChannel(channel: string, targetId: string, text: string) {
  const adapter = adapters.get(channel);
  if (!adapter) {
    console.warn(`[Router] No adapter for channel: ${channel}`);
    return;
  }

  // Create a fake message to use sendReply
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
