// @ts-nocheck
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockTriggerHooksSafely = jest.fn(async (triggerFn: () => Promise<unknown>) => {
  await triggerFn();
});
const mockTriggerIntakeReceived = jest.fn(async () => []);
const mockTriggerIntakeTriaged = jest.fn(async () => []);
const mockTriggerIntakePRCreated = jest.fn(async () => []);

jest.unstable_mockModule('../src/hooks/integration.js', () => ({
  triggerHooksSafely: mockTriggerHooksSafely,
  triggerIntakeReceived: mockTriggerIntakeReceived,
  triggerIntakeTriaged: mockTriggerIntakeTriaged,
  triggerIntakePRCreated: mockTriggerIntakePRCreated,
}));

const { SCHEMA_SQL } = await import('../src/database/schema.js');
const { pollIntakeProject } = await import('../src/intake/poller.js');
const { syncGitHubIntakeGate } = await import('../src/intake/github-gate.js');
const { handleIntakePostPR } = await import('../src/intake/post-pr.js');
const { IntakeRegistry } = await import('../src/intake/registry.js');
const { createSection, createTask } = await import('../src/database/queries.js');
const { upsertIntakeReport } = await import('../src/database/intake-queries.js');
const { DEFAULT_INTAKE_PIPELINE_SOURCE_FILE } = await import('../src/intake/task-templates.js');

function createReport(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function createConfig() {
  return {
    intake: {
      enabled: true,
      connectors: {
        github: {
          enabled: true,
          apiBaseUrl: 'https://api.github.com',
          owner: 'acme',
          repo: 'widgets',
          tokenEnvVar: 'GITHUB_TOKEN',
          labels: ['bug'],
        },
      },
    },
  };
}

describe('intake hook wiring', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    jest.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('fires intake.received only for first-seen reports during polling', async () => {
    const connector = {
      source: 'github' as const,
      capabilities: {
        pull: true,
        pushUpdates: false,
        resolutionNotifications: false,
      },
      pullReports: jest.fn(async () => ({
        reports: [
          createReport(),
          createReport({ externalId: '43', url: 'https://github.com/acme/widgets/issues/43', fingerprint: 'github:acme/widgets#43', title: 'Issue 43' }),
        ],
      })),
      async pushUpdate() {
        return { accepted: true };
      },
      async notifyResolution() {
        return;
      },
    };
    const registry = new IntakeRegistry();
    registry.register(connector);

    await pollIntakeProject({
      projectDb: db,
      projectPath: '/tmp/test-project',
      config: createConfig(),
      createRegistry: () => registry,
      now: () => new Date('2026-03-13T12:00:00Z'),
    });

    expect(mockTriggerHooksSafely).toHaveBeenCalledTimes(2);
    expect(mockTriggerIntakeReceived).toHaveBeenCalledTimes(2);

    mockTriggerHooksSafely.mockClear();
    mockTriggerIntakeReceived.mockClear();

    const updatedRegistry = new IntakeRegistry();
    updatedRegistry.register({
      ...connector,
      pullReports: jest.fn(async () => ({
        reports: [createReport({ title: 'Checkout fails on empty cart (updated)' })],
      })),
    });

    await pollIntakeProject({
      projectDb: db,
      projectPath: '/tmp/test-project',
      config: {
        intake: {
          ...createConfig().intake,
          pollIntervalMinutes: 1,
        },
      },
      createRegistry: () => updatedRegistry,
      now: () => new Date('2026-03-13T12:02:00Z'),
    });

    expect(mockTriggerIntakeReceived).not.toHaveBeenCalled();
  });

  it('fires intake.triaged when GitHub gate approval creates a triage task', async () => {
    upsertIntakeReport(db, createReport({
      payload: {
        githubGate: {
          issueNumber: 314,
          issueUrl: 'https://github.com/acme/widgets/issues/314',
          decision: 'pending',
          requestedAt: '2026-03-13T12:00:00.000Z',
        },
      },
    }));

    const runGhCommand = jest
      .fn<(args: string[], env: NodeJS.ProcessEnv) => string>()
      .mockReturnValueOnce(
        JSON.stringify({
          number: 314,
          html_url: 'https://github.com/acme/widgets/issues/314',
          labels: [{ name: 'steroids:intake-gate' }, { name: 'steroids:intake-approved' }],
        })
      )
      .mockReturnValueOnce(JSON.stringify([{ name: 'steroids:intake-gate' }, { name: 'steroids:intake-approved' }]));

    await syncGitHubIntakeGate({
      projectDb: db,
      projectPath: '/tmp/test-project',
      config: createConfig(),
      env: { GITHUB_TOKEN: 'secret-token' },
      runGhCommand,
      now: () => new Date('2026-03-13T12:05:00Z'),
    });

    expect(mockTriggerHooksSafely).toHaveBeenCalled();
    expect(mockTriggerIntakeTriaged).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'github',
        externalId: '42',
        status: 'triaged',
      }),
      expect.any(String),
      { projectPath: '/tmp/test-project' }
    );
  });

  it('fires intake.pr_created when a fix report is resolved into a PR', async () => {
    const section = createSection(db, 'Bug Intake: Fix');
    const fixTask = createTask(db, 'Fix intake report github#42: Checkout fails on empty cart', {
      sectionId: section.id,
      sourceFile: DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
      status: 'completed',
    });
    upsertIntakeReport(db, createReport({ status: 'in_progress' }), { linkedTaskId: fixTask.id });

    const registry = new IntakeRegistry();
    registry.register({
      source: 'github',
      capabilities: {
        pull: true,
        pushUpdates: true,
        resolutionNotifications: true,
      },
      async pullReports() {
        return { reports: [] };
      },
      async pushUpdate() {
        return { accepted: true };
      },
      notifyResolution: jest.fn(async () => undefined),
    });

    await handleIntakePostPR({
      db,
      sectionId: section.id,
      prNumber: 123,
      projectPath: '/tmp/test-project',
      config: createConfig(),
      createRegistry: () => registry,
    });

    expect(mockTriggerHooksSafely).toHaveBeenCalled();
    expect(mockTriggerIntakePRCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'github',
        externalId: '42',
        status: 'resolved',
      }),
      123,
      { projectPath: '/tmp/test-project' }
    );
  });
});
