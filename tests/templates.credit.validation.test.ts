/**
 * Template Validation Tests — Credit event validation
 *
 * Tests for validateTemplate with credit events, ensuring credit variables
 * are accepted for credit events and rejected for non-credit events.
 */

import { describe, it, expect } from '@jest/globals';
import { validateTemplate } from '../src/hooks/templates.js';

describe('validateTemplate — credit events', () => {
  it('should accept valid credit variables for credit.exhausted', () => {
    const result = validateTemplate(
      '{{credit.provider}} {{credit.model}} {{credit.role}} {{credit.message}}',
      'credit.exhausted'
    );
    expect(result.valid).toBe(true);
    expect(result.invalidVars).toHaveLength(0);
  });

  it('should accept valid credit variables for credit.resolved', () => {
    const result = validateTemplate('{{credit.provider}} resolved', 'credit.resolved');
    expect(result.valid).toBe(true);
  });

  it('should reject task variables for credit events', () => {
    const result = validateTemplate('{{task.id}}', 'credit.exhausted');
    expect(result.valid).toBe(false);
    expect(result.invalidVars).toContain('task.id');
  });

  it('should accept base variables for credit events', () => {
    const result = validateTemplate('{{event}} {{timestamp}} {{project.name}}', 'credit.exhausted');
    expect(result.valid).toBe(true);
  });

  it('should validate health event templates', () => {
    const result = validateTemplate('{{health.score}} {{health.status}}', 'health.critical');
    expect(result.valid).toBe(true);
  });

  it('should validate dispute event templates', () => {
    const result = validateTemplate('{{dispute.id}} {{dispute.type}}', 'dispute.resolved');
    expect(result.valid).toBe(true);
  });
});
