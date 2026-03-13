import type Database from 'better-sqlite3';
import type { SteroidsConfig } from '../config/loader.js';
import { getIntakeReport, updateIntakeReportState } from '../database/intake-queries.js';
import { getSection, listTasks } from '../database/queries.js';
import { createIntakeRegistry, type IntakeRegistry } from './registry.js';
import { parseIntakeTaskReference, type IntakeTaskReference } from './task-reference.js';

export interface HandleIntakePostPROptions {
  db: Database.Database;
  sectionId: string | null | undefined;
  prNumber: number | null;
  config: SteroidsConfig;
  createRegistry?: (config: Partial<SteroidsConfig>) => IntakeRegistry;
}

export interface IntakePostPRResult {
  handled: boolean;
  reportsResolved: number;
}

function buildResolutionMessage(prNumber: number): string {
  return `Fixed in PR #${prNumber}.`;
}

function collectFixTaskReferences(
  tasks: ReturnType<typeof listTasks>
): IntakeTaskReference[] {
  const references = tasks
    .map((task) => parseIntakeTaskReference(task))
    .filter((reference): reference is IntakeTaskReference => (
      reference !== null && reference.phase === 'fix'
    ));

  return references.filter((reference, index) => (
    references.findIndex(
      (candidate) => candidate.source === reference.source && candidate.externalId === reference.externalId
    ) === index
  ));
}

export async function handleIntakePostPR(
  options: HandleIntakePostPROptions
): Promise<IntakePostPRResult> {
  const { db, sectionId, prNumber, config, createRegistry = createIntakeRegistry } = options;

  if (!sectionId || prNumber === null) {
    return { handled: false, reportsResolved: 0 };
  }

  const section = getSection(db, sectionId);
  if (!section) {
    return { handled: false, reportsResolved: 0 };
  }

  const references = collectFixTaskReferences(listTasks(db, { sectionId, status: 'all' }));
  if (references.length === 0) {
    return { handled: false, reportsResolved: 0 };
  }

  let registry: IntakeRegistry | null = null;
  try {
    registry = createRegistry(config);
  } catch (error) {
    console.warn(
      `[intake-post-pr] Failed to initialize intake registry for section "${section.name}":`,
      error instanceof Error ? error.message : String(error)
    );
    return { handled: false, reportsResolved: 0 };
  }

  let reportsResolved = 0;

  for (const reference of references) {
    const report = getIntakeReport(db, reference.source, reference.externalId);
    if (!report || report.status === 'resolved') {
      continue;
    }

    const resolvedAt = new Date().toISOString();
    const connector = registry?.tryGet(report.source);

    if (connector?.capabilities.resolutionNotifications) {
      try {
        await connector.notifyResolution({
          report: {
            source: report.source,
            externalId: report.externalId,
            url: report.url,
          },
          resolvedAt,
          resolution: 'fixed',
          message: buildResolutionMessage(prNumber),
          metadata: { prNumber },
        });
      } catch (error) {
        console.warn(
          `[intake-post-pr] Failed to notify ${report.source} for ${report.source}#${report.externalId}:`,
          error instanceof Error ? error.message : String(error)
        );
        continue;
      }
    }

    updateIntakeReportState(db, report.source, report.externalId, {
      status: 'resolved',
      resolvedAt,
    });
    reportsResolved += 1;
  }

  return {
    handled: reportsResolved > 0,
    reportsResolved,
  };
}
