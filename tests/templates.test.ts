/**
 * Template Parser Tests
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  parseTemplate,
  parseTemplateObject,
  resolveEnvVars,
  resolveVariable,
  validateTemplate,
  getAvailableVariables,
  createTemplateContext,
  type TemplateContext,
} from '../src/hooks/templates.js';
import type { HookPayload } from '../src/hooks/payload.js';

describe('parseTemplate', () => {
  const context: TemplateContext = {
    event: 'task.completed',
    timestamp: '2024-01-15T10:30:00Z',
    task: {
      id: 'task-123',
      title: 'Fix bug',
      status: 'completed',
      section: 'Backend',
      sectionId: 'section-456',
    },
    project: {
      name: 'my-project',
      path: '/home/user/my-project',
    },
  };

  it('should resolve task variables', () => {
    expect(parseTemplate('Task {{task.id}} completed', context)).toBe('Task task-123 completed');
    expect(parseTemplate('{{task.title}}', context)).toBe('Fix bug');
    expect(parseTemplate('Status: {{task.status}}', context)).toBe('Status: completed');
  });

  it('should resolve project variables', () => {
    expect(parseTemplate('Project: {{project.name}}', context)).toBe('Project: my-project');
    expect(parseTemplate('Path: {{project.path}}', context)).toBe('Path: /home/user/my-project');
  });

  it('should resolve meta variables', () => {
    expect(parseTemplate('Event: {{event}}', context)).toBe('Event: task.completed');
    expect(parseTemplate('Time: {{timestamp}}', context)).toBe('Time: 2024-01-15T10:30:00Z');
  });

  it('should handle multiple variables', () => {
    const template = '{{task.title}} in {{project.name}} at {{timestamp}}';
    const expected = 'Fix bug in my-project at 2024-01-15T10:30:00Z';
    expect(parseTemplate(template, context)).toBe(expected);
  });

  it('should leave unknown variables unchanged', () => {
    expect(parseTemplate('{{unknown.var}}', context)).toBe('{{unknown.var}}');
  });

  it('should handle templates without variables', () => {
    expect(parseTemplate('No variables here', context)).toBe('No variables here');
  });
});

describe('parseTemplateObject', () => {
  const context: TemplateContext = {
    event: 'task.completed',
    timestamp: '2024-01-15T10:30:00Z',
    task: {
      id: 'task-123',
      title: 'Fix bug',
      status: 'completed',
    },
    project: {
      name: 'my-project',
      path: '/home/user/my-project',
    },
  };

  it('should parse strings', () => {
    expect(parseTemplateObject('{{task.id}}', context)).toBe('task-123');
  });

  it('should parse arrays', () => {
    const input = ['{{task.id}}', '{{task.title}}'];
    const expected = ['task-123', 'Fix bug'];
    expect(parseTemplateObject(input, context)).toEqual(expected);
  });

  it('should parse objects recursively', () => {
    const input = {
      id: '{{task.id}}',
      name: '{{project.name}}',
      nested: {
        title: '{{task.title}}',
      },
    };

    const expected = {
      id: 'task-123',
      name: 'my-project',
      nested: {
        title: 'Fix bug',
      },
    };

    expect(parseTemplateObject(input, context)).toEqual(expected);
  });

  it('should handle non-string primitives', () => {
    expect(parseTemplateObject(123, context)).toBe(123);
    expect(parseTemplateObject(true, context)).toBe(true);
    expect(parseTemplateObject(null, context)).toBe(null);
  });
});

describe('resolveEnvVars', () => {
  beforeEach(() => {
    process.env.TEST_VAR = 'test-value';
    process.env.API_KEY = 'secret-123';
  });

  afterEach(() => {
    delete process.env.TEST_VAR;
    delete process.env.API_KEY;
  });

  it('should resolve environment variables', () => {
    expect(resolveEnvVars('Value: ${TEST_VAR}')).toBe('Value: test-value');
    expect(resolveEnvVars('${API_KEY}')).toBe('secret-123');
  });

  it('should handle multiple env vars', () => {
    const input = '${TEST_VAR} and ${API_KEY}';
    expect(resolveEnvVars(input)).toBe('test-value and secret-123');
  });

  it('should leave undefined vars unchanged', () => {
    expect(resolveEnvVars('${UNDEFINED_VAR}')).toBe('${UNDEFINED_VAR}');
  });
});

describe('resolveVariable', () => {
  const context: TemplateContext = {
    event: 'task.completed',
    timestamp: '2024-01-15T10:30:00Z',
    task: {
      id: 'task-123',
      title: 'Fix bug',
      status: 'completed',
    },
    project: {
      name: 'my-project',
      path: '/home/user/my-project',
    },
  };

  it('should resolve top-level variables', () => {
    expect(resolveVariable('event', context)).toBe('task.completed');
    expect(resolveVariable('timestamp', context)).toBe('2024-01-15T10:30:00Z');
  });

  it('should resolve nested variables', () => {
    expect(resolveVariable('task.id', context)).toBe('task-123');
    expect(resolveVariable('project.name', context)).toBe('my-project');
  });

  it('should return undefined for unknown variables', () => {
    expect(resolveVariable('unknown', context)).toBeUndefined();
    expect(resolveVariable('task.unknown', context)).toBeUndefined();
  });
});

describe('validateTemplate', () => {
  it('should validate task event templates', () => {
    const result = validateTemplate('{{task.id}} {{task.title}}', 'task.completed');
    expect(result.valid).toBe(true);
    expect(result.invalidVars).toHaveLength(0);
  });

  it('should detect invalid variables', () => {
    const result = validateTemplate('{{task.id}} {{invalid.var}}', 'task.completed');
    expect(result.valid).toBe(false);
    expect(result.invalidVars).toContain('invalid.var');
  });

  it('should validate project event templates', () => {
    const result = validateTemplate('{{project.name}}', 'project.completed');
    expect(result.valid).toBe(true);
  });

  it('should reject task variables for project events', () => {
    const result = validateTemplate('{{task.id}}', 'project.completed');
    expect(result.valid).toBe(false);
    expect(result.invalidVars).toContain('task.id');
  });
});

describe('getAvailableVariables', () => {
  it('should return task variables for task events', () => {
    const vars = getAvailableVariables('task.completed');
    expect(vars).toContain('task.id');
    expect(vars).toContain('task.title');
    expect(vars).toContain('project.name');
  });

  it('should return section variables for section events', () => {
    const vars = getAvailableVariables('section.completed');
    expect(vars).toContain('section.id');
    expect(vars).toContain('section.name');
    expect(vars).toContain('project.name');
  });

  it('should return only base variables for project events', () => {
    const vars = getAvailableVariables('project.completed');
    expect(vars).toContain('project.name');
    expect(vars).not.toContain('task.id');
    expect(vars).not.toContain('section.id');
  });

  it('should return health variables for health events', () => {
    const vars = getAvailableVariables('health.changed');
    expect(vars).toContain('health.score');
    expect(vars).toContain('health.previousScore');
    expect(vars).toContain('health.status');
    expect(vars).toContain('project.name');
  });

  it('should return dispute variables for dispute events', () => {
    const vars = getAvailableVariables('dispute.created');
    expect(vars).toContain('dispute.id');
    expect(vars).toContain('dispute.taskId');
    expect(vars).toContain('dispute.type');
    expect(vars).toContain('dispute.status');
    expect(vars).toContain('task.id');
  });

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

  it('should return base variables for unknown events', () => {
    const vars = getAvailableVariables('unknown.event');
    expect(vars).toEqual(['event', 'timestamp', 'project.name', 'project.path']);
  });
});

// ============================================================================
// Credit-specific resolveVariable tests
// ============================================================================

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

// ============================================================================
// resolveVariable — section, health, dispute branches
// ============================================================================

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

// ============================================================================
// createTemplateContext tests
// ============================================================================

describe('createTemplateContext', () => {
  it('should create context for credit.exhausted payload', () => {
    const payload: HookPayload = {
      event: 'credit.exhausted',
      timestamp: '2024-06-01T12:00:00Z',
      project: { name: 'proj', path: '/proj' },
      credit: {
        provider: 'claude',
        model: 'opus',
        role: 'coder',
        message: 'Rate limit exceeded',
      },
    };
    const ctx = createTemplateContext(payload);
    expect(ctx.event).toBe('credit.exhausted');
    expect(ctx.credit).toEqual({
      provider: 'claude',
      model: 'opus',
      role: 'coder',
      message: 'Rate limit exceeded',
    });
    expect(ctx.project).toEqual({ name: 'proj', path: '/proj' });
    expect(ctx.task).toBeUndefined();
    expect(ctx.health).toBeUndefined();
    expect(ctx.dispute).toBeUndefined();
  });

  it('should create context for credit.resolved payload', () => {
    const payload: HookPayload = {
      event: 'credit.resolved',
      timestamp: '2024-06-01T13:00:00Z',
      project: { name: 'proj', path: '/proj' },
      credit: {
        provider: 'codex',
        model: 'sonnet',
        role: 'reviewer',
        message: 'Credits restored',
      },
      resolution: 'config_changed',
    };
    const ctx = createTemplateContext(payload);
    expect(ctx.event).toBe('credit.resolved');
    expect(ctx.credit).toEqual({
      provider: 'codex',
      model: 'sonnet',
      role: 'reviewer',
      message: 'Credits restored',
    });
  });

  it('should create context for task.completed payload', () => {
    const payload: HookPayload = {
      event: 'task.completed',
      timestamp: '2024-01-15T10:30:00Z',
      project: { name: 'proj', path: '/proj' },
      task: {
        id: 't-1',
        title: 'My task',
        status: 'completed',
        section: 'Backend',
        sectionId: 's-1',
      },
    };
    const ctx = createTemplateContext(payload);
    expect(ctx.task).toEqual({
      id: 't-1',
      title: 'My task',
      status: 'completed',
      section: 'Backend',
      sectionId: 's-1',
    });
    expect(ctx.credit).toBeUndefined();
  });

  it('should create context for section.completed payload', () => {
    const payload: HookPayload = {
      event: 'section.completed',
      timestamp: '2024-01-15T10:30:00Z',
      project: { name: 'proj', path: '/proj' },
      section: { id: 's-1', name: 'Backend', taskCount: 3 },
      tasks: [{ id: 't-1', title: 'A' }],
    };
    const ctx = createTemplateContext(payload);
    expect(ctx.section).toEqual({ id: 's-1', name: 'Backend' });
  });

  it('should create context for health.changed payload', () => {
    const payload: HookPayload = {
      event: 'health.changed',
      timestamp: '2024-01-15T10:30:00Z',
      project: { name: 'proj', path: '/proj' },
      health: { score: 80, previousScore: 95, status: 'warning' },
    };
    const ctx = createTemplateContext(payload);
    expect(ctx.health).toEqual({ score: 80, previousScore: 95, status: 'warning' });
  });

  it('should create context for dispute.created payload', () => {
    const payload: HookPayload = {
      event: 'dispute.created',
      timestamp: '2024-01-15T10:30:00Z',
      project: { name: 'proj', path: '/proj' },
      dispute: {
        id: 'd-1',
        taskId: 't-1',
        type: 'scope',
        status: 'open',
        reason: 'Unclear spec',
        createdBy: 'coder',
      },
      task: { id: 't-1', title: 'Task', status: 'in_progress', section: null, sectionId: null },
    };
    const ctx = createTemplateContext(payload);
    expect(ctx.dispute).toEqual({ id: 'd-1', taskId: 't-1', type: 'scope', status: 'open' });
    expect(ctx.task).toEqual({
      id: 't-1',
      title: 'Task',
      status: 'in_progress',
      section: null,
      sectionId: null,
    });
  });

  it('should create context for project.completed payload', () => {
    const payload: HookPayload = {
      event: 'project.completed',
      timestamp: '2024-01-15T10:30:00Z',
      project: { name: 'proj', path: '/proj' },
      summary: { totalTasks: 5, files: ['a.md'] },
    };
    const ctx = createTemplateContext(payload);
    expect(ctx.event).toBe('project.completed');
    expect(ctx.project).toEqual({ name: 'proj', path: '/proj' });
    expect(ctx.task).toBeUndefined();
  });
});

// ============================================================================
// validateTemplate — credit events
// ============================================================================

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

// ============================================================================
// parseTemplate — credit context integration
// ============================================================================

describe('parseTemplate — credit context', () => {
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
