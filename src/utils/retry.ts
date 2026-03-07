import { createLogger } from './logger.js';

const log = createLogger('retry');

interface RetryOptions {
  maxRetries?: number;    // default: 3
  baseDelay?: number;     // default: 1000ms
  maxDelay?: number;      // default: 10000ms
  retryOn?: (error: any) => boolean;  // which errors to retry
}

const DEFAULT_RETRY_ON = (err: any): boolean => {
  // Retry on network errors and 5xx/429 status codes
  if (!err) return false;
  const status = err.status || err.statusCode;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') return true;
  if (err.message?.includes('fetch failed') || err.message?.includes('network')) return true;
  return false;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, baseDelay = 1000, maxDelay = 10000, retryOn = DEFAULT_RETRY_ON } = options;

  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt === maxRetries || !retryOn(err)) throw err;
      const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, maxDelay);
      log.warn({ attempt: attempt + 1, maxRetries, err: err.message, delay: Math.round(delay) }, 'retrying');
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}
