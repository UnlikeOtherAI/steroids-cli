/**
 * Tests for template variable parser
 */

import {
  parseTemplate,
  parseTemplateObject,
  resolveEnvVars,
  resolveVariable,
  createTemplateContext,
  getAvailableVariables,
  validateTemplate,
  type TemplateContext,
} from '../src/hooks/templates.js';
import type {
  TaskCreatedPayload,
  SectionCompletedPayload,
  HealthChangedPayload,
  DisputeCreatedPayload,
} from '../src/hooks/payload.js';

describe('Template Variables Parser', () => {
  // Save and restore env vars
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear test env vars
    delete process.env.TEST_TOKEN;
    delete process.env.WEBHOOK_URL;
  });

  afterAll(() => {
    // Restore env vars
    Object.assign(process.env, originalEnv);
  });

  describe('parseTemplate', () => {
    const context: TemplateContext = {
      event: 'task.completed',
      timestamp: '2024-01-15T10:30:00Z',
      task: {
        id: 'abc-123',
        title: 'Fix login bug',
        status: 'completed',
        section: 'Backend',
        sectionId: 'section-1',
      },
      project: {
        name: 'my-project',
        path: '/Users/dev/my-project',
      },
    };

    it('should parse task.id variable', () => {
      const result = parseTemplate('Task {{task.id}} completed', context);
      expect(result).toBe('Task abc-123 completed');
    });

    it('should parse task.title variable', () => {
      const result = parseTemplate('Completed: {{task.title}}', context);
      expect(result).toBe('Completed: Fix login bug');
    });

    it('should parse task.status variable', () => {
      const result = parseTemplate('Status: {{task.status}}', context);
      expect(result).toBe('Status: completed');
    });

    it('should parse task.section variable', () => {
      const result = parseTemplate('Section: {{task.section}}', context);
      expect(result).toBe('Section: Backend');
    });

    it('should parse project.name variable', () => {
      const result = parseTemplate('Project: {{project.name}}', context);
      expect(result).toBe('Project: my-project');
    });

    it('should parse project.path variable', () => {
      const result = parseTemplate('Path: {{project.path}}', context);
      expect(result).toBe('Path: /Users/dev/my-project');
    });

    it('should parse event variable', () => {
      const result = parseTemplate('Event: {{event}}', context);
      expect(result).toBe('Event: task.completed');
    });

    it('should parse timestamp variable', () => {
      const result = parseTemplate('Time: {{timestamp}}', context);
      expect(result).toBe('Time: 2024-01-15T10:30:00Z');
    });

    it('should parse multiple variables in one string', () => {
      const result = parseTemplate('{{task.title}} in {{project.name}} - {{event}}', context);
      expect(result).toBe('Fix login bug in my-project - task.completed');
    });

    it('should handle whitespace in variable names', () => {
      const result = parseTemplate('{{ task.title }} - {{ project.name }}', context);
      expect(result).toBe('Fix login bug - my-project');
    });

    it('should leave unknown variables unchanged', () => {
      const result = parseTemplate('{{unknown.variable}}', context);
      expect(result).toBe('{{unknown.variable}}');
    });

    it('should handle empty context gracefully', () => {
      const emptyContext: TemplateContext = {
        event: 'project.completed',
        timestamp: '2024-01-15T10:30:00Z',
        project: {
          name: 'test',
          path: '/test',
        },
      };
      const result = parseTemplate('{{task.title}}', emptyContext);
      expect(result).toBe('{{task.title}}');
    });

    it('should handle section variables', () => {
      const sectionContext: TemplateContext = {
        event: 'section.completed',
        timestamp: '2024-01-15T10:30:00Z',
        section: {
          id: 'section-1',
          name: 'Backend Tasks',
        },
        project: {
          name: 'my-project',
          path: '/path/to/project',
        },
      };
      const result = parseTemplate('{{section.name}} in {{project.name}}', sectionContext);
      expect(result).toBe('Backend Tasks in my-project');
    });

    it('should handle health variables', () => {
      const healthContext: TemplateContext = {
        event: 'health.changed',
        timestamp: '2024-01-15T10:30:00Z',
        health: {
          score: 85,
          previousScore: 90,
          status: 'healthy',
        },
        project: {
          name: 'my-project',
          path: '/path/to/project',
        },
      };
      const result = parseTemplate('Health: {{health.score}} (was {{health.previousScore}})', healthContext);
      expect(result).toBe('Health: 85 (was 90)');
    });

    it('should handle dispute variables', () => {
      const disputeContext: TemplateContext = {
        event: 'dispute.created',
        timestamp: '2024-01-15T10:30:00Z',
        dispute: {
          id: 'dispute-1',
          taskId: 'task-1',
          type: 'scope',
          status: 'open',
        },
        task: {
          id: 'task-1',
          title: 'Test task',
          status: 'review',
        },
        project: {
          name: 'my-project',
          path: '/path/to/project',
        },
      };
      const result = parseTemplate('Dispute {{dispute.id}} for {{task.title}}', disputeContext);
      expect(result).toBe('Dispute dispute-1 for Test task');
    });
  });

  describe('parseTemplateObject', () => {
    const context: TemplateContext = {
      event: 'task.completed',
      timestamp: '2024-01-15T10:30:00Z',
      task: {
        id: 'abc-123',
        title: 'Fix bug',
        status: 'completed',
      },
      project: {
        name: 'my-project',
        path: '/path',
      },
    };

    it('should parse string values', () => {
      const obj = { message: 'Task {{task.title}} done' };
      const result = parseTemplateObject(obj, context);
      expect(result).toEqual({ message: 'Task Fix bug done' });
    });

    it('should parse nested objects', () => {
      const obj = {
        webhook: {
          body: {
            task: '{{task.title}}',
            project: '{{project.name}}',
          },
        },
      };
      const result = parseTemplateObject(obj, context);
      expect(result).toEqual({
        webhook: {
          body: {
            task: 'Fix bug',
            project: 'my-project',
          },
        },
      });
    });

    it('should parse arrays', () => {
      const obj = { args: ['{{task.title}}', '{{project.name}}'] };
      const result = parseTemplateObject(obj, context);
      expect(result).toEqual({ args: ['Fix bug', 'my-project'] });
    });

    it('should preserve non-string values', () => {
      const obj = {
        count: 42,
        enabled: true,
        items: [1, 2, 3],
      };
      const result = parseTemplateObject(obj, context);
      expect(result).toEqual(obj);
    });

    it('should handle mixed types', () => {
      const obj = {
        message: '{{task.title}}',
        count: 5,
        tags: ['{{project.name}}', 'production'],
      };
      const result = parseTemplateObject(obj, context);
      expect(result).toEqual({
        message: 'Fix bug',
        count: 5,
        tags: ['my-project', 'production'],
      });
    });
  });

  describe('resolveEnvVars', () => {
    it('should resolve environment variables', () => {
      process.env.TEST_TOKEN = 'secret-123';
      const result = resolveEnvVars('Bearer ${TEST_TOKEN}');
      expect(result).toBe('Bearer secret-123');
    });

    it('should resolve multiple env vars', () => {
      process.env.API_URL = 'https://api.example.com';
      process.env.API_KEY = 'key-456';
      const result = resolveEnvVars('${API_URL}/hook?key=${API_KEY}');
      expect(result).toBe('https://api.example.com/hook?key=key-456');
    });

    it('should leave unset variables unchanged', () => {
      const result = resolveEnvVars('Token: ${UNSET_VAR}');
      expect(result).toBe('Token: ${UNSET_VAR}');
    });

    it('should handle whitespace in variable names', () => {
      process.env.TOKEN = 'abc';
      const result = resolveEnvVars('${ TOKEN }');
      expect(result).toBe('abc');
    });
  });

  describe('resolveVariable', () => {
    const context: TemplateContext = {
      event: 'task.completed',
      timestamp: '2024-01-15T10:30:00Z',
      task: {
        id: 'task-1',
        title: 'Test',
        status: 'completed',
      },
      project: {
        name: 'proj',
        path: '/path',
      },
    };

    it('should resolve event variable', () => {
      expect(resolveVariable('event', context)).toBe('task.completed');
    });

    it('should resolve timestamp variable', () => {
      expect(resolveVariable('timestamp', context)).toBe('2024-01-15T10:30:00Z');
    });

    it('should resolve task.id', () => {
      expect(resolveVariable('task.id', context)).toBe('task-1');
    });

    it('should resolve task.title', () => {
      expect(resolveVariable('task.title', context)).toBe('Test');
    });

    it('should resolve project.name', () => {
      expect(resolveVariable('project.name', context)).toBe('proj');
    });

    it('should return undefined for unknown variables', () => {
      expect(resolveVariable('unknown.var', context)).toBeUndefined();
    });

    it('should return undefined for missing context', () => {
      const minContext: TemplateContext = {
        event: 'test',
        timestamp: '2024-01-15T10:30:00Z',
        project: { name: 'test', path: '/test' },
      };
      expect(resolveVariable('task.title', minContext)).toBeUndefined();
    });
  });

  describe('createTemplateContext', () => {
    it('should create context from task.created payload', () => {
      const payload: TaskCreatedPayload = {
        event: 'task.created',
        timestamp: '2024-01-15T10:30:00Z',
        task: {
          id: 'task-1',
          title: 'New task',
          status: 'pending',
          section: 'Backend',
          sectionId: 'section-1',
        },
        project: {
          name: 'my-project',
          path: '/path/to/project',
        },
      };

      const context = createTemplateContext(payload);

      expect(context.event).toBe('task.created');
      expect(context.timestamp).toBe('2024-01-15T10:30:00Z');
      expect(context.task).toEqual({
        id: 'task-1',
        title: 'New task',
        status: 'pending',
        section: 'Backend',
        sectionId: 'section-1',
      });
      expect(context.project).toEqual({
        name: 'my-project',
        path: '/path/to/project',
      });
    });

    it('should create context from section.completed payload', () => {
      const payload: SectionCompletedPayload = {
        event: 'section.completed',
        timestamp: '2024-01-15T10:30:00Z',
        section: {
          id: 'section-1',
          name: 'Backend',
          taskCount: 5,
        },
        tasks: [],
        project: {
          name: 'my-project',
          path: '/path/to/project',
        },
      };

      const context = createTemplateContext(payload);

      expect(context.event).toBe('section.completed');
      expect(context.section).toEqual({
        id: 'section-1',
        name: 'Backend',
      });
    });

    it('should create context from health.changed payload', () => {
      const payload: HealthChangedPayload = {
        event: 'health.changed',
        timestamp: '2024-01-15T10:30:00Z',
        health: {
          score: 85,
          previousScore: 90,
          status: 'healthy',
        },
        project: {
          name: 'my-project',
          path: '/path/to/project',
        },
      };

      const context = createTemplateContext(payload);

      expect(context.health).toEqual({
        score: 85,
        previousScore: 90,
        status: 'healthy',
      });
    });

    it('should create context from dispute.created payload', () => {
      const payload: DisputeCreatedPayload = {
        event: 'dispute.created',
        timestamp: '2024-01-15T10:30:00Z',
        dispute: {
          id: 'dispute-1',
          taskId: 'task-1',
          type: 'scope',
          status: 'open',
          reason: 'Test reason',
          createdBy: 'reviewer',
        },
        task: {
          id: 'task-1',
          title: 'Test task',
          status: 'review',
        },
        project: {
          name: 'my-project',
          path: '/path/to/project',
        },
      };

      const context = createTemplateContext(payload);

      expect(context.dispute).toEqual({
        id: 'dispute-1',
        taskId: 'task-1',
        type: 'scope',
        status: 'open',
      });
      expect(context.task).toEqual({
        id: 'task-1',
        title: 'Test task',
        status: 'review',
        section: undefined,
        sectionId: undefined,
      });
    });
  });

  describe('getAvailableVariables', () => {
    it('should return task variables for task events', () => {
      const vars = getAvailableVariables('task.completed');
      expect(vars).toContain('event');
      expect(vars).toContain('timestamp');
      expect(vars).toContain('task.id');
      expect(vars).toContain('task.title');
      expect(vars).toContain('task.status');
      expect(vars).toContain('project.name');
      expect(vars).toContain('project.path');
    });

    it('should return section variables for section events', () => {
      const vars = getAvailableVariables('section.completed');
      expect(vars).toContain('section.id');
      expect(vars).toContain('section.name');
      expect(vars).not.toContain('task.id');
    });

    it('should return health variables for health events', () => {
      const vars = getAvailableVariables('health.changed');
      expect(vars).toContain('health.score');
      expect(vars).toContain('health.status');
      expect(vars).toContain('health.previousScore');
    });

    it('should return dispute variables for dispute events', () => {
      const vars = getAvailableVariables('dispute.created');
      expect(vars).toContain('dispute.id');
      expect(vars).toContain('dispute.taskId');
      expect(vars).toContain('task.id');
      expect(vars).toContain('task.title');
    });

    it('should return base variables for project events', () => {
      const vars = getAvailableVariables('project.completed');
      expect(vars).toContain('event');
      expect(vars).toContain('timestamp');
      expect(vars).toContain('project.name');
      expect(vars).not.toContain('task.id');
    });
  });

  describe('validateTemplate', () => {
    it('should validate correct task variables', () => {
      const result = validateTemplate('{{task.title}} in {{project.name}}', 'task.completed');
      expect(result.valid).toBe(true);
      expect(result.invalidVars).toEqual([]);
    });

    it('should detect invalid variables', () => {
      const result = validateTemplate('{{invalid.var}}', 'task.completed');
      expect(result.valid).toBe(false);
      expect(result.invalidVars).toContain('invalid.var');
    });

    it('should allow section variables only for section events', () => {
      const result1 = validateTemplate('{{section.name}}', 'section.completed');
      expect(result1.valid).toBe(true);

      const result2 = validateTemplate('{{section.name}}', 'task.completed');
      expect(result2.valid).toBe(false);
      expect(result2.invalidVars).toContain('section.name');
    });

    it('should detect multiple invalid variables', () => {
      const result = validateTemplate('{{invalid.one}} {{invalid.two}}', 'task.completed');
      expect(result.valid).toBe(false);
      expect(result.invalidVars).toHaveLength(2);
    });

    it('should handle templates without variables', () => {
      const result = validateTemplate('No variables here', 'task.completed');
      expect(result.valid).toBe(true);
      expect(result.invalidVars).toEqual([]);
    });
  });

  describe('Integration tests', () => {
    it('should parse webhook body with environment and template variables', () => {
      process.env.SLACK_TOKEN = 'xoxb-secret';

      const context: TemplateContext = {
        event: 'task.completed',
        timestamp: '2024-01-15T10:30:00Z',
        task: {
          id: 'abc-123',
          title: 'Deploy to production',
          status: 'completed',
        },
        project: {
          name: 'my-app',
          path: '/Users/dev/my-app',
        },
      };

      const webhookConfig = {
        url: 'https://slack.com/api/chat.postMessage',
        headers: {
          Authorization: 'Bearer ${SLACK_TOKEN}',
          'Content-Type': 'application/json',
        },
        body: {
          channel: '#deployments',
          text: 'Task completed: {{task.title}}',
          project: '{{project.name}}',
          timestamp: '{{timestamp}}',
        },
      };

      const parsed = parseTemplateObject(webhookConfig, context);

      expect(parsed.headers.Authorization).toBe('Bearer xoxb-secret');
      expect(parsed.body.text).toBe('Task completed: Deploy to production');
      expect(parsed.body.project).toBe('my-app');
      expect(parsed.body.timestamp).toBe('2024-01-15T10:30:00Z');
    });

    it('should parse script arguments', () => {
      const context: TemplateContext = {
        event: 'task.completed',
        timestamp: '2024-01-15T10:30:00Z',
        task: {
          id: 'task-1',
          title: 'Fix bug',
          status: 'completed',
          section: 'Backend',
        },
        project: {
          name: 'api-server',
          path: '/home/dev/api-server',
        },
      };

      const args = ['--task', '{{task.title}}', '--section', '{{task.section}}', '--project', '{{project.name}}'];

      const parsed = parseTemplateObject(args, context);

      expect(parsed).toEqual([
        '--task',
        'Fix bug',
        '--section',
        'Backend',
        '--project',
        'api-server',
      ]);
    });
  });
});
