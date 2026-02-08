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
  type TemplateContext,
} from '../src/hooks/templates.js';

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
});
