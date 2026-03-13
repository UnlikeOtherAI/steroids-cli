import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  IntakeReport,
  IntakeReportStatus,
  IntakeSeverity,
  IntakeSource,
} from '../intake/types.js';

export interface StoredIntakeReport extends IntakeReport {
  id: string;
  firstSeenAt: string;
  lastSeenAt: string;
  linkedTaskId: string | null;
  recordCreatedAt: string;
  recordUpdatedAt: string;
}

export interface UpsertIntakeReportOptions {
  linkedTaskId?: string | null;
}

export interface ListIntakeReportsFilters {
  source?: IntakeSource;
  status?: IntakeReportStatus;
  severity?: IntakeSeverity;
  linkedTaskId?: string;
  hasLinkedTask?: boolean;
  limit?: number;
}

export interface IntakePollState {
  source: IntakeSource;
  cursor: string | null;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
}

export interface UpsertIntakePollStateInput {
  source: IntakeSource;
  cursor?: string | null;
  lastPolledAt?: string | null;
  lastSuccessAt?: string | null;
  lastErrorAt?: string | null;
  lastErrorMessage?: string | null;
}

interface IntakeReportRow {
  id: string;
  source: IntakeSource;
  external_id: string;
  fingerprint: string;
  title: string;
  summary: string | null;
  severity: IntakeSeverity;
  status: IntakeReportStatus;
  report_url: string;
  created_at_remote: string;
  updated_at_remote: string;
  resolved_at_remote: string | null;
  tags_json: string;
  payload_json: string;
  first_seen_at: string;
  last_seen_at: string;
  linked_task_id: string | null;
  created_at: string;
  updated_at: string;
}

interface IntakePollStateRow {
  source: IntakeSource;
  cursor: string | null;
  last_polled_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
  updated_at: string;
}

function parseJson<T>(raw: string, fieldName: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid JSON stored in ${fieldName}`);
  }
}

function mapRowToStoredReport(row: IntakeReportRow): StoredIntakeReport {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    fingerprint: row.fingerprint,
    title: row.title,
    summary: row.summary ?? undefined,
    severity: row.severity,
    status: row.status,
    url: row.report_url,
    createdAt: row.created_at_remote,
    updatedAt: row.updated_at_remote,
    resolvedAt: row.resolved_at_remote ?? undefined,
    tags: parseJson<string[]>(row.tags_json, 'intake_reports.tags_json'),
    payload: parseJson<Record<string, unknown>>(row.payload_json, 'intake_reports.payload_json'),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    linkedTaskId: row.linked_task_id,
    recordCreatedAt: row.created_at,
    recordUpdatedAt: row.updated_at,
  };
}

function mapRowToPollState(row: IntakePollStateRow): IntakePollState {
  return {
    source: row.source,
    cursor: row.cursor,
    lastPolledAt: row.last_polled_at,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
    updatedAt: row.updated_at,
  };
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Intake report limit must be a positive integer, got: ${limit}`);
  }

  return limit;
}

export function getIntakeReport(
  db: Database.Database,
  source: IntakeSource,
  externalId: string
): StoredIntakeReport | null {
  const row = db
    .prepare(
      `SELECT *
       FROM intake_reports
       WHERE source = ? AND external_id = ?`
    )
    .get(source, externalId) as IntakeReportRow | undefined;

  return row ? mapRowToStoredReport(row) : null;
}

