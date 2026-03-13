import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../../../dist/config/validator.js';
import {
  getIntakePollState,
  listIntakeReports,
  type StoredIntakeReport,
} from '../../../dist/database/intake-queries.js';
import type {
  IntakeConfig,
  IntakeReport,
  IntakeReportStatus,
  IntakeSeverity,
  IntakeSource,
} from '../../../dist/intake/types.js';
import { openSqliteForRead } from '../utils/sqlite.js';

export const INTAKE_SOURCES: IntakeSource[] = ['github', 'sentry'];
export const INTAKE_STATUSES: IntakeReportStatus[] = ['open', 'triaged', 'in_progress', 'resolved', 'ignored'];
export const INTAKE_SEVERITIES: IntakeSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export type ConnectorHealthStatus = 'disabled' | 'idle' | 'healthy' | 'error' | 'unsupported';

export interface IntakeReportUpdateBody {
  linkedTaskId?: string | null;
  fingerprint?: string;
  title?: string;
  summary?: string | null;
  severity?: IntakeSeverity;
  status?: IntakeReportStatus;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  resolvedAt?: string | null;
  tags?: string[];
  payload?: Record<string, unknown>;
}

export function openProjectDatabase(projectPath: string, readonly = true): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return null;
  }

  try {
    return readonly
      ? openSqliteForRead(dbPath)
      : new Database(dbPath, { fileMustExist: true, timeout: 5000 });
  } catch {
    return null;
  }
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return undefined;
}

export function parsePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function isIntakeSource(value: string): value is IntakeSource {
  return INTAKE_SOURCES.includes(value as IntakeSource);
}

export function isIntakeStatus(value: string): value is IntakeReportStatus {
  return INTAKE_STATUSES.includes(value as IntakeReportStatus);
}

export function isIntakeSeverity(value: string): value is IntakeSeverity {
  return INTAKE_SEVERITIES.includes(value as IntakeSeverity);
}

export function parseReportPayload(body: unknown): IntakeReport | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be an object' };
  }

  const payload = body as Record<string, unknown>;
  const source = payload.source;
  const severity = payload.severity;
  const status = payload.status;

  if (typeof source !== 'string' || !isIntakeSource(source)) {
    return { error: 'source must be one of: github, sentry' };
  }
  if (typeof payload.externalId !== 'string' || payload.externalId.trim() === '') {
    return { error: 'externalId must be a non-empty string' };
  }
  if (typeof payload.url !== 'string' || payload.url.trim() === '') {
    return { error: 'url must be a non-empty string' };
  }
  if (typeof payload.fingerprint !== 'string' || payload.fingerprint.trim() === '') {
    return { error: 'fingerprint must be a non-empty string' };
  }
  if (typeof payload.title !== 'string' || payload.title.trim() === '') {
    return { error: 'title must be a non-empty string' };
  }
  if (typeof severity !== 'string' || !isIntakeSeverity(severity)) {
    return { error: 'severity must be one of: critical, high, medium, low, info' };
  }
  if (typeof status !== 'string' || !isIntakeStatus(status)) {
    return { error: 'status must be one of: open, triaged, in_progress, resolved, ignored' };
  }
  if (typeof payload.createdAt !== 'string' || payload.createdAt.trim() === '') {
    return { error: 'createdAt must be a non-empty string' };
  }
  if (typeof payload.updatedAt !== 'string' || payload.updatedAt.trim() === '') {
    return { error: 'updatedAt must be a non-empty string' };
  }
  if (!Array.isArray(payload.tags) || payload.tags.some((tag) => typeof tag !== 'string')) {
    return { error: 'tags must be an array of strings' };
  }
  if (!payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) {
    return { error: 'payload must be an object' };
  }
  if (payload.summary !== undefined && payload.summary !== null && typeof payload.summary !== 'string') {
    return { error: 'summary must be a string when provided' };
  }
  if (payload.resolvedAt !== undefined && payload.resolvedAt !== null && typeof payload.resolvedAt !== 'string') {
    return { error: 'resolvedAt must be a string when provided' };
  }

  return {
    source,
    externalId: payload.externalId.trim(),
    url: payload.url.trim(),
    fingerprint: payload.fingerprint.trim(),
    title: payload.title.trim(),
    summary: typeof payload.summary === 'string' ? payload.summary : undefined,
    severity,
    status,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
    resolvedAt: typeof payload.resolvedAt === 'string' ? payload.resolvedAt : undefined,
    tags: payload.tags as string[],
    payload: payload.payload as Record<string, unknown>,
  };
}

