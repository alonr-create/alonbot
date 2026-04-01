import { sleep } from '../utils/delay.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('rate-limiter');

const lastSendTimes = new Map<string, number>();

/**
 * Send a WhatsApp message with rate limiting and typing simulation.
 * Enforces 3-5 second minimum delay between sends per recipient (JID)
 * and shows typing indicator scaled by message length (1-3 seconds).
 */
export async function sendWithTyping(
  sock: any,
  jid: string,
  text: string
): Promise<void> {
  // Enforce rate limit per JID: 3-5 seconds between sends
  const now = Date.now();
  const lastSendTime = lastSendTimes.get(jid) || 0;
  const elapsed = now - lastSendTime;
  const minWait = 3000 + Math.random() * 2000; // 3000-5000ms

  if (lastSendTime > 0 && elapsed < minWait) {
    const waitTime = minWait - elapsed;
    log.debug({ waitTime: Math.round(waitTime), jid }, 'rate limit delay');
    await sleep(waitTime);
  }

  // Typing indicator scaled by message length: min 1000ms, max 3000ms
  const typingDuration = Math.min(1000 + text.length * 20, 3000);
  await sock.sendPresenceUpdate('composing', jid);
  await sleep(typingDuration);

  // Send the message
  await sock.sendMessage(jid, { text });
  lastSendTimes.set(jid, Date.now());

  log.debug({ jid, length: text.length, typingDuration }, 'message sent');

  // Clear typing indicator
  await sock.sendPresenceUpdate('paused', jid);
}

/**
 * Reset rate limiter state (for testing).
 */
export function _resetLastSendTime(): void {
  lastSendTimes.clear();
}
