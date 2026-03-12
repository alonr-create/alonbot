import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('fetchMondayItem', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses GraphQL response and returns name, phone, interest', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            items: [
              {
                name: 'Test Lead',
                column_values: [
                  { id: 'phone', text: '054-630-0783' },
                  { id: 'service', text: 'Website Development' },
                ],
              },
            ],
          },
        }),
    });

    const { fetchMondayItem } = await import('../api.js');
    const item = await fetchMondayItem(12345);

    expect(item).toEqual({
      name: 'Test Lead',
      phone: '054-630-0783',
      interest: 'Website Development',
      source: '',
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });
});

describe('updateMondayStatus', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends correct mutation to Monday.com', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    });

    const { updateMondayStatus } = await import('../api.js');
    await updateMondayStatus(123, 456, 'contacted');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('does not throw on API error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const { updateMondayStatus } = await import('../api.js');
    await expect(
      updateMondayStatus(123, 456, 'contacted'),
    ).resolves.not.toThrow();
  });
});
