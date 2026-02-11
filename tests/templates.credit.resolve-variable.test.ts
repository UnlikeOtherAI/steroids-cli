/**
 * Template Variable Resolution Tests — Credit, Section, Health, Dispute
 *
 * Tests for resolveVariable with credit.*, section.*, health.*, and dispute.*
 * variable paths, including absent-context edge cases.
 */

import { describe, it, expect } from '@jest/globals';
import {
  resolveVariable,
  getAvailableVariables,
  parseTemplate,
  type TemplateContext,
} from '../src/hooks/templates.js';

describe('resolveVariable — credit.*', () => {
  const creditContext: TemplateContext = {
    event: 'credit.exhausted',
    timestamp: '2024-06-01T12:00:00Z',
    project: { name: 'test-project', path: '/tmp/test-project' },
    credit: {
      provider: 'claude',
      model: 'opus',
      role: 'coder',
      message: 'Rate limit exceeded',
    },
  };

  it('should resolve credit.provider', () => {
    expect(resolveVariable('credit.provider', creditContext)).toBe('claude');
  });

  it('should resolve credit.model', () => {
    expect(resolveVariable('credit.model', creditContext)).toBe('opus');
  });

  it('should resolve credit.role', () => {
    expect(resolveVariable('credit.role', creditContext)).toBe('coder');
  });

  it('should resolve credit.message', () => {
    expect(resolveVariable('credit.message', creditContext)).toBe('Rate limit exceeded');
  });

  it('should return undefined for unknown credit field', () => {
    expect(resolveVariable('credit.unknown', creditContext)).toBeUndefined();
  });

  it('should return undefined when credit context is absent', () => {
    const noCredit: TemplateContext = {
      event: 'task.completed',
      timestamp: '2024-01-01T00:00:00Z',
      project: { name: 'p', path: '/p' },
    };
    expect(resolveVariable('credit.provider', noCredit)).toBeUndefined();
  });
});

describe('resolveVariable — section.*', () => {
  const ctx: TemplateContext = {
    event: 'section.completed',
    timestamp: '2024-01-01T00:00:00Z',
    project: { name: 'p', path: '/p' },
    section: { id: 'sec-1', name: 'Backend' },
  };

  it('should resolve section.id', () => {
    expect(resolveVariable('section.id', ctx)).toBe('sec-1');
  });

  it('should resolve section.name', () => {
    expect(resolveVariable('section.name', ctx)).toBe('Backend');
  });

  it('should return undefined for unknown section field', () => {
    expect(resolveVariable('section.unknown', ctx)).toBeUndefined();
  });

  it('should return undefined when section context is absent', () => {
    const noSection: TemplateContext = {
      event: 'task.completed',
      timestamp: '2024-01-01T00:00:00Z',
      project: { name: 'p', path: '/p' },
    };
    expect(resolveVariable('section.id', noSection)).toBeUndefined();
  });
});

describe('resolveVariable — health.*', () => {
  const ctx: TemplateContext = {
    event: 'health.changed',
    timestamp: '2024-01-01T00:00:00Z',
    project: { name: 'p', path: '/p' },
    health: { score: 75, previousScore: 90, status: 'warning' },
  };

  it('should resolve health.score', () => {
    expect(resolveVariable('health.score', ctx)).toBe(75);
  });

  it('should resolve health.previousScore', () => {
    expect(resolveVariable('health.previousScore', ctx)).toBe(90);
  });

  it('should resolve health.status', () => {
    expect(resolveVariable('health.status', ctx)).toBe('warning');
  });

  it('should return undefined for unknown health field', () => {
    expect(resolveVariable('health.unknown', ctx)).toBeUndefined();
  });

  it('should return undefined when health context is absent', () => {
    const noHealth: TemplateContext = {
      event: 'task.completed',
      timestamp: '2024-01-01T00:00:00Z',
      project: { name: 'p', path: '/p' },
    };
    expect(resolveVariable('health.score', noHealth)).toBeUndefined();
  });
});

describe('resolveVariable — dispute.*', () => {
  const ctx: TemplateContext = {
    event: 'dispute.created',
    timestamp: '2024-01-01T00:00:00Z',
    project: { name: 'p', path: '/p' },
    dispute: { id: 'd-1', taskId: 't-1', type: 'scope', status: 'open' },
  };

  it('should resolve dispute.id', () => {
    expect(resolveVariable('dispute.id', ctx)).toBe('d-1');
  });

  it('should resolve dispute.taskId', () => {
    expect(resolveVariable('dispute.taskId', ctx)).toBe('t-1');
  });

  it('should resolve dispute.type', () => {
    expect(resolveVariable('dispute.type', ctx)).toBe('scope');
  });

  it('should resolve dispute.status', () => {
    expect(resolveVariable('dispute.status', ctx)).toBe('open');
  });

  it('should return undefined for unknown dispute field', () => {
    expect(resolveVariable('dispute.unknown', ctx)).toBeUndefined();
  });

  it('should return undefined when dispute context is absent', () => {
    const noDispute: TemplateContext = {
      event: 'task.completed',
      timestamp: '2024-01-01T00:00:00Z',
      project: { name: 'p', path: '/p' },
    };
    expect(resolveVariable('dispute.id', noDispute)).toBeUndefined();
  });
});

describe('getAvailableVariables — credit events', () => {
  it('should return credit variables for credit.exhausted', () => {
    const vars = getAvailableVariables('credit.exhausted');
    expect(vars).toContain('credit.provider');
    expect(vars).toContain('credit.model');
    expect(vars).toContain('credit.role');
    expect(vars).toContain('credit.message');
    expect(vars).toContain('project.name');
    expect(vars).toContain('project.path');
    expect(vars).toContain('event');
    expect(vars).toContain('timestamp');
  });

  it('should return credit variables for credit.resolved', () => {
    const vars = getAvailableVariables('credit.resolved');
    expect(vars).toContain('credit.provider');
    expect(vars).toContain('credit.model');
    expect(vars).toContain('credit.role');
    expect(vars).toContain('credit.message');
  });
});

describe('parseTemplate — credit context integration', () => {
  const creditContext: TemplateContext = {
    event: 'credit.exhausted',
    timestamp: '2024-06-01T12:00:00Z',
    project: { name: 'my-project', path: '/home/user/my-project' },
    credit: {
      provider: 'claude',
      model: 'opus',
      role: 'coder',
      message: 'Rate limit exceeded',
    },
  };

  it('should resolve credit variables in a template', () => {
    const tpl = 'Provider {{credit.provider}} model {{credit.model}} hit limit';
    expect(parseTemplate(tpl, creditContext)).toBe('Provider claude model opus hit limit');
  });

  it('should resolve credit.role and credit.message', () => {
    const tpl = '{{credit.role}}: {{credit.message}}';
    expect(parseTemplate(tpl, creditContext)).toBe('coder: Rate limit exceeded');
  });

  it('should mix credit and base variables', () => {
    const tpl = '{{event}} — {{credit.provider}} in {{project.name}}';
    expect(parseTemplate(tpl, creditContext)).toBe(
      'credit.exhausted — claude in my-project'
    );
  });
});
