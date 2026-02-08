/**
 * Hook Merge Tests
 */

import { describe, it, expect } from 'vitest';
import {
  mergeHooks,
  filterHooksByEvent,
  findHookByName,
  validateHook,
  groupHooksByEvent,
  getEventsWithHooks,
  type HookConfig,
} from '../src/hooks/merge.js';

describe('mergeHooks', () => {
  it('should include all global hooks when no project hooks', () => {
    const global: HookConfig[] = [
      {
        name: 'hook1',
        event: 'task.completed',
        type: 'script',
        command: './test.sh',
      },
    ];

    const result = mergeHooks(global, []);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('hook1');
  });

  it('should override global hook with project hook of same name', () => {
    const global: HookConfig[] = [
      {
        name: 'notify',
        event: 'task.completed',
        type: 'script',
        command: './global-notify.sh',
      },
    ];

    const project: HookConfig[] = [
      {
        name: 'notify',
        event: 'task.completed',
        type: 'script',
        command: './project-notify.sh',
      },
    ];

    const result = mergeHooks(global, project);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('notify');
    expect((result[0] as any).command).toBe('./project-notify.sh');
  });

  it('should disable global hook when project hook has enabled: false', () => {
    const global: HookConfig[] = [
      {
        name: 'slack-notify',
        event: 'task.completed',
        type: 'webhook',
        url: 'https://hooks.slack.com/xxx',
      },
    ];

    const project: HookConfig[] = [
      {
        name: 'slack-notify',
        event: 'task.completed',
        type: 'webhook',
        url: 'https://hooks.slack.com/xxx',
        enabled: false,
      },
    ];

    const result = mergeHooks(global, project);
    expect(result).toHaveLength(0);
  });

  it('should merge unique hooks from both global and project', () => {
    const global: HookConfig[] = [
      {
        name: 'global-hook',
        event: 'task.completed',
        type: 'script',
        command: './global.sh',
      },
    ];

    const project: HookConfig[] = [
      {
        name: 'project-hook',
        event: 'task.completed',
        type: 'script',
        command: './project.sh',
      },
    ];

    const result = mergeHooks(global, project);
    expect(result).toHaveLength(2);
    expect(result.map((h) => h.name)).toContain('global-hook');
    expect(result.map((h) => h.name)).toContain('project-hook');
  });

  it('should exclude disabled global hooks', () => {
    const global: HookConfig[] = [
      {
        name: 'disabled-hook',
        event: 'task.completed',
        type: 'script',
        command: './test.sh',
        enabled: false,
      },
    ];

    const result = mergeHooks(global, []);
    expect(result).toHaveLength(0);
  });
});

describe('filterHooksByEvent', () => {
  const hooks: HookConfig[] = [
    {
      name: 'hook1',
      event: 'task.completed',
      type: 'script',
      command: './test.sh',
    },
    {
      name: 'hook2',
      event: 'task.created',
      type: 'script',
      command: './test.sh',
    },
    {
      name: 'hook3',
      event: 'task.completed',
      type: 'webhook',
      url: 'https://example.com',
    },
  ];

  it('should filter hooks by event', () => {
    const result = filterHooksByEvent(hooks, 'task.completed');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('hook1');
    expect(result[1].name).toBe('hook3');
  });

  it('should return empty array for event with no hooks', () => {
    const result = filterHooksByEvent(hooks, 'project.completed');
    expect(result).toHaveLength(0);
  });

  it('should exclude disabled hooks', () => {
    const hooksWithDisabled: HookConfig[] = [
      ...hooks,
      {
        name: 'disabled',
        event: 'task.completed',
        type: 'script',
        command: './test.sh',
        enabled: false,
      },
    ];

    const result = filterHooksByEvent(hooksWithDisabled, 'task.completed');
    expect(result).toHaveLength(2);
    expect(result.map((h) => h.name)).not.toContain('disabled');
  });
});

