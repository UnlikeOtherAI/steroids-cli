import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SCHEMA_SQL } from '../src/database/schema.js';
import { getIntakeReport, listIntakeReports, upsertIntakeReport } from '../src/database/intake-queries.js';
import { createSection, createTask, getSectionByName, listTasks } from '../src/database/queries.js';
import {
  GITHUB_GATE_APPROVED_LABEL,
  GITHUB_GATE_LABEL,
  GITHUB_GATE_PENDING_LABEL,
  GITHUB_GATE_REJECTED_LABEL,
  syncGitHubIntakeGate,
} from '../src/intake/github-gate.js';
import type { SteroidsConfig } from '../src/config/loader.js';
import type { IntakeReport } from '../src/intake/types.js';

type GhRunner = (args: string[], env: NodeJS.ProcessEnv) => string;

function createConfig(): SteroidsConfig {
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

function createReport(overrides: Partial<IntakeReport> = {}): IntakeReport {
  return {
    source: 'github',
    externalId: '42',
    url: 'https://github.com/acme/widgets/issues/42',
    fingerprint: 'github:acme/widgets#42',
    title: 'Checkout fails on empty cart',
    summary: 'Stack trace attached',
    severity: 'high',
    status: 'open',
    createdAt: '2026-03-10T10:00:00Z',
    updatedAt: '2026-03-10T11:00:00Z',
    tags: ['bug'],
    payload: { body: 'Stack trace attached' },
    ...overrides,
  };
}

describe('syncGitHubIntakeGate', () => {
  let db: Database.Database;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    env = { GITHUB_TOKEN: 'secret-token' };
  });

  afterEach(() => {
    db.close();
  });

  it('creates a deterministic approval issue for an unlinked github intake report', async () => {
    upsertIntakeReport(db, createReport());
    const runGhCommand = jest.fn<GhRunner>().mockReturnValue(
      JSON.stringify({
        number: 314,
        html_url: 'https://github.com/acme/widgets/issues/314',
      })
    );

    const summary = await syncGitHubIntakeGate({
      projectDb: db,
      config: createConfig(),
      env,
      runGhCommand,
      now: () => new Date('2026-03-13T12:00:00Z'),
    });

    expect(summary).toMatchObject({
      status: 'success',
      issuesCreated: 1,
      approvalsApplied: 0,
      rejectionsApplied: 0,
    });
    expect(runGhCommand).toHaveBeenCalledWith(
      [
        'api',
        '--hostname',
        'github.com',
        '--method',
        'POST',
        'repos/acme/widgets/issues',
        '-f',
        'title=Approve intake report github#42: Checkout fails on empty cart',
        '-f',
        expect.stringContaining('body=Approve or reject this intake report for internal triage.'),
        '-f',
        `labels[]=${GITHUB_GATE_LABEL}`,
        '-f',
        `labels[]=${GITHUB_GATE_PENDING_LABEL}`,
      ],
      expect.objectContaining({
        GITHUB_TOKEN: 'secret-token',
        GH_TOKEN: 'secret-token',
      })
    );

    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'open',
        linkedTaskId: null,
        payload: expect.objectContaining({
          githubGate: expect.objectContaining({
            issueNumber: 314,
            issueUrl: 'https://github.com/acme/widgets/issues/314',
            decision: 'pending',
            requestedAt: '2026-03-13T12:00:00.000Z',
          }),
        }),
      })
    );
  });

  it('creates a triage task exactly once after an explicit approval label appears', async () => {
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
      .fn<GhRunner>()
      .mockReturnValueOnce(
        JSON.stringify({
          number: 314,
          html_url: 'https://github.com/acme/widgets/issues/314',
          labels: [{ name: GITHUB_GATE_LABEL }, { name: GITHUB_GATE_APPROVED_LABEL }],
        })
      )
      .mockReturnValueOnce(JSON.stringify([{ name: GITHUB_GATE_LABEL }, { name: GITHUB_GATE_APPROVED_LABEL }]));

    const summary = await syncGitHubIntakeGate({
      projectDb: db,
      config: createConfig(),
      env,
      runGhCommand,
      now: () => new Date('2026-03-13T12:05:00Z'),
    });

    const triageSection = getSectionByName(db, 'Bug Intake: Triage');
    const tasks = listTasks(db, { status: 'all' });

    expect(summary).toMatchObject({
      status: 'success',
      issuesCreated: 0,
      approvalsApplied: 1,
      rejectionsApplied: 0,
    });
    expect(triageSection).not.toBeNull();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual(
      expect.objectContaining({
        title: 'Triage intake report github#42: Checkout fails on empty cart',
        section_id: triageSection?.id,
        status: 'pending',
      })
    );
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'triaged',
        linkedTaskId: tasks[0]?.id,
        payload: expect.objectContaining({
          githubGate: expect.objectContaining({
            decision: 'approved',
            decisionAppliedAt: '2026-03-13T12:05:00.000Z',
            linkedTaskId: tasks[0]?.id,
          }),
        }),
      })
    );

    await syncGitHubIntakeGate({
      projectDb: db,
      config: createConfig(),
      env,
      runGhCommand,
      now: () => new Date('2026-03-13T12:06:00Z'),
    });

    expect(listTasks(db, { status: 'all' })).toHaveLength(1);
  });

  it('marks the report ignored after an explicit rejection label appears', async () => {
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
      .fn<GhRunner>()
      .mockReturnValueOnce(
        JSON.stringify({
          number: 314,
          html_url: 'https://github.com/acme/widgets/issues/314',
          labels: [{ name: GITHUB_GATE_LABEL }, { name: GITHUB_GATE_REJECTED_LABEL }],
        })
      )
      .mockReturnValueOnce(JSON.stringify([{ name: GITHUB_GATE_LABEL }, { name: GITHUB_GATE_REJECTED_LABEL }]));

    const summary = await syncGitHubIntakeGate({
      projectDb: db,
      config: createConfig(),
      env,
      runGhCommand,
      now: () => new Date('2026-03-13T12:10:00Z'),
    });

    expect(summary).toMatchObject({
      status: 'success',
      issuesCreated: 0,
      approvalsApplied: 0,
      rejectionsApplied: 1,
    });
    expect(listTasks(db, { status: 'all' })).toHaveLength(0);
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'ignored',
        linkedTaskId: null,
        resolvedAt: '2026-03-13T12:10:00.000Z',
        payload: expect.objectContaining({
          githubGate: expect.objectContaining({
            decision: 'rejected',
            decisionAppliedAt: '2026-03-13T12:10:00.000Z',
          }),
        }),
      })
    );
  });

  it('skips terminal or already-linked reports', async () => {
    const section = createSection(db, 'General');
    const linkedTask = createTask(db, 'Existing intake task', { sectionId: section.id });
    upsertIntakeReport(db, createReport({ externalId: '1', status: 'resolved' }));
    upsertIntakeReport(db, createReport({ externalId: '2', status: 'ignored' }));
    upsertIntakeReport(db, createReport({ externalId: '3' }), { linkedTaskId: linkedTask.id });
    const runGhCommand = jest.fn<GhRunner>();

    const summary = await syncGitHubIntakeGate({
      projectDb: db,
      config: createConfig(),
      env,
      runGhCommand,
    });

    expect(summary.status).toBe('skipped');
    expect(runGhCommand).not.toHaveBeenCalled();
    expect(listIntakeReports(db, { source: 'github' })).toHaveLength(3);
  });
});
