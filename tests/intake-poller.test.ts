import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';

import { SCHEMA_SQL } from '../src/database/schema.js';
import { getIntakePollState, listIntakeReports, upsertIntakePollState } from '../src/database/intake-queries.js';
import { IntakeRegistry } from '../src/intake/registry.js';
import { pollIntakeProject } from '../src/intake/poller.js';
import type { SteroidsConfig } from '../src/config/loader.js';
import type { IntakeConnector, IntakeReport } from '../src/intake/types.js';

function createSampleReport(externalId: string, updatedAt: string): IntakeReport {
  return {
    source: 'github',
    externalId,
    url: `https://github.com/acme/widgets/issues/${externalId}`,
    fingerprint: `github:acme/widgets#${externalId}`,
    title: `Issue ${externalId}`,
    summary: 'Sample issue',
    severity: 'high',
    status: 'open',
    createdAt: '2026-03-10T10:00:00Z',
    updatedAt,
    tags: ['bug'],
    payload: { externalId },
  };
}

function createConfig(overrides: Partial<SteroidsConfig> = {}): SteroidsConfig {
  return {
    intake: {
      enabled: true,
      pollIntervalMinutes: 15,
      maxReportsPerPoll: 2,
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
    ...overrides,
  } as SteroidsConfig;
}

function createRegistry(connector: IntakeConnector): IntakeRegistry {
  const registry = new IntakeRegistry();
  registry.register(connector);
  return registry;
}

describe('pollIntakeProject', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it('persists reports and only advances lastSuccessAt after a paginated sweep completes', async () => {
    const pullReports = jest
      .fn<IntakeConnector['pullReports']>()
      .mockResolvedValueOnce({
        reports: [createSampleReport('41', '2026-03-12T09:00:00Z')],
        nextCursor: '2',
      })
      .mockResolvedValueOnce({
        reports: [createSampleReport('42', '2026-03-12T09:05:00Z')],
      });

    const connector: IntakeConnector = {
      source: 'github',
      capabilities: {
        pull: true,
        pushUpdates: false,
        resolutionNotifications: false,
      },
      pullReports,
      async pushUpdate() {
        return { accepted: true };
      },
      async notifyResolution() {
        return;
      },
    };

    const config = createConfig();
    const createRegistryForTest = () => createRegistry(connector);

    const first = await pollIntakeProject({
      projectDb: db,
      config,
      now: () => new Date('2026-03-12T10:00:00Z'),
      createRegistry: createRegistryForTest,
    });

    expect(first.status).toBe('success');
    expect(first.totalReportsPersisted).toBe(1);
    expect(pullReports).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      limit: 2,
      since: undefined,
    });
    expect(getIntakePollState(db, 'github')).toEqual(
      expect.objectContaining({
        source: 'github',
        cursor: '2',
        lastPolledAt: '2026-03-12T10:00:00.000Z',
        lastSuccessAt: null,
      })
    );

    const second = await pollIntakeProject({
      projectDb: db,
      config,
      now: () => new Date('2026-03-12T10:16:00Z'),
      createRegistry: createRegistryForTest,
    });

    expect(second.status).toBe('success');
    expect(second.totalReportsPersisted).toBe(1);
    expect(pullReports).toHaveBeenNthCalledWith(2, {
      cursor: '2',
      limit: 2,
      since: undefined,
    });
    expect(getIntakePollState(db, 'github')).toEqual(
      expect.objectContaining({
        source: 'github',
        cursor: null,
        lastPolledAt: '2026-03-12T10:16:00.000Z',
        lastSuccessAt: '2026-03-12T10:16:00.000Z',
        lastErrorAt: null,
        lastErrorMessage: null,
      })
    );
    expect(listIntakeReports(db).map((report) => report.externalId)).toEqual(['42', '41']);
  });

  it('skips polling when the configured interval has not elapsed', async () => {
    const pullReports = jest.fn<IntakeConnector['pullReports']>().mockResolvedValue({ reports: [] });
    const connector: IntakeConnector = {
      source: 'github',
      capabilities: {
        pull: true,
        pushUpdates: false,
        resolutionNotifications: false,
      },
      pullReports,
      async pushUpdate() {
        return { accepted: true };
      },
      async notifyResolution() {
        return;
      },
    };

    upsertIntakePollState(db, {
      source: 'github',
      lastPolledAt: '2026-03-12T10:00:00.000Z',
      lastSuccessAt: '2026-03-12T10:00:00.000Z',
    });

    const summary = await pollIntakeProject({
      projectDb: db,
      config: createConfig(),
      now: () => new Date('2026-03-12T10:10:00Z'),
      createRegistry: () => createRegistry(connector),
    });

    expect(summary.status).toBe('skipped');
    expect(summary.connectorResults).toEqual([
      {
        source: 'github',
        status: 'skipped',
        reportsPersisted: 0,
        nextCursor: null,
        reason: 'Poll interval has not elapsed',
      },
    ]);
    expect(pullReports).not.toHaveBeenCalled();
  });

  it('records poll errors without clearing the existing cursor or last successful watermark', async () => {
    const connector: IntakeConnector = {
      source: 'github',
      capabilities: {
        pull: true,
        pushUpdates: false,
        resolutionNotifications: false,
      },
      pullReports: jest.fn(async () => {
        throw new Error('gh unavailable');
      }),
      async pushUpdate() {
        return { accepted: true };
      },
      async notifyResolution() {
        return;
      },
    };

    upsertIntakePollState(db, {
      source: 'github',
      cursor: '3',
      lastPolledAt: '2026-03-12T09:00:00.000Z',
      lastSuccessAt: '2026-03-12T08:30:00.000Z',
    });

    const summary = await pollIntakeProject({
      projectDb: db,
      config: createConfig({ intake: { enabled: true, pollIntervalMinutes: 1, maxReportsPerPoll: 2 } }),
      now: () => new Date('2026-03-12T10:00:00Z'),
      createRegistry: () => createRegistry(connector),
    });

    expect(summary.status).toBe('error');
    expect(summary.connectorResults).toEqual([
      {
        source: 'github',
        status: 'error',
        reportsPersisted: 0,
        nextCursor: '3',
        reason: 'gh unavailable',
      },
    ]);
    expect(getIntakePollState(db, 'github')).toEqual(
      expect.objectContaining({
        source: 'github',
        cursor: '3',
        lastPolledAt: '2026-03-12T10:00:00.000Z',
        lastSuccessAt: '2026-03-12T08:30:00.000Z',
        lastErrorAt: '2026-03-12T10:00:00.000Z',
        lastErrorMessage: 'gh unavailable',
      })
    );
  });
});