export function upsertIntakeReport(
  db: Database.Database,
  report: IntakeReport,
  options: UpsertIntakeReportOptions = {}
): StoredIntakeReport {
  const existing = db
    .prepare(
      `SELECT *
       FROM intake_reports
       WHERE source = ? AND external_id = ?`
    )
    .get(report.source, report.externalId) as IntakeReportRow | undefined;

  const tagsJson = JSON.stringify(report.tags);
  const payloadJson = JSON.stringify(report.payload);
  const now = new Date().toISOString();
  const hasExplicitLinkedTask = Object.prototype.hasOwnProperty.call(options, 'linkedTaskId');
  const linkedTaskId = hasExplicitLinkedTask ? options.linkedTaskId ?? null : existing?.linked_task_id ?? null;

  if (existing) {
    db.prepare(
      `UPDATE intake_reports
       SET fingerprint = ?,
           title = ?,
           summary = ?,
           severity = ?,
           status = ?,
           report_url = ?,
           created_at_remote = ?,
           updated_at_remote = ?,
           resolved_at_remote = ?,
           tags_json = ?,
           payload_json = ?,
           last_seen_at = ?,
           linked_task_id = ?,
           updated_at = ?
       WHERE source = ? AND external_id = ?`
    ).run(
      report.fingerprint,
      report.title,
      report.summary ?? null,
      report.severity,
      report.status,
      report.url,
      report.createdAt,
      report.updatedAt,
      report.resolvedAt ?? null,
      tagsJson,
      payloadJson,
      now,
      linkedTaskId,
      now,
      report.source,
      report.externalId
    );
  } else {
    db.prepare(
      `INSERT INTO intake_reports (
         id,
         source,
         external_id,
         fingerprint,
         title,
         summary,
         severity,
         status,
         report_url,
         created_at_remote,
         updated_at_remote,
         resolved_at_remote,
         tags_json,
         payload_json,
         first_seen_at,
         last_seen_at,
         linked_task_id,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(),
      report.source,
      report.externalId,
      report.fingerprint,
      report.title,
      report.summary ?? null,
      report.severity,
      report.status,
      report.url,
      report.createdAt,
      report.updatedAt,
      report.resolvedAt ?? null,
      tagsJson,
      payloadJson,
      now,
      now,
      linkedTaskId,
      now,
      now
    );
  }

  const stored = getIntakeReport(db, report.source, report.externalId);
  if (!stored) {
    throw new Error(`Failed to persist intake report ${report.source}:${report.externalId}`);
  }

  return stored;
}

export function listIntakeReports(
  db: Database.Database,
  filters: ListIntakeReportsFilters = {}
): StoredIntakeReport[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filters.source) {
    clauses.push('source = ?');
    params.push(filters.source);
  }

  if (filters.status) {
    clauses.push('status = ?');
    params.push(filters.status);
  }

  if (filters.severity) {
    clauses.push('severity = ?');
    params.push(filters.severity);
  }

  if (filters.linkedTaskId) {
    clauses.push('linked_task_id = ?');
    params.push(filters.linkedTaskId);
  }

  if (filters.hasLinkedTask === true) {
    clauses.push('linked_task_id IS NOT NULL');
  } else if (filters.hasLinkedTask === false) {
    clauses.push('linked_task_id IS NULL');
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = normalizeLimit(filters.limit);
  const limitClause = limit ? 'LIMIT ?' : '';

  const rows = db
    .prepare(
      `SELECT *
       FROM intake_reports
       ${whereClause}
       ORDER BY updated_at_remote DESC, source ASC, external_id ASC
       ${limitClause}`
    )
    .all(...params, ...(limit ? [limit] : [])) as IntakeReportRow[];

  return rows.map(mapRowToStoredReport);
}

export function linkIntakeReportToTask(
  db: Database.Database,
  source: IntakeSource,
  externalId: string,
  taskId: string | null
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE intake_reports
       SET linked_task_id = ?,
           updated_at = ?
       WHERE source = ? AND external_id = ?`
    )
    .run(taskId, now, source, externalId);

  return result.changes > 0;
}

export interface UpdateIntakeReportStateInput {
  status?: IntakeReportStatus;
  resolvedAt?: string | null;
  linkedTaskId?: string | null;
}

export function updateIntakeReportState(
  db: Database.Database,
  source: IntakeSource,
  externalId: string,
  updates: UpdateIntakeReportStateInput
): StoredIntakeReport {
  const existing = getIntakeReport(db, source, externalId);
  if (!existing) {
    throw new Error(`Intake report not found: ${source}:${externalId}`);
  }

  const nextReport: IntakeReport = {
    source: existing.source,
    externalId: existing.externalId,
    url: existing.url,
    fingerprint: existing.fingerprint,
    title: existing.title,
    summary: existing.summary,
    severity: existing.severity,
    status: updates.status ?? existing.status,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
    resolvedAt: Object.prototype.hasOwnProperty.call(updates, 'resolvedAt')
      ? updates.resolvedAt ?? undefined
      : existing.resolvedAt,
    tags: existing.tags,
    payload: existing.payload,
  };

  const options: UpsertIntakeReportOptions = Object.prototype.hasOwnProperty.call(updates, 'linkedTaskId')
    ? { linkedTaskId: updates.linkedTaskId ?? null }
    : { linkedTaskId: existing.linkedTaskId };

  return upsertIntakeReport(db, nextReport, options);
}

export function getIntakePollState(
  db: Database.Database,
  source: IntakeSource
): IntakePollState | null {
  const row = db
    .prepare(
      `SELECT *
       FROM intake_poll_state
       WHERE source = ?`
    )
    .get(source) as IntakePollStateRow | undefined;

  return row ? mapRowToPollState(row) : null;
}

export function upsertIntakePollState(
  db: Database.Database,
  state: UpsertIntakePollStateInput
): IntakePollState {
  const existing = getIntakePollState(db, state.source);
  const now = new Date().toISOString();

  const nextState = {
    cursor: Object.prototype.hasOwnProperty.call(state, 'cursor') ? state.cursor ?? null : existing?.cursor ?? null,
    lastPolledAt: Object.prototype.hasOwnProperty.call(state, 'lastPolledAt')
      ? state.lastPolledAt ?? null
      : existing?.lastPolledAt ?? null,
    lastSuccessAt: Object.prototype.hasOwnProperty.call(state, 'lastSuccessAt')
      ? state.lastSuccessAt ?? null
      : existing?.lastSuccessAt ?? null,
    lastErrorAt: Object.prototype.hasOwnProperty.call(state, 'lastErrorAt')
      ? state.lastErrorAt ?? null
      : existing?.lastErrorAt ?? null,
    lastErrorMessage: Object.prototype.hasOwnProperty.call(state, 'lastErrorMessage')
      ? state.lastErrorMessage ?? null
      : existing?.lastErrorMessage ?? null,
  };

  db.prepare(
    `INSERT INTO intake_poll_state (
       source,
       cursor,
       last_polled_at,
       last_success_at,
       last_error_at,
       last_error_message,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       cursor = excluded.cursor,
       last_polled_at = excluded.last_polled_at,
       last_success_at = excluded.last_success_at,
       last_error_at = excluded.last_error_at,
       last_error_message = excluded.last_error_message,
       updated_at = excluded.updated_at`
  ).run(
    state.source,
    nextState.cursor,
    nextState.lastPolledAt,
    nextState.lastSuccessAt,
    nextState.lastErrorAt,
    nextState.lastErrorMessage,
    now
  );

  const stored = getIntakePollState(db, state.source);
  if (!stored) {
    throw new Error(`Failed to persist intake poll state for ${state.source}`);
  }

  return stored;
}
