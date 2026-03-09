import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendWithTyping, _resetLastSendTime } from '../rate-limiter.js';

function createMockSocket() {
  return {
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('rate-limiter', () => {
  beforeEach(() => {
    _resetLastSendTime();
  });

  it('sends message with typing indicator', async () => {
    const sock = createMockSocket();
    const jid = '972501234567@s.whatsapp.net';
    const text = 'Hello';

    await sendWithTyping(sock, jid, text);

    // Should have sent composing presence
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('composing', jid);
    // Should have sent the message
    expect(sock.sendMessage).toHaveBeenCalledWith(jid, { text });
    // Should have sent paused presence after
    expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('paused', jid);
  });

  it('typing duration scales with message length', async () => {
    const sock = createMockSocket();
    const jid = '972501234567@s.whatsapp.net';

    // Short message (2 chars) -> typing = min(1000 + 2*20, 3000) = 1040ms
    const shortStart = Date.now();
    await sendWithTyping(sock, jid, 'Hi');
    const shortDuration = Date.now() - shortStart;

    // Reset to avoid rate limit delay affecting measurement
    _resetLastSendTime();

    // Long message (100 chars) -> typing = min(1000 + 100*20, 3000) = 3000ms
    const longSock = createMockSocket();
    const longText = 'x'.repeat(100);
    const longStart = Date.now();
    await sendWithTyping(longSock, jid, longText);
    const longDuration = Date.now() - longStart;

    // Long message should take noticeably longer than short
    expect(longDuration).toBeGreaterThan(shortDuration);
  });

  it('enforces minimum delay between sequential sends', async () => {
    const sock = createMockSocket();
    const jid = '972501234567@s.whatsapp.net';

    const start = Date.now();
    await sendWithTyping(sock, jid, 'First');
    await sendWithTyping(sock, jid, 'Second');
    const totalDuration = Date.now() - start;

    // Second call must wait at least 3000ms from first send.
    // First call typing ~ 1100ms, then rate limit wait >= 3000ms for second call.
    expect(totalDuration).toBeGreaterThanOrEqual(3000);
  }, 15000);

  it('caps typing duration at 3000ms', async () => {
    const sock = createMockSocket();
    const jid = '972501234567@s.whatsapp.net';

    // Very long message - typing should cap at 3000ms
    const veryLongText = 'x'.repeat(500);
    const start = Date.now();
    await sendWithTyping(sock, jid, veryLongText);
    const duration = Date.now() - start;

    // First call has no rate limit wait, so duration = typing (3000ms cap) + overhead
    expect(duration).toBeGreaterThanOrEqual(2900);
    expect(duration).toBeLessThan(4500);
    expect(sock.sendMessage).toHaveBeenCalled();
  });
});
