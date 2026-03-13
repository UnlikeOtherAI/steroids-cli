import type Database from 'better-sqlite3';
import type { SteroidsConfig } from '../config/loader.js';
import {
  GITHUB_GATE_APPROVED_LABEL,
  GITHUB_GATE_REJECTED_LABEL,
  collectLabelNames,
  createApprovalIssue,
  defaultRunGhCommand,
  fetchGateIssue,
  getGitHubGateRuntime,
  parseGateDecision,
  replaceManagedLabels,
  type GitHubGateDecision,
} from './github-gate-api.js';
import {
  getIntakeReport,
  listIntakeReports,
  upsertIntakeReport,
  type StoredIntakeReport,
} from '../database/intake-queries.js';
import * as taskQueries from '../database/queries.js';
import { buildIntakeTaskTemplate, getIntakeTaskSectionName } from './task-templates.js';
import { triggerHooksSafely, triggerIntakeTriaged } from '../hooks/integration.js';

export {
  GITHUB_GATE_APPROVED_LABEL,
  GITHUB_GATE_LABEL,
  GITHUB_GATE_MANAGED_LABELS,
  GITHUB_GATE_PENDING_LABEL,
  GITHUB_GATE_REJECTED_LABEL,
  isManagedGitHubGateLabel,
} from './github-gate-api.js';

interface GitHubGateState {
  issueNumber?: number;
  issueUrl?: string;
  decision?: GitHubGateDecision;
  requestedAt?: string;
  decisionAppliedAt?: string;
  linkedTaskId?: string;
}

export interface GitHubGateSummary {
  status: 'skipped' | 'success' | 'partial' | 'error';
  reason: string;
  issuesCreated: number;
  approvalsApplied: number;
  rejectionsApplied: number;
  errors: string[];
}

export interface SyncGitHubIntakeGateOptions {
  projectDb: Database.Database;
  config: SteroidsConfig;
  projectPath?: string;
  dryRun?: boolean;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  runGhCommand?: (args: string[], env: NodeJS.ProcessEnv) => string;
}

function getGateState(report: StoredIntakeReport): GitHubGateState {
  const raw = report.payload.githubGate;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }

  const state = raw as Record<string, unknown>;
  return {
    issueNumber: typeof state.issueNumber === 'number' && Number.isInteger(state.issueNumber) ? state.issueNumber : undefined,
    issueUrl: typeof state.issueUrl === 'string' && state.issueUrl.trim() !== '' ? state.issueUrl.trim() : undefined,
    decision: state.decision === 'pending' || state.decision === 'approved' || state.decision === 'rejected'
      ? state.decision
      : undefined,
    requestedAt: typeof state.requestedAt === 'string' && state.requestedAt.trim() !== '' ? state.requestedAt.trim() : undefined,
    decisionAppliedAt: typeof state.decisionAppliedAt === 'string' && state.decisionAppliedAt.trim() !== ''
      ? state.decisionAppliedAt.trim()
      : undefined,
    linkedTaskId: typeof state.linkedTaskId === 'string' && state.linkedTaskId.trim() !== '' ? state.linkedTaskId.trim() : undefined,
  };
}

function setGateState(
  db: Database.Database,
  report: StoredIntakeReport,
  gateState: GitHubGateState,
  overrides: {
    status?: StoredIntakeReport['status'];
    linkedTaskId?: string | null;
    resolvedAt?: string | null;
  } = {}
): StoredIntakeReport {
  return upsertIntakeReport(
    db,
    {
      source: report.source,
      externalId: report.externalId,
      url: report.url,
      fingerprint: report.fingerprint,
      title: report.title,
      summary: report.summary,
      severity: report.severity,
      status: overrides.status ?? report.status,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      resolvedAt: Object.prototype.hasOwnProperty.call(overrides, 'resolvedAt')
        ? overrides.resolvedAt ?? undefined
        : report.resolvedAt,
      tags: report.tags,
      payload: {
        ...report.payload,
        githubGate: {
          ...(report.payload.githubGate as Record<string, unknown> | undefined),
          ...gateState,
        },
      },
    },
    {
      linkedTaskId: Object.prototype.hasOwnProperty.call(overrides, 'linkedTaskId')
        ? overrides.linkedTaskId ?? null
        : report.linkedTaskId,
    }
  );
}


function getOrCreateSectionId(db: Database.Database, sectionName: string): string {
  const existing = taskQueries.getSectionByName(db, sectionName);
  if (existing) {
    return existing.id;
  }

  return taskQueries.createSection(db, sectionName).id;
}

function createTriageTask(db: Database.Database, report: StoredIntakeReport): string {
  const template = buildIntakeTaskTemplate('triage', report);
  const sectionId = getOrCreateSectionId(db, getIntakeTaskSectionName('triage'));
  return taskQueries.createTask(db, template.title, {
    sectionId,
    sourceFile: template.sourceFile,
  }).id;
}

