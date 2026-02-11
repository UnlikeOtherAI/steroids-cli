/**
 * Template Context Tests — createTemplateContext for all event types
 *
 * Tests for createTemplateContext covering credit.exhausted, credit.resolved,
 * task, section, health, dispute, and project event payloads.
 */

import { describe, it, expect } from '@jest/globals';
import { createTemplateContext } from '../src/hooks/templates.js';
import type { HookPayload } from '../src/hooks/payload.js';

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
