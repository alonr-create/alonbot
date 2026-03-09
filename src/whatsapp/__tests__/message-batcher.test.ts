import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addMessageToBatch, getPendingCount, clearAllBatches } from '../message-batcher.js';

describe('message-batcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllBatches();
  });

  afterEach(() => {
    clearAllBatches();
    vi.useRealTimers();
  });

  it('triggers callback after 8 seconds for single message', () => {
    const callback = vi.fn();
    addMessageToBatch('972501234567', 'hello', callback);

    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8000);
    expect(callback).toHaveBeenCalledWith('972501234567', ['hello']);
  });

  it('batches multiple messages within 8 seconds', () => {
    const callback = vi.fn();
    addMessageToBatch('972501234567', 'msg1', callback);
    vi.advanceTimersByTime(3000);
    addMessageToBatch('972501234567', 'msg2', callback);
    vi.advanceTimersByTime(3000);
    addMessageToBatch('972501234567', 'msg3', callback);

    // Only 6 seconds since last message, should not fire yet
    vi.advanceTimersByTime(6000);
    expect(callback).not.toHaveBeenCalled();

    // 8 seconds after last message
    vi.advanceTimersByTime(2000);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith('972501234567', ['msg1', 'msg2', 'msg3']);
  });

  it('resets timer on each new message', () => {
    const callback = vi.fn();
    addMessageToBatch('972501234567', 'first', callback);
    vi.advanceTimersByTime(7000); // 7 seconds
    addMessageToBatch('972501234567', 'second', callback);
    vi.advanceTimersByTime(7000); // 7 seconds since 'second'
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); // 8 seconds since 'second'
    expect(callback).toHaveBeenCalledWith('972501234567', ['first', 'second']);
  });

  it('handles different phones independently', () => {
    const callback = vi.fn();
    addMessageToBatch('972501111111', 'phone1', callback);
    addMessageToBatch('972502222222', 'phone2', callback);

    expect(getPendingCount()).toBe(2);

    vi.advanceTimersByTime(8000);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledWith('972501111111', ['phone1']);
    expect(callback).toHaveBeenCalledWith('972502222222', ['phone2']);
  });

  it('clearAllBatches stops all timers', () => {
    const callback = vi.fn();
    addMessageToBatch('972501111111', 'msg', callback);
    addMessageToBatch('972502222222', 'msg', callback);

    expect(getPendingCount()).toBe(2);
    clearAllBatches();
    expect(getPendingCount()).toBe(0);

    vi.advanceTimersByTime(10000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('getPendingCount returns correct count', () => {
    const callback = vi.fn();
    expect(getPendingCount()).toBe(0);
    addMessageToBatch('972501111111', 'msg', callback);
    expect(getPendingCount()).toBe(1);
    addMessageToBatch('972502222222', 'msg', callback);
    expect(getPendingCount()).toBe(2);
  });
});
