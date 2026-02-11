/**
 * Hook Events — Credit event runtime paths
 *
 * Tests isCreditEvent type guard and credit entries in HOOK_EVENTS,
 * CREDIT_EVENTS, EVENT_DESCRIPTIONS, and getEventsByCategory().
 */

import { describe, it, expect } from '@jest/globals';
import {
  HOOK_EVENTS,
  CREDIT_EVENTS,
  EVENT_DESCRIPTIONS,
  isValidHookEvent,
  isCreditEvent,
  getEventsByCategory,
  type HookEvent,
} from '../src/hooks/events.js';

describe('Credit hook events', () => {
  it('includes credit.exhausted in HOOK_EVENTS', () => {
    expect(HOOK_EVENTS).toContain('credit.exhausted');
  });

  it('includes credit.resolved in HOOK_EVENTS', () => {
    expect(HOOK_EVENTS).toContain('credit.resolved');
  });

  it('CREDIT_EVENTS contains exactly the two credit events', () => {
    expect([...CREDIT_EVENTS]).toEqual(['credit.exhausted', 'credit.resolved']);
  });

  it('has descriptions for both credit events', () => {
    expect(EVENT_DESCRIPTIONS['credit.exhausted']).toBeDefined();
    expect(EVENT_DESCRIPTIONS['credit.resolved']).toBeDefined();
  });
});

describe('isValidHookEvent — credit events', () => {
  it('returns true for credit.exhausted', () => {
    expect(isValidHookEvent('credit.exhausted')).toBe(true);
  });

  it('returns true for credit.resolved', () => {
    expect(isValidHookEvent('credit.resolved')).toBe(true);
  });

  it('returns false for credit.unknown', () => {
    expect(isValidHookEvent('credit.unknown')).toBe(false);
  });
});

describe('isCreditEvent', () => {
  it('returns true for credit.exhausted', () => {
    expect(isCreditEvent('credit.exhausted')).toBe(true);
  });

  it('returns true for credit.resolved', () => {
    expect(isCreditEvent('credit.resolved')).toBe(true);
  });

  it('returns false for task.created', () => {
    expect(isCreditEvent('task.created' as HookEvent)).toBe(false);
  });

  it('returns false for health.changed', () => {
    expect(isCreditEvent('health.changed' as HookEvent)).toBe(false);
  });
});

describe('getEventsByCategory — credit category', () => {
  it('includes a credit category with both credit events', () => {
    const categories = getEventsByCategory();
    expect(categories.credit).toBeDefined();
    expect(categories.credit).toEqual(['credit.exhausted', 'credit.resolved']);
  });
});
