import { createLogger } from '../utils/logger.js';

const log = createLogger('message-batcher');

const pendingBatches = new Map<
  string,
  { timer: NodeJS.Timeout; messages: string[] }
>();

/**
 * Add a message to the per-phone batch.
 * After 8 seconds of silence from that phone, onBatchReady fires with all collected messages.
 * Timer resets on each new message.
 */
export function addMessageToBatch(
  phone: string,
  text: string,
  onBatchReady: (phone: string, messages: string[]) => void,
): void {
  const existing = pendingBatches.get(phone);

  if (existing) {
    clearTimeout(existing.timer);
    existing.messages.push(text);
  } else {
    pendingBatches.set(phone, { timer: null as unknown as NodeJS.Timeout, messages: [text] });
  }

  const batch = pendingBatches.get(phone)!;

  batch.timer = setTimeout(() => {
    const messages = [...batch.messages];
    pendingBatches.delete(phone);
    log.info({ phone, messageCount: messages.length }, 'batch ready');
    onBatchReady(phone, messages);
  }, 8000);
}

/**
 * Get the number of phones with pending batches (for monitoring).
 */
export function getPendingCount(): number {
  return pendingBatches.size;
}

/**
 * Clear all pending batches and timers (for testing/cleanup).
 */
export function clearAllBatches(): void {
  for (const [, batch] of pendingBatches) {
    clearTimeout(batch.timer);
  }
  pendingBatches.clear();
}
