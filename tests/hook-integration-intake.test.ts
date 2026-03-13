// @ts-nocheck
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createTemplateContext, getAvailableVariables } from '../src/hooks/templates.js';
import {
  createIntakePRCreatedPayload,
  createIntakeReceivedPayload,
  createIntakeTriagedPayload,
  validatePayload,
} from '../src/hooks/payload.js';

const mockLoadConfigFile = jest.fn().mockReturnValue({ hooks: [] });
const mockGetProjectConfigPath = jest.fn().mockReturnValue('/tmp/test/.steroids/config.yaml');
const mockGetGlobalConfigPath = jest.fn().mockReturnValue('/home/user/.steroids/config.yaml');

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfigFile: mockLoadConfigFile,
  getProjectConfigPath: mockGetProjectConfigPath,
  getGlobalConfigPath: mockGetGlobalConfigPath,
  loadConfig: jest.fn(),
}));

const mockExecuteHooksForEvent = jest.fn().mockResolvedValue([]);

jest.unstable_mockModule('../src/hooks/orchestrator.js', () => ({
  HookOrchestrator: jest.fn().mockImplementation(() => ({
    executeHooksForEvent: mockExecuteHooksForEvent,
  })),
}));

jest.unstable_mockModule('../src/hooks/merge.js', () => ({
  mergeHooks: jest.fn().mockReturnValue([]),
  filterHooksByEvent: jest.fn().mockReturnValue([]),
}));

const {
  triggerIntakeReceived,
  triggerIntakeTriaged,
  triggerIntakePRCreated,
} = await import('../src/hooks/integration.js');

const sampleReport = {
  id: 'report-1',
  source: 'github' as const,
  externalId: '42',
  url: 'https://github.com/acme/widgets/issues/42',
  fingerprint: 'github:acme/widgets#42',
  title: 'Checkout fails on empty cart',
  summary: 'Stack trace attached',
  severity: 'high' as const,
  status: 'open' as const,
  createdAt: '2026-03-10T10:00:00Z',
  updatedAt: '2026-03-10T11:00:00Z',
  tags: ['bug'],
  payload: { body: 'Stack trace attached' },
  firstSeenAt: '2026-03-10T11:00:00Z',
  lastSeenAt: '2026-03-10T11:00:00Z',
  linkedTaskId: null,
  recordCreatedAt: '2026-03-10T11:00:00Z',
  recordUpdatedAt: '2026-03-10T11:00:00Z',
};

describe('intake hook triggers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfigFile.mockReturnValue({ hooks: [] });
    mockExecuteHooksForEvent.mockResolvedValue([]);
  });

  it('dispatches intake.received with normalized intake payload data', async () => {
    await triggerIntakeReceived(sampleReport, { projectPath: '/tmp/test' });

    expect(mockExecuteHooksForEvent).toHaveBeenCalledWith(
      'intake.received',
      expect.objectContaining({
        event: 'intake.received',
        intake: expect.objectContaining({
          source: 'github',
          externalId: '42',
          status: 'open',
          linkedTaskId: null,
        }),
        project: expect.objectContaining({ path: '/tmp/test' }),
      })
    );
  });

  it('dispatches intake.triaged with the linked task id', async () => {
    await triggerIntakeTriaged(
      { ...sampleReport, status: 'triaged', linkedTaskId: 'task-123' },
      'task-123',
      { projectPath: '/tmp/test' }
    );

    expect(mockExecuteHooksForEvent).toHaveBeenCalledWith(
      'intake.triaged',
      expect.objectContaining({
        event: 'intake.triaged',
        intake: expect.objectContaining({
          status: 'triaged',
          linkedTaskId: 'task-123',
        }),
      })
    );
  });

  it('dispatches intake.pr_created with the PR number', async () => {
    await triggerIntakePRCreated(
      { ...sampleReport, status: 'resolved', linkedTaskId: 'task-123' },
      314,
      { projectPath: '/tmp/test' }
    );

    expect(mockExecuteHooksForEvent).toHaveBeenCalledWith(
      'intake.pr_created',
      expect.objectContaining({
        event: 'intake.pr_created',
        intake: expect.objectContaining({
          linkedTaskId: 'task-123',
          prNumber: 314,
        }),
      })
    );
  });
});

describe('intake hook payload templates and validation', () => {
  it('builds template context for intake.pr_created fields', () => {
    const payload = createIntakePRCreatedPayload(
      {
        source: 'github',
        externalId: '42',
        url: 'https://github.com/acme/widgets/issues/42',
        fingerprint: 'github:acme/widgets#42',
        title: 'Checkout fails on empty cart',
        summary: 'Stack trace attached',
        severity: 'high',
        status: 'resolved',
        linkedTaskId: 'task-123',
        prNumber: 314,
      },
      {
        name: 'test-project',
        path: '/tmp/test',
      }
    );

    expect(createTemplateContext(payload)).toEqual(
      expect.objectContaining({
        event: 'intake.pr_created',
        project: {
          name: 'test-project',
          path: '/tmp/test',
        },
        intake: expect.objectContaining({
          externalId: '42',
          linkedTaskId: 'task-123',
          prNumber: 314,
        }),
      })
    );
  });

  it('exposes intake template variables for intake events', () => {
    expect(getAvailableVariables('intake.triaged')).toEqual(
      expect.arrayContaining([
        'intake.source',
        'intake.externalId',
        'intake.url',
        'intake.fingerprint',
        'intake.title',
        'intake.summary',
        'intake.severity',
        'intake.status',
        'intake.linkedTaskId',
        'intake.prNumber',
      ])
    );
  });

  it('requires prNumber for intake.pr_created payload validation', () => {
    const invalidPayload = createIntakePRCreatedPayload(
      {
        source: 'github',
        externalId: '42',
        url: 'https://github.com/acme/widgets/issues/42',
        fingerprint: 'github:acme/widgets#42',
        title: 'Checkout fails on empty cart',
        severity: 'high',
        status: 'resolved',
      },
      {
        name: 'test-project',
        path: '/tmp/test',
      }
    );

    expect(validatePayload(invalidPayload)).toEqual({
      valid: false,
      errors: ['Missing required field: intake.prNumber'],
    });
  });

  it('accepts intake.received and intake.triaged payloads as valid', () => {
    const project = { name: 'test-project', path: '/tmp/test' };

    expect(
      validatePayload(
        createIntakeReceivedPayload(
          {
            source: 'github',
            externalId: '42',
            url: 'https://github.com/acme/widgets/issues/42',
            fingerprint: 'github:acme/widgets#42',
            title: 'Checkout fails on empty cart',
            severity: 'high',
            status: 'open',
          },
          project
        )
      ).valid
    ).toBe(true);

    expect(
      validatePayload(
        createIntakeTriagedPayload(
          {
            source: 'github',
            externalId: '42',
            url: 'https://github.com/acme/widgets/issues/42',
            fingerprint: 'github:acme/widgets#42',
            title: 'Checkout fails on empty cart',
            severity: 'high',
            status: 'triaged',
            linkedTaskId: 'task-123',
          },
          project
        )
      ).valid
    ).toBe(true);
  });
});
