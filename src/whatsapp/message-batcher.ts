import { createLogger } from '../utils/logger.js';

const log = createLogger('message-batcher');

const pendingBatches = new Map<
  string,
  { timer: NodeJS.Timeout; messages: string[] }
>();

// Track phones currently being processed by Claude to prevent duplicate responses
const processingPhones = new Set<string>();

// Messages that arrived while a phone was being processed — queued for next batch
const queuedMessages = new Map<string, string[]>();

/**
 * Add a message to the per-phone batch.
 * After 8 seconds of silence from that phone, onBatchReady fires with all collected messages.
 * Timer resets on each new message.
 * If a conversation is already being processed for this phone, messages are queued
 * and will be batched together after the current processing finishes.
 */
export function addMessageToBatch(
  phone: string,
  text: string,
  onBatchReady: (phone: string, messages: string[]) => void,
): void {
  // If this phone is currently being processed, queue the message
  if (processingPhones.has(phone)) {
    const queued = queuedMessages.get(phone) || [];
    queued.push(text);
    queuedMessages.set(phone, queued);
    log.info({ phone, queuedCount: queued.length }, 'message queued (conversation in progress)');
    return;
  }

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

    // Mark as processing
    processingPhones.add(phone);

    // Wrap callback to handle processing lock
    const wrappedCallback = async (batchPhone: string, batchMessages: string[]) => {
      try {
        await onBatchReady(batchPhone, batchMessages);
      } finally {
        processingPhones.delete(batchPhone);

        // Check if messages were queued while processing
        const queued = queuedMessages.get(batchPhone);
        if (queued && queued.length > 0) {
          queuedMessages.delete(batchPhone);
          log.info({ phone: batchPhone, queuedCount: queued.length }, 'processing queued messages');
          // Re-batch queued messages
          for (const queuedMsg of queued) {
            addMessageToBatch(batchPhone, queuedMsg, onBatchReady);
          }
        }
      }
    };

    wrappedCallback(phone, messages);
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
  processingPhones.clear();
  queuedMessages.clear();
}
