import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { SCHEMA_SQL } from '../src/database/schema.js';
import { createSection, createTask } from '../src/database/queries.js';
import { getIntakeReport, upsertIntakeReport } from '../src/database/intake-queries.js';
import { handleIntakePostPR } from '../src/intake/post-pr.js';
import { DEFAULT_INTAKE_PIPELINE_SOURCE_FILE } from '../src/intake/task-templates.js';
import { IntakeRegistry } from '../src/intake/registry.js';
import type { SteroidsConfig } from '../src/config/loader.js';
import type {
  IntakeConnector,
  IntakeReport,
  PullIntakeReportsResult,
  PushIntakeUpdateResult,
} from '../src/intake/types.js';

function createSampleReport(overrides: Partial<IntakeReport> = {}): IntakeReport {
  return {
    source: 'github',
    externalId: '42',
    url: 'https://github.com/acme/widgets/issues/42',
    fingerprint: 'github:acme/widgets#42',
    title: 'Checkout fails on empty cart',
    summary: 'Stack trace attached',
    severity: 'high',
    status: 'in_progress',
    createdAt: '2026-03-10T10:00:00Z',
    updatedAt: '2026-03-10T11:00:00Z',
    tags: ['bug', 'checkout'],
    payload: { body: 'Stack trace attached' },
    ...overrides,
  };
}

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
        },
      },
    },
  } as SteroidsConfig;
}

function createRegistry(connector: IntakeConnector): IntakeRegistry {
  const registry = new IntakeRegistry();
  registry.register(connector);
  return registry;
}

async function unusedPullReports(): Promise<PullIntakeReportsResult> {
  return { reports: [] };
}

async function unusedPushUpdate(): Promise<PushIntakeUpdateResult> {
  return { accepted: true };
}

describe('handleIntakePostPR', () => {
  let db: Database.Database;
  let consoleWarnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    db.close();
  });

  it('notifies the source connector for fix tasks and marks the report resolved', async () => {
    const section = createSection(db, 'Bug Intake: Fix');
    const fixTask = createTask(
      db,
      'Fix intake report github#42: Checkout fails on empty cart',
      {
        sectionId: section.id,
        sourceFile: DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
        status: 'completed',
      }
    );
    upsertIntakeReport(db, createSampleReport(), { linkedTaskId: fixTask.id });

    const notifyResolution = jest.fn<IntakeConnector['notifyResolution']>().mockResolvedValue(undefined);
    const connector: IntakeConnector = {
      source: 'github',
      capabilities: {
        pull: true,
        pushUpdates: true,
        resolutionNotifications: true,
      },
      pullReports: unusedPullReports,
      pushUpdate: unusedPushUpdate,
      notifyResolution,
    };

    const result = await handleIntakePostPR({
      db,
      sectionId: section.id,
      prNumber: 123,
      config: createConfig(),
      createRegistry: () => createRegistry(connector),
    });

    expect(result).toEqual({ handled: true, reportsResolved: 1 });
    expect(notifyResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        report: {
          source: 'github',
          externalId: '42',
          url: 'https://github.com/acme/widgets/issues/42',
        },
        resolution: 'fixed',
        message: 'Fixed in PR #123.',
        metadata: { prNumber: 123 },
      })
    );
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'resolved',
        linkedTaskId: fixTask.id,
      })
    );
    expect(getIntakeReport(db, 'github', '42')?.resolvedAt).toBeTruthy();
  });

  it('skips duplicate source notifications for reports already resolved', async () => {
    const section = createSection(db, 'Bug Intake: Fix');
    createTask(
      db,
      'Fix intake report github#42: Checkout fails on empty cart',
      {
        sectionId: section.id,
        sourceFile: DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
        status: 'completed',
      }
    );
    upsertIntakeReport(
      db,
      createSampleReport({
        status: 'resolved',
        resolvedAt: '2026-03-13T09:00:00.000Z',
      })
    );

    const notifyResolution = jest.fn<IntakeConnector['notifyResolution']>().mockResolvedValue(undefined);
    const connector: IntakeConnector = {
      source: 'github',
      capabilities: {
        pull: true,
        pushUpdates: true,
        resolutionNotifications: true,
      },
      pullReports: unusedPullReports,
      pushUpdate: unusedPushUpdate,
      notifyResolution,
    };

    const result = await handleIntakePostPR({
      db,
      sectionId: section.id,
      prNumber: 123,
      config: createConfig(),
      createRegistry: () => createRegistry(connector),
    });

    expect(result).toEqual({ handled: false, reportsResolved: 0 });
    expect(notifyResolution).not.toHaveBeenCalled();
  });

  it('leaves the report in progress when source notification fails so the hook can retry', async () => {
    const section = createSection(db, 'Bug Intake: Fix');
    createTask(
      db,
      'Fix intake report github#42: Checkout fails on empty cart',
      {
        sectionId: section.id,
        sourceFile: DEFAULT_INTAKE_PIPELINE_SOURCE_FILE,
        status: 'completed',
      }
    );
    upsertIntakeReport(db, createSampleReport());

    const notifyResolution = jest.fn<IntakeConnector['notifyResolution']>().mockRejectedValue(new Error('gh unavailable'));
    const connector: IntakeConnector = {
      source: 'github',
      capabilities: {
        pull: true,
        pushUpdates: true,
        resolutionNotifications: true,
      },
      pullReports: unusedPullReports,
      pushUpdate: unusedPushUpdate,
      notifyResolution,
    };

    const result = await handleIntakePostPR({
      db,
      sectionId: section.id,
      prNumber: 123,
      config: createConfig(),
      createRegistry: () => createRegistry(connector),
    });

    expect(result).toEqual({ handled: false, reportsResolved: 0 });
    expect(getIntakeReport(db, 'github', '42')).toEqual(
      expect.objectContaining({
        status: 'in_progress',
      })
    );
    expect(getIntakeReport(db, 'github', '42')?.resolvedAt).toBeUndefined();
  });
});
