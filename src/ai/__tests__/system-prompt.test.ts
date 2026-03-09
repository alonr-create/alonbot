import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock calendar modules before importing system-prompt
vi.mock('../../calendar/business-hours.js', () => ({
  isBusinessHours: () => false,
  formatIsraelTime: () => 'יום ראשון 10:00',
}));

vi.mock('../../calendar/api.js', () => ({
  getAvailableSlots: async () => [],
}));

import { buildSystemPrompt } from '../system-prompt.js';

describe('buildSystemPrompt', () => {
  let prompt: string;

  beforeAll(async () => {
    prompt = await buildSystemPrompt('דוד', 'אתר לעסק');
  });

  it('includes all service categories', () => {
    expect(prompt).toContain('Landing');
    expect(prompt).toContain('אתרים');
    expect(prompt).toContain('אפליקציות');
    expect(prompt).toContain('משחקים');
    expect(prompt).toContain('אוטומציה');
    expect(prompt).toContain('CRM');
    expect(prompt).toContain('שיווק');
    expect(prompt).toContain('SEO');
  });

  it('includes all price ranges', () => {
    expect(prompt).toContain('2,000');
    expect(prompt).toContain('5,000');
    expect(prompt).toContain('15,000');
    expect(prompt).toContain('50,000');
    expect(prompt).toContain('10,000');
    expect(prompt).toContain('40,000');
    expect(prompt).toContain('20,000');
    expect(prompt).toContain('60,000');
    expect(prompt).toContain('3,000');
    expect(prompt).toContain('8,000');
    expect(prompt).toContain('30,000');
  });

  it('interpolates lead name and interest', () => {
    expect(prompt).toContain('דוד');
    expect(prompt).toContain('אתר לעסק');
  });

  it('includes price guardrail instructions', () => {
    expect(prompt).toMatch(/מינימום|מתחת/);
    expect(prompt).toMatch(/מקסימום|מעל/);
  });

  it('sets aggressive sales personality', () => {
    expect(prompt).toMatch(/דחיפות|urgency|מכירות|sales/i);
  });

  it('mentions Alon as solo entrepreneur with AI', () => {
    expect(prompt).toContain('Alon');
    expect(prompt).toMatch(/AI/);
  });

  it('handles empty name gracefully', async () => {
    const p = await buildSystemPrompt('', 'website');
    expect(p).toBeDefined();
    expect(p.length).toBeGreaterThan(100);
  });

  it('handles media message instructions', () => {
    expect(prompt).toMatch(/מדיה|תמונ|קול|media/i);
  });

  it('includes business hours context', () => {
    expect(prompt).toContain('שעות פעילות');
    expect(prompt).toContain('יום ראשון 10:00');
  });

  it('includes escalation marker instructions', () => {
    expect(prompt).toContain('[ESCALATE]');
    expect(prompt).toContain('[BOOK:');
  });
});