function summarize(summary: Omit<GitHubGateSummary, 'status' | 'reason'>): GitHubGateSummary {
  if (summary.errors.length > 0 && summary.issuesCreated === 0 && summary.approvalsApplied === 0 && summary.rejectionsApplied === 0) {
    return {
      ...summary,
      status: 'error',
      reason: summary.errors[0],
    };
  }

  if (summary.errors.length > 0) {
    return {
      ...summary,
      status: 'partial',
      reason: `Created ${summary.issuesCreated} gate issue(s), applied ${summary.approvalsApplied} approval(s), applied ${summary.rejectionsApplied} rejection(s), ${summary.errors.length} error(s)`,
    };
  }

  const totalActions = summary.issuesCreated + summary.approvalsApplied + summary.rejectionsApplied;
  if (totalActions === 0) {
    return {
      ...summary,
      status: 'skipped',
      reason: 'No GitHub intake gate work',
    };
  }

  return {
    ...summary,
    status: 'success',
    reason: `Created ${summary.issuesCreated} gate issue(s), applied ${summary.approvalsApplied} approval(s), applied ${summary.rejectionsApplied} rejection(s)`,
  };
}

export async function syncGitHubIntakeGate(
  options: SyncGitHubIntakeGateOptions
): Promise<GitHubGateSummary> {
  const {
    projectDb,
    config,
    dryRun = false,
    now = () => new Date(),
    env = process.env,
    runGhCommand = defaultRunGhCommand,
  } = options;

  if (dryRun) {
    return {
      status: 'skipped',
      reason: 'Dry-run mode does not modify GitHub intake gate state',
      issuesCreated: 0,
      approvalsApplied: 0,
      rejectionsApplied: 0,
      errors: [],
    };
  }

  const runtime = getGitHubGateRuntime(config, env);
  if (!runtime) {
    return {
      status: 'skipped',
      reason: 'GitHub intake gate disabled',
      issuesCreated: 0,
      approvalsApplied: 0,
      rejectionsApplied: 0,
      errors: [],
    };
  }

  const reports = listIntakeReports(projectDb, {
    source: 'github',
    hasLinkedTask: false,
  }).filter((report) => report.status !== 'resolved' && report.status !== 'ignored');

  const summary = {
    issuesCreated: 0,
    approvalsApplied: 0,
    rejectionsApplied: 0,
    errors: [] as string[],
  };

  for (const report of reports) {
    try {
      const gate = getGateState(report);

      if (!gate.issueNumber || !gate.issueUrl) {
        const created = createApprovalIssue(runtime, report, runGhCommand);
        setGateState(projectDb, report, {
          issueNumber: created.issueNumber,
          issueUrl: created.issueUrl,
          decision: 'pending',
          requestedAt: now().toISOString(),
        });
        summary.issuesCreated += 1;
        continue;
      }

      if (gate.decisionAppliedAt) {
        continue;
      }

      const issue = fetchGateIssue(runtime, gate.issueNumber, runGhCommand);
      const labels = collectLabelNames(issue.labels);
      const decision = parseGateDecision(labels);

      if (decision === 'pending') {
        replaceManagedLabels(runtime, gate.issueNumber, labels, 'pending', runGhCommand);
        continue;
      }

      if (decision === 'approved') {
        const freshReport = getIntakeReport(projectDb, report.source, report.externalId);
        if (!freshReport) {
          throw new Error(`Missing intake report ${report.source}#${report.externalId} during approval application`);
        }

        let taskId = freshReport.linkedTaskId;
        let triagedReport: StoredIntakeReport | null = null;
        projectDb.transaction(() => {
          const current = getIntakeReport(projectDb, report.source, report.externalId);
          if (!current) {
            throw new Error(`Missing intake report ${report.source}#${report.externalId} during approval transaction`);
          }
          taskId = current.linkedTaskId ?? createTriageTask(projectDb, current);
          triagedReport = setGateState(projectDb, current, {
            ...gate,
            issueNumber: gate.issueNumber,
            issueUrl: gate.issueUrl,
            decision: 'approved',
            decisionAppliedAt: now().toISOString(),
            linkedTaskId: taskId ?? undefined,
          }, {
            status: 'triaged',
            linkedTaskId: taskId ?? null,
            resolvedAt: null,
          });
        })();

        if (triagedReport) {
          const reportForHook = triagedReport;
          await triggerHooksSafely(
            () => triggerIntakeTriaged(reportForHook, taskId ?? null, { projectPath: options.projectPath }),
            { verbose: false }
          );
        }

        replaceManagedLabels(runtime, gate.issueNumber, labels, 'approved', runGhCommand);
        summary.approvalsApplied += 1;
        continue;
      }

      const resolvedAt = now().toISOString();
      projectDb.transaction(() => {
        const current = getIntakeReport(projectDb, report.source, report.externalId);
        if (!current) {
          throw new Error(`Missing intake report ${report.source}#${report.externalId} during rejection transaction`);
        }
        setGateState(projectDb, current, {
          ...gate,
          issueNumber: gate.issueNumber,
          issueUrl: gate.issueUrl,
          decision: 'rejected',
          decisionAppliedAt: resolvedAt,
        }, {
          status: 'ignored',
          linkedTaskId: null,
          resolvedAt,
        });
      })();

      replaceManagedLabels(runtime, gate.issueNumber, labels, 'rejected', runGhCommand);
      summary.rejectionsApplied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push(`GitHub gate failed for ${report.source}#${report.externalId}: ${message}`);
    }
  }

  return summarize(summary);
}
