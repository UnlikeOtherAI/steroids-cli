/**
 * Hook Payload — Credit payload factory and validation runtime paths
 *
 * Tests createCreditExhaustedPayload, createCreditResolvedPayload,
 * and validatePayload for credit event payloads.
 */

import { describe, it, expect } from '@jest/globals';
import {
  createCreditExhaustedPayload,
  createCreditResolvedPayload,
  validatePayload,
  type CreditData,
  type ProjectContext,
} from '../src/hooks/payload.js';

const sampleCredit: CreditData = {
  provider: 'claude',
  model: 'claude-sonnet-4',
  role: 'coder',
  message: 'Insufficient credits',
  runner_id: 'runner-1',
};

const sampleProject: ProjectContext = {
  name: 'my-project',
  path: '/tmp/my-project',
};

describe('createCreditExhaustedPayload', () => {
  it('returns a payload with event credit.exhausted', () => {
    const payload = createCreditExhaustedPayload(sampleCredit, sampleProject);
    expect(payload.event).toBe('credit.exhausted');
  });

  it('includes credit data and project context', () => {
    const payload = createCreditExhaustedPayload(sampleCredit, sampleProject);
    expect(payload.credit).toEqual(sampleCredit);
    expect(payload.project).toEqual(sampleProject);
  });

  it('includes a valid ISO 8601 timestamp', () => {
    const payload = createCreditExhaustedPayload(sampleCredit, sampleProject);
    expect(payload.timestamp).toBeDefined();
    expect(() => new Date(payload.timestamp)).not.toThrow();
    expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
  });
});

describe('createCreditResolvedPayload', () => {
  it('returns a payload with event credit.resolved', () => {
    const payload = createCreditResolvedPayload(sampleCredit, sampleProject, 'config_changed');
    expect(payload.event).toBe('credit.resolved');
  });

  it('includes resolution field', () => {
    const payload = createCreditResolvedPayload(sampleCredit, sampleProject, 'config_changed');
    expect(payload.resolution).toBe('config_changed');
  });

  it('includes credit data and project context', () => {
    const payload = createCreditResolvedPayload(sampleCredit, sampleProject, 'config_changed');
    expect(payload.credit).toEqual(sampleCredit);
    expect(payload.project).toEqual(sampleProject);
  });
});

describe('validatePayload — credit payloads', () => {
  it('validates a well-formed credit.exhausted payload', () => {
    const payload = createCreditExhaustedPayload(sampleCredit, sampleProject);
    const result = validatePayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates a well-formed credit.resolved payload', () => {
    const payload = createCreditResolvedPayload(sampleCredit, sampleProject, 'config_changed');
    const result = validatePayload(payload);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports error when credit.provider is missing', () => {
    const bad = createCreditExhaustedPayload(
      { ...sampleCredit, provider: '' },
      sampleProject,
    );
    const result = validatePayload(bad);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: credit.provider');
  });

  it('reports error when credit.model is missing', () => {
    const bad = createCreditExhaustedPayload(
      { ...sampleCredit, model: '' },
      sampleProject,
    );
    const result = validatePayload(bad);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: credit.model');
  });

  it('reports error when credit.role is missing', () => {
    const bad = createCreditExhaustedPayload(
      { ...sampleCredit, role: '' as any },
      sampleProject,
    );
    const result = validatePayload(bad);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: credit.role');
  });

  it('reports error when project is missing', () => {
    const bad = createCreditExhaustedPayload(sampleCredit, sampleProject);
    // Forcibly remove project to test validation
    (bad as any).project = null;
    const result = validatePayload(bad);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: project');
  });
});