export function parseReportUpdateBody(body: unknown): IntakeReportUpdateBody | { error: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be an object' };
  }

  const payload = body as Record<string, unknown>;
  const result: IntakeReportUpdateBody = {};
  let recognizedFieldCount = 0;

  if (Object.keys(payload).length === 0) {
    return { error: 'Request body must contain at least one updatable field' };
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'linkedTaskId')) {
    if (
      payload.linkedTaskId !== null &&
      payload.linkedTaskId !== undefined &&
      (typeof payload.linkedTaskId !== 'string' || payload.linkedTaskId.trim() === '')
    ) {
      return { error: 'linkedTaskId must be a non-empty string or null' };
    }
    result.linkedTaskId = typeof payload.linkedTaskId === 'string' ? payload.linkedTaskId.trim() : null;
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'fingerprint')) {
    if (typeof payload.fingerprint !== 'string' || payload.fingerprint.trim() === '') {
      return { error: 'fingerprint must be a non-empty string' };
    }
    result.fingerprint = payload.fingerprint.trim();
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'title')) {
    if (typeof payload.title !== 'string' || payload.title.trim() === '') {
      return { error: 'title must be a non-empty string' };
    }
    result.title = payload.title.trim();
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'summary')) {
    if (payload.summary !== null && payload.summary !== undefined && typeof payload.summary !== 'string') {
      return { error: 'summary must be a string or null' };
    }
    result.summary = payload.summary === null ? null : (payload.summary as string | undefined);
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'severity')) {
    if (typeof payload.severity !== 'string' || !isIntakeSeverity(payload.severity)) {
      return { error: 'severity must be one of: critical, high, medium, low, info' };
    }
    result.severity = payload.severity;
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
    if (typeof payload.status !== 'string' || !isIntakeStatus(payload.status)) {
      return { error: 'status must be one of: open, triaged, in_progress, resolved, ignored' };
    }
    result.status = payload.status;
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'url')) {
    if (typeof payload.url !== 'string' || payload.url.trim() === '') {
      return { error: 'url must be a non-empty string' };
    }
    result.url = payload.url.trim();
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'createdAt')) {
    if (typeof payload.createdAt !== 'string' || payload.createdAt.trim() === '') {
      return { error: 'createdAt must be a non-empty string' };
    }
    result.createdAt = payload.createdAt;
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'updatedAt')) {
    if (typeof payload.updatedAt !== 'string' || payload.updatedAt.trim() === '') {
      return { error: 'updatedAt must be a non-empty string' };
    }
    result.updatedAt = payload.updatedAt;
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'resolvedAt')) {
    if (payload.resolvedAt !== null && payload.resolvedAt !== undefined && typeof payload.resolvedAt !== 'string') {
      return { error: 'resolvedAt must be a string or null' };
    }
    result.resolvedAt = payload.resolvedAt === null ? null : (payload.resolvedAt as string | undefined);
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'tags')) {
    if (!Array.isArray(payload.tags) || payload.tags.some((tag) => typeof tag !== 'string')) {
      return { error: 'tags must be an array of strings' };
    }
    result.tags = payload.tags as string[];
    recognizedFieldCount += 1;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'payload')) {
    if (!payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) {
      return { error: 'payload must be an object' };
    }
    result.payload = payload.payload as Record<string, unknown>;
    recognizedFieldCount += 1;
  }

  if (recognizedFieldCount === 0) {
    return { error: 'Request body must contain at least one recognized updatable field' };
  }

  return result;
}

