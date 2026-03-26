import { describe, expect, it } from '@jest/globals';

import {
  formatResponsePresetLabel,
  getCanonicalResponseMode,
  getMonitorResponsePolicy,
  requiresManualInvestigationOverride,
  validateResponsePreset,
} from '../src/monitor/response-mode.js';

describe('monitor response-mode contract', () => {
  it('defines monitor_only as a non-dispatching mode', () => {
    const policy = getMonitorResponsePolicy('monitor_only');

    expect(policy.autoDispatch).toBe(false);
    expect(policy.allowedActions.size).toBe(0);
    expect(policy.allowFallbackRepairInjection).toBe(false);
  });

  it('keeps triage_only read-only', () => {
    const policy = getMonitorResponsePolicy('triage_only');

    expect(policy.autoDispatch).toBe(true);
    expect(policy.allowedActions.has('query_db')).toBe(true);
    expect(policy.allowedActions.has('report_only')).toBe(true);
    expect(policy.allowedActions.has('reset_task')).toBe(false);
  });

  it('requires a custom prompt for custom mode', () => {
    expect(validateResponsePreset('custom', null)).toContain('requires a non-empty custom prompt');
    expect(validateResponsePreset('custom', 'Investigate politely.')).toBeNull();
  });

  it('maps legacy presets to the canonical triage family for UI purposes', () => {
    expect(getCanonicalResponseMode('investigate_and_stop')).toBe('triage_only');
    expect(getCanonicalResponseMode('stop_on_error')).toBe('triage_only');
    expect(formatResponsePresetLabel('investigate_and_stop')).toContain('legacy');
  });

  it('requires an explicit manual override when config is monitor_only', () => {
    expect(requiresManualInvestigationOverride('monitor_only')).toBe(true);
    expect(requiresManualInvestigationOverride('triage_only')).toBe(false);
  });
});
