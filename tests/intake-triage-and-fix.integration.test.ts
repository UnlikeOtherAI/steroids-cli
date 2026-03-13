import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntakeConnector, IntakeResolutionRequest } from '../src/intake/types.js';

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
const { getIntakeReport } = await import('../src/database/intake-queries.js');
const { listTasks, approveTask, getSectionByName } = await import('../src/database/queries.js');
const { pollIntakeProject } = await import('../src/intake/poller.js');
const { syncGitHubIntakeGate } = await import('../src/intake/github-gate.js');
const { handleIntakeTaskApproval } = await import('../src/intake/reviewer-approval.js');
const { handleIntakePostPR } = await import('../src/intake/post-pr.js');
const { IntakeRegistry } = await import('../src/intake/registry.js');

function createConfig() {
  return {
    intake: {
      enabled: true,
      pollIntervalMinutes: 15,
      maxReportsPerPoll: 50,
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

function createReport() {
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
  };
}

describe('intake triage_and_fix pipeline integration', () => {
  let db: Database.Database;
  let projectPath: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-intake-triage-fix-'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('runs the direct triage-to-fix pipeline from intake poll through post-PR resolution', async () => {
    const notifyResolution = jest
      .fn<(request: IntakeResolutionRequest) => Promise<void>>()
      .mockResolvedValue(undefined);
    const connector: IntakeConnector = {
      source: 'github' as const,
      capabilities: {
        pull: true,
        pushUpdates: true,
        resolutionNotifications: true,
      },
      pullReports: jest.fn(async () => ({ reports: [createReport()] })),
      pushUpdate: jest.fn(async () => ({ accepted: true })),
      notifyResolution,
    };
    const registry = new IntakeRegistry();
    registry.register(connector);

    await pollIntakeProject({
      projectDb: db,
      projectPath,
      config: createConfig(),
      createRegistry: () => registry,
      now: () => new Date('2026-03-13T12:00:00Z'),
    });

    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'open',
        linkedTaskId: null,
      })
    );

    const runGhCommand = jest
      .fn<(args: string[], env: NodeJS.ProcessEnv) => string>()
      .mockReturnValueOnce(
        JSON.stringify({
          number: 314,
          html_url: 'https://github.com/acme/widgets/issues/314',
        })
      )
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
      projectPath,
      config: createConfig(),
      env: { GITHUB_TOKEN: 'secret-token' },
      runGhCommand,
      now: () => new Date('2026-03-13T12:05:00Z'),
    });
    await syncGitHubIntakeGate({
      projectDb: db,
      projectPath,
      config: createConfig(),
      env: { GITHUB_TOKEN: 'secret-token' },
      runGhCommand,
      now: () => new Date('2026-03-13T12:06:00Z'),
    });

    const triageSection = getSectionByName(db, 'Bug Intake: Triage');
    const triageTask = listTasks(db, { status: 'all' }).find((task) => task.section_id === triageSection?.id);

    expect(triageTask).toEqual(
      expect.objectContaining({
        title: 'Triage intake report github#42: Checkout fails on empty cart',
        status: 'pending',
      })
    );
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'triaged',
        linkedTaskId: triageTask?.id,
      })
    );

    writeFileSync(
      join(projectPath, 'intake-result.json'),
      JSON.stringify({
        phase: 'triage',
        decision: 'fix',
        summary: 'The root cause is clear enough to proceed directly to a scoped fix.',
      }),
      'utf-8'
    );

    const approval = handleIntakeTaskApproval(db, triageTask!, projectPath);
    const fixSection = getSectionByName(db, 'Bug Intake: Fix');
    const fixTask = listTasks(db, { status: 'all' }).find((task) => task.id === approval.createdTaskId);

    expect(approval).toMatchObject({
      handled: true,
      createdTaskId: expect.any(String),
      transition: {
        action: 'advance',
        nextPhase: 'fix',
      },
    });
    expect(fixTask).toEqual(
      expect.objectContaining({
        title: 'Fix intake report github#42: Checkout fails on empty cart',
        section_id: fixSection?.id,
        status: 'pending',
      })
    );
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'in_progress',
        linkedTaskId: fixTask?.id,
      })
    );

    approveTask(db, fixTask!.id, 'test-reviewer');

    const postPr = await handleIntakePostPR({
      db,
      sectionId: fixSection?.id,
      prNumber: 123,
      projectPath,
      config: createConfig(),
      createRegistry: () => registry,
    });

    expect(postPr).toEqual({ handled: true, reportsResolved: 1 });
    expect(notifyResolution).toHaveBeenCalledTimes(1);
    const resolutionRequest = notifyResolution.mock.calls[0]?.[0];
    expect(resolutionRequest).toMatchObject({
      report: {
        source: 'github',
        externalId: '42',
        url: 'https://github.com/acme/widgets/issues/42',
      },
      resolution: 'fixed',
      message: 'Fixed in PR #123.',
      metadata: { prNumber: 123 },
    });
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'resolved',
        linkedTaskId: fixTask?.id,
      })
    );
    expect(mockTriggerIntakeReceived).toHaveBeenCalledTimes(1);
    expect(mockTriggerIntakeTriaged).toHaveBeenCalledTimes(1);
    expect(mockTriggerIntakePRCreated).toHaveBeenCalledTimes(1);
  });
});