export function mergeReport(existing: StoredIntakeReport, updates: IntakeReportUpdateBody): IntakeReport {
  return {
    source: existing.source,
    externalId: existing.externalId,
    url: updates.url ?? existing.url,
    fingerprint: updates.fingerprint ?? existing.fingerprint,
    title: updates.title ?? existing.title,
    summary: updates.summary === null ? undefined : (updates.summary ?? existing.summary),
    severity: updates.severity ?? existing.severity,
    status: updates.status ?? existing.status,
    createdAt: updates.createdAt ?? existing.createdAt,
    updatedAt: updates.updatedAt ?? existing.updatedAt,
    resolvedAt: updates.resolvedAt === null ? undefined : (updates.resolvedAt ?? existing.resolvedAt),
    tags: updates.tags ?? existing.tags,
    payload: updates.payload ?? existing.payload,
  };
}

export function buildStats(reports: StoredIntakeReport[]) {
  const bySource = Object.fromEntries(INTAKE_SOURCES.map((source) => [source, 0])) as Record<IntakeSource, number>;
  const byStatus = Object.fromEntries(INTAKE_STATUSES.map((status) => [status, 0])) as Record<IntakeReportStatus, number>;
  const bySeverity = Object.fromEntries(
    INTAKE_SEVERITIES.map((severity) => [severity, 0])
  ) as Record<IntakeSeverity, number>;

  let linked = 0;
  let unlinked = 0;

  for (const report of reports) {
    bySource[report.source] += 1;
    byStatus[report.status] += 1;
    bySeverity[report.severity] += 1;
    if (report.linkedTaskId) linked += 1;
    else unlinked += 1;
  }

  return {
    total: reports.length,
    linked,
    unlinked,
    bySource,
    byStatus,
    bySeverity,
  };
}

function getConnectorConfigErrors(config: IntakeConfig | undefined, source: IntakeSource): string[] {
  const validation = validateConfig({ intake: config });
  const prefix = `intake.connectors.${source}.`;
  return validation.errors
    .filter((error) => error.path === 'intake.connectors' || error.path.startsWith(prefix))
    .map((error) => error.message);
}

export function buildConnectorHealth(db: Database.Database, config: IntakeConfig | undefined) {
  const reports = listIntakeReports(db);
  const intakeEnabled = config?.enabled === true;

  return INTAKE_SOURCES.map((source) => {
    const connectorConfig = config?.connectors?.[source];
    const enabled = intakeEnabled && connectorConfig?.enabled === true;
    const pollState = getIntakePollState(db, source);
    const configErrors = getConnectorConfigErrors(config, source);
    const sourceReports = reports.filter((report: StoredIntakeReport) => report.source === source);
    const lastErrorAtMs = pollState?.lastErrorAt ? Date.parse(pollState.lastErrorAt) : Number.NEGATIVE_INFINITY;
    const lastSuccessAtMs = pollState?.lastSuccessAt ? Date.parse(pollState.lastSuccessAt) : Number.NEGATIVE_INFINITY;

    let status: ConnectorHealthStatus = 'disabled';
    let reason = intakeEnabled ? 'Connector disabled in config' : 'Intake disabled in config';

    if (enabled && source === 'sentry') {
      status = 'unsupported';
      reason = "Connector is enabled but not implemented in this workspace";
    } else if (enabled && configErrors.length > 0) {
      status = 'error';
      reason = configErrors[0];
    } else if (enabled && pollState?.lastErrorAt && lastErrorAtMs >= lastSuccessAtMs) {
      status = 'error';
      reason = pollState.lastErrorMessage ?? 'Last poll failed';
    } else if (enabled && pollState?.lastSuccessAt) {
      status = 'healthy';
      reason = 'Connector has completed at least one successful poll';
    } else if (enabled) {
      status = 'idle';
      reason = 'Connector enabled but has not completed a successful poll yet';
    }

    return {
      source,
      enabled,
      implemented: source !== 'sentry',
      status,
      reason,
      configErrors,
      stats: {
        totalReports: sourceReports.length,
        openReports: sourceReports.filter(
          (report: StoredIntakeReport) => report.status !== 'resolved' && report.status !== 'ignored'
        ).length,
        linkedReports: sourceReports.filter((report: StoredIntakeReport) => report.linkedTaskId !== null).length,
      },
      pollState,
    };
  });
}
