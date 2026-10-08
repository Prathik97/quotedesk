import { afterEach, describe, expect, it, vi } from 'vitest';
import { budgetSessionId, dailySessionId, istDate, uuidFromName } from './session';

describe('budget session id', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the Indian calendar date', () => {
    expect(istDate(new Date('2026-10-08T18:29:00Z'))).toBe('2026-10-08');
    expect(istDate(new Date('2026-10-08T18:31:00Z'))).toBe('2026-10-09');
  });

  it('is the same uuid for every instance on the same day, and different on another day', () => {
    const a = dailySessionId(new Date('2026-10-08T05:00:00Z'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(dailySessionId(new Date('2026-10-08T12:00:00Z'))).toBe(a);
    expect(dailySessionId(new Date('2026-10-09T05:00:00Z'))).not.toBe(a);
    expect(uuidFromName('x')).toBe(uuidFromName('x'));
  });

  it('on Vercel it depends on the date only, never on a file', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('QD_BUDGET_SESSION', '');
    expect(budgetSessionId()).toBe(dailySessionId());
  });

  it('an explicit QD_BUDGET_SESSION wins', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('QD_BUDGET_SESSION', '11111111-1111-4111-8111-111111111111');
    expect(budgetSessionId()).toBe('11111111-1111-4111-8111-111111111111');
  });
});
