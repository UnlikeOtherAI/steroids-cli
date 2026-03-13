import { describe, expect, it } from '@jest/globals';

import {
  EVENT_DESCRIPTIONS,
  HOOK_EVENTS,
  INTAKE_EVENTS,
  getEventsByCategory,
  isIntakeEvent,
  isValidHookEvent,
  type HookEvent,
} from '../src/hooks/events.js';

describe('Intake hook events', () => {
  it('includes the intake hook names in HOOK_EVENTS', () => {
    expect(HOOK_EVENTS).toContain('intake.received');
    expect(HOOK_EVENTS).toContain('intake.triaged');
    expect(HOOK_EVENTS).toContain('intake.pr_created');
  });

  it('groups intake events in the intake category', () => {
    expect([...INTAKE_EVENTS]).toEqual([
      'intake.received',
      'intake.triaged',
      'intake.pr_created',
    ]);
    expect(getEventsByCategory().intake).toEqual([
      'intake.received',
      'intake.triaged',
      'intake.pr_created',
    ]);
  });

  it('publishes descriptions for all intake events', () => {
    expect(EVENT_DESCRIPTIONS['intake.received']).toBeDefined();
    expect(EVENT_DESCRIPTIONS['intake.triaged']).toBeDefined();
    expect(EVENT_DESCRIPTIONS['intake.pr_created']).toBeDefined();
  });
});

describe('Intake hook event guards', () => {
  it('accepts valid intake event names', () => {
    expect(isValidHookEvent('intake.received')).toBe(true);
    expect(isValidHookEvent('intake.triaged')).toBe(true);
    expect(isValidHookEvent('intake.pr_created')).toBe(true);
  });

  it('rejects invalid intake-like names', () => {
    expect(isValidHookEvent('intake.created')).toBe(false);
  });

  it('matches only intake events in isIntakeEvent', () => {
    expect(isIntakeEvent('intake.received')).toBe(true);
    expect(isIntakeEvent('intake.triaged')).toBe(true);
    expect(isIntakeEvent('task.created' as HookEvent)).toBe(false);
  });
});
