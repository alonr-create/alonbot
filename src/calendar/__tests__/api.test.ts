import { describe, it, expect, vi, afterEach } from 'vitest';

describe('getAvailableSlots', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('fetches from Apps Script with ?action=freeBusy&days=N', async () => {
    process.env.GOOGLE_CALENDAR_SCRIPT_URL = 'https://script.google.com/test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          slots: [
            { date: '2026-03-10', time: '10:00', dayName: 'Tuesday' },
            { date: '2026-03-10', time: '14:00', dayName: 'Tuesday' },
          ],
        }),
    });

    const { getAvailableSlots } = await import('../api.js');
    const slots = await getAvailableSlots(3);

    expect(slots).toHaveLength(2);
    expect(slots[0]).toEqual({ date: '2026-03-10', time: '10:00', dayName: 'Tuesday' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://script.google.com/test?action=freeBusy&days=3',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    delete process.env.GOOGLE_CALENDAR_SCRIPT_URL;
  });

  it('returns empty array when GOOGLE_CALENDAR_SCRIPT_URL not configured', async () => {
    delete process.env.GOOGLE_CALENDAR_SCRIPT_URL;
    const { getAvailableSlots } = await import('../api.js');
    const slots = await getAvailableSlots();
    expect(slots).toEqual([]);
  });

  it('returns empty array on fetch error (never throws)', async () => {
    process.env.GOOGLE_CALENDAR_SCRIPT_URL = 'https://script.google.com/test';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const { getAvailableSlots } = await import('../api.js');
    const slots = await getAvailableSlots();
    expect(slots).toEqual([]);
    delete process.env.GOOGLE_CALENDAR_SCRIPT_URL;
  });
});

describe('bookMeeting', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('posts to Apps Script with action=add and returns BookingResult', async () => {
    process.env.GOOGLE_CALENDAR_SCRIPT_URL = 'https://script.google.com/test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ success: true, eventId: 'evt-123' }),
    });

    const { bookMeeting } = await import('../api.js');
    const result = await bookMeeting('2026-03-10', '10:00', 'Test Lead', '054-123-4567', 'website', 'Wants a website');

    expect(result.success).toBe(true);
    expect(result.eventId).toBe('evt-123');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://script.google.com/test?'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    delete process.env.GOOGLE_CALENDAR_SCRIPT_URL;
  });

  it('returns {success: false} on network error (never throws)', async () => {
    process.env.GOOGLE_CALENDAR_SCRIPT_URL = 'https://script.google.com/test';
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const { bookMeeting } = await import('../api.js');
    const result = await bookMeeting('2026-03-10', '10:00', 'Test', '054', 'web', 'summary');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    delete process.env.GOOGLE_CALENDAR_SCRIPT_URL;
  });
});
