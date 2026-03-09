import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../ai/claude-client.js', () => ({
  generateResponse: vi.fn().mockResolvedValue(
    '1. רוצה אתר לעסק\n2. תקציב סביב 5000 ש"ח\n3. מודאג מלוחות זמנים',
  ),
}));

describe('generateEscalationSummary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls Claude with conversation history and summary prompt', async () => {
    const { generateEscalationSummary } = await import('../summary.js');
    const { generateResponse } = await import('../../ai/claude-client.js');

    const messages = [
      { role: 'user' as const, content: 'I want a website' },
      { role: 'assistant' as const, content: 'What kind of website?' },
      { role: 'user' as const, content: 'E-commerce, budget around 5000' },
    ];

    const result = await generateEscalationSummary(messages, 'Test Lead');

    expect(generateResponse).toHaveBeenCalledWith(
      expect.any(Array),
      expect.stringContaining('סיכום'),
    );
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns 3-line summary format', async () => {
    const { generateEscalationSummary } = await import('../summary.js');

    const result = await generateEscalationSummary(
      [{ role: 'user', content: 'test' }],
      'Test Lead',
    );

    // Should contain line breaks (3-line format)
    expect(result.split('\n').length).toBeGreaterThanOrEqual(3);
  });
});