describe('findHookByName', () => {
  const hooks: HookConfig[] = [
    {
      name: 'hook1',
      event: 'task.completed',
      type: 'script',
      command: './test.sh',
    },
    {
      name: 'hook2',
      event: 'task.created',
      type: 'script',
      command: './test.sh',
    },
  ];

  it('should find hook by name', () => {
    const result = findHookByName(hooks, 'hook1');
    expect(result).toBeDefined();
    expect(result?.name).toBe('hook1');
  });

  it('should return undefined for non-existent hook', () => {
    const result = findHookByName(hooks, 'non-existent');
    expect(result).toBeUndefined();
  });
});

describe('validateHook', () => {
  it('should validate script hook', () => {
    const hook: HookConfig = {
      name: 'test',
      event: 'task.completed',
      type: 'script',
      command: './test.sh',
    };

    const result = validateHook(hook);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate webhook hook', () => {
    const hook: HookConfig = {
      name: 'test',
      event: 'task.completed',
      type: 'webhook',
      url: 'https://example.com',
    };

    const result = validateHook(hook);
    expect(result.valid).toBe(true);
  });

  it('should require name', () => {
    const hook: HookConfig = {
      name: '',
      event: 'task.completed',
      type: 'script',
      command: './test.sh',
    };

    const result = validateHook(hook);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: name');
  });

  it('should require command for script hook', () => {
    const hook: HookConfig = {
      name: 'test',
      event: 'task.completed',
      type: 'script',
      command: '',
    };

    const result = validateHook(hook);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field for script hook: command');
  });

  it('should require url for webhook hook', () => {
    const hook: HookConfig = {
      name: 'test',
      event: 'task.completed',
      type: 'webhook',
      url: '',
    };

    const result = validateHook(hook);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field for webhook hook: url');
  });
});

describe('groupHooksByEvent', () => {
  const hooks: HookConfig[] = [
    {
      name: 'hook1',
      event: 'task.completed',
      type: 'script',
      command: './test.sh',
    },
    {
      name: 'hook2',
      event: 'task.completed',
      type: 'webhook',
      url: 'https://example.com',
    },
    {
      name: 'hook3',
      event: 'task.created',
      type: 'script',
      command: './test.sh',
    },
  ];

  it('should group hooks by event', () => {
    const grouped = groupHooksByEvent(hooks);

    expect(grouped.size).toBe(2);
    expect(grouped.get('task.completed')).toHaveLength(2);
    expect(grouped.get('task.created')).toHaveLength(1);
  });

  it('should exclude disabled hooks', () => {
    const hooksWithDisabled: HookConfig[] = [
      ...hooks,
      {
        name: 'disabled',
        event: 'task.completed',
        type: 'script',
        command: './test.sh',
        enabled: false,
      },
    ];

    const grouped = groupHooksByEvent(hooksWithDisabled);
    expect(grouped.get('task.completed')).toHaveLength(2);
  });
});

describe('getEventsWithHooks', () => {
  const hooks: HookConfig[] = [
    {
      name: 'hook1',
      event: 'task.completed',
      type: 'script',
      command: './test.sh',
    },
    {
      name: 'hook2',
      event: 'task.created',
      type: 'script',
      command: './test.sh',
    },
    {
      name: 'hook3',
      event: 'task.completed',
      type: 'webhook',
      url: 'https://example.com',
    },
  ];

  it('should return unique events', () => {
    const events = getEventsWithHooks(hooks);
    expect(events).toHaveLength(2);
    expect(events).toContain('task.completed');
    expect(events).toContain('task.created');
  });

  it('should exclude events from disabled hooks', () => {
    const hooksWithDisabled: HookConfig[] = [
      {
        name: 'disabled',
        event: 'project.completed',
        type: 'script',
        command: './test.sh',
        enabled: false,
      },
    ];

    const events = getEventsWithHooks(hooksWithDisabled);
    expect(events).not.toContain('project.completed');
  });
});
