import type Database from 'better-sqlite3';
import type { SteroidsConfig } from '../config/loader.js';
import {
  getIntakePollState,
  listIntakeReports,
  upsertIntakePollState,
  upsertIntakeReport,
} from '../database/intake-queries.js';
import { createIntakeRegistry, type IntakeRegistry } from './registry.js';
import type { IntakeSource } from './types.js';

export interface IntakeConnectorPollResult {
  source: IntakeSource;
  status: 'skipped' | 'success' | 'error';
  reportsPersisted: number;
  nextCursor: string | null;
  reason: string;
}

export interface IntakePollSummary {
  status: 'skipped' | 'success' | 'partial' | 'error';
  reason: string;
  totalReportsPersisted: number;
  connectorResults: IntakeConnectorPollResult[];
}

export interface PollIntakeProjectOptions {
  projectDb: Database.Database;
  config: SteroidsConfig;
  dryRun?: boolean;
  now?: () => Date;
  createRegistry?: (config: Partial<SteroidsConfig>) => IntakeRegistry;
}

const DEFAULT_POLL_INTERVAL_MINUTES = 15;
const DEFAULT_MAX_REPORTS_PER_POLL = 50;

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (Number.isInteger(value) && value !== undefined && value > 0) {
    return value;
  }

  return fallback;
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldPollConnector(
  lastPolledAt: string | null | undefined,
  pollIntervalMs: number,
  nowMs: number
): boolean {
  const lastPolledAtMs = parseTimestampMs(lastPolledAt);
  if (lastPolledAtMs === null) {
    return true;
  }

  return nowMs - lastPolledAtMs >= pollIntervalMs;
}

function summarizePollResults(results: IntakeConnectorPollResult[]): IntakePollSummary {
  if (results.length === 0) {
    return {
      status: 'skipped',
      reason: 'No enabled intake connectors',
      totalReportsPersisted: 0,
      connectorResults: [],
    };
  }

  const totalReportsPersisted = results.reduce((sum, result) => sum + result.reportsPersisted, 0);
  const successCount = results.filter((result) => result.status === 'success').length;
  const errorCount = results.filter((result) => result.status === 'error').length;

  if (successCount === 0 && errorCount === 0) {
    return {
      status: 'skipped',
      reason: 'No intake connectors were due for polling',
      totalReportsPersisted,
      connectorResults: results,
    };
  }

  if (errorCount === 0) {
    return {
      status: 'success',
      reason: `Persisted ${totalReportsPersisted} intake report(s) across ${successCount} connector(s)`,
      totalReportsPersisted,
      connectorResults: results,
    };
  }

  if (successCount === 0) {
    return {
      status: 'error',
      reason: `Intake polling failed for ${errorCount} connector(s)`,
      totalReportsPersisted,
      connectorResults: results,
    };
  }

  return {
    status: 'partial',
    reason: `Persisted ${totalReportsPersisted} intake report(s); ${errorCount} connector(s) failed`,
    totalReportsPersisted,
    connectorResults: results,
  };
}

export async function pollIntakeProject(options: PollIntakeProjectOptions): Promise<IntakePollSummary> {
  const {
    projectDb,
    config,
    dryRun = false,
    now = () => new Date(),
    createRegistry = createIntakeRegistry,
  } = options;

  if (dryRun) {
    return {
      status: 'skipped',
      reason: 'Dry-run mode does not poll intake connectors',
      totalReportsPersisted: 0,
      connectorResults: [],
    };
  }

  if (config.intake?.enabled !== true) {
    return {
      status: 'skipped',
      reason: 'Intake disabled',
      totalReportsPersisted: 0,
      connectorResults: [],
    };
  }

  let registry: IntakeRegistry;
  try {
    registry = createRegistry(config);
  } catch (error) {
    return {
      status: 'error',
      reason: error instanceof Error ? error.message : String(error),
      totalReportsPersisted: 0,
      connectorResults: [],
    };
  }

  const pollIntervalMinutes = normalizePositiveInteger(
    config.intake.pollIntervalMinutes,
    DEFAULT_POLL_INTERVAL_MINUTES
  );
  const maxReportsPerPoll = normalizePositiveInteger(
    config.intake.maxReportsPerPoll,
    DEFAULT_MAX_REPORTS_PER_POLL
  );
  const pollIntervalMs = pollIntervalMinutes * 60_000;
  const connectorResults: IntakeConnectorPollResult[] = [];

  const connectors = registry
    .getAll()
    .filter((connector) => connector.capabilities.pull)
    .sort((left, right) => left.source.localeCompare(right.source));

  for (const connector of connectors) {
    const startedAt = now().toISOString();
    const state = getIntakePollState(projectDb, connector.source);

    if (!shouldPollConnector(state?.lastPolledAt, pollIntervalMs, Date.parse(startedAt))) {
      connectorResults.push({
        source: connector.source,
        status: 'skipped',
        reportsPersisted: 0,
        nextCursor: state?.cursor ?? null,
        reason: 'Poll interval has not elapsed',
      });
      continue;
    }

    try {
      // lastSuccessAt only advances when a connector sweep reaches its terminal page.
      // This keeps page-based cursor continuation anchored to the last completed watermark.
      const pullResult = await connector.pullReports({
        cursor: state?.cursor ?? undefined,
        limit: maxReportsPerPoll,
        since: state?.lastSuccessAt ?? undefined,
      });

      projectDb.transaction(() => {
        for (const report of pullResult.reports) {
          upsertIntakeReport(projectDb, report);
        }

        upsertIntakePollState(projectDb, {
          source: connector.source,
          cursor: pullResult.nextCursor ?? null,
          lastPolledAt: startedAt,
          lastSuccessAt: pullResult.nextCursor ? state?.lastSuccessAt ?? null : startedAt,
          lastErrorAt: null,
          lastErrorMessage: null,
        });
      })();

      connectorResults.push({
        source: connector.source,
        status: 'success',
        reportsPersisted: pullResult.reports.length,
        nextCursor: pullResult.nextCursor ?? null,
        reason:
          pullResult.reports.length > 0
            ? `Persisted ${pullResult.reports.length} report(s)`
            : 'No updated reports',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertIntakePollState(projectDb, {
        source: connector.source,
        lastPolledAt: startedAt,
        lastErrorAt: startedAt,
        lastErrorMessage: message,
      });

      connectorResults.push({
        source: connector.source,
        status: 'error',
        reportsPersisted: 0,
        nextCursor: state?.cursor ?? null,
        reason: message,
      });
    }
  }

  return summarizePollResults(connectorResults);
}

export function countPersistedIntakeReports(projectDb: Database.Database): number {
  return listIntakeReports(projectDb).length;
}
