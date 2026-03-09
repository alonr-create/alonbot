import { describe, it, expect } from 'vitest';
import { isBusinessHours, getNextBusinessDay, formatIsraelTime } from '../business-hours.js';

describe('isBusinessHours', () => {
  // Israel Standard Time is UTC+2, Israel Daylight Time is UTC+3
  // March 2026: Israel is in IST (UTC+2) — clocks spring forward March 27, 2026

  it('returns true for Sunday 10:00 Israel time', () => {
    // Sunday March 8 2026, 10:00 IST = 08:00 UTC
    const date = new Date('2026-03-08T08:00:00.000Z');
    expect(isBusinessHours(date)).toBe(true);
  });

  it('returns true for Thursday 17:00 Israel time', () => {
    // Thursday March 12 2026, 17:00 IST = 15:00 UTC
    const date = new Date('2026-03-12T15:00:00.000Z');
    expect(isBusinessHours(date)).toBe(true);
  });

  it('returns true for Friday 12:00 Israel time', () => {
    // Friday March 13 2026, 12:00 IST = 10:00 UTC
    const date = new Date('2026-03-13T10:00:00.000Z');
    expect(isBusinessHours(date)).toBe(true);
  });

  it('returns false for Friday 14:00 Israel time', () => {
    // Friday March 13 2026, 14:00 IST = 12:00 UTC
    const date = new Date('2026-03-13T12:00:00.000Z');
    expect(isBusinessHours(date)).toBe(false);
  });

  it('returns false for Saturday any time', () => {
    // Saturday March 14 2026, 12:00 IST = 10:00 UTC
    const date = new Date('2026-03-14T10:00:00.000Z');
    expect(isBusinessHours(date)).toBe(false);
  });

  it('returns false before 09:00 Israel time', () => {
    // Sunday March 8 2026, 08:00 IST = 06:00 UTC
    const date = new Date('2026-03-08T06:00:00.000Z');
    expect(isBusinessHours(date)).toBe(false);
  });

  it('returns false after 18:00 Israel time on weekday', () => {
    // Monday March 9 2026, 19:00 IST = 17:00 UTC
    const date = new Date('2026-03-09T17:00:00.000Z');
    expect(isBusinessHours(date)).toBe(false);
  });
});

describe('getNextBusinessDay', () => {
  it('from Friday 14:00 returns Sunday 09:00', () => {
    // Friday March 13 2026, 14:00 IST = 12:00 UTC
    const from = new Date('2026-03-13T12:00:00.000Z');
    const next = getNextBusinessDay(from);
    // Should be Sunday March 15 2026, 09:00 IST = 07:00 UTC
    expect(next.toISOString()).toBe('2026-03-15T07:00:00.000Z');
  });

  it('from Saturday returns Sunday 09:00', () => {
    // Saturday March 14 2026, 12:00 IST = 10:00 UTC
    const from = new Date('2026-03-14T10:00:00.000Z');
    const next = getNextBusinessDay(from);
    // Should be Sunday March 15 2026, 09:00 IST = 07:00 UTC
    expect(next.toISOString()).toBe('2026-03-15T07:00:00.000Z');
  });
});

describe('formatIsraelTime', () => {
  it('returns Hebrew-formatted current time string', () => {
    const date = new Date('2026-03-08T08:00:00.000Z');
    const result = formatIsraelTime(date);
    // Should contain Hebrew weekday and time
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    // Should contain a time-like pattern (HH:MM)
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});
