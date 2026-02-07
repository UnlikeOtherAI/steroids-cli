/**
 * Database queries for disputes
 *
 * Provides CRUD operations for the disputes table and
 * integration with the task system.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  Dispute,
  DisputeType,
  DisputeStatus,
  ResolutionDecision,
} from './types.js';

// ============ Read Operations ============

/**
 * Get a dispute by ID (supports short ID prefix match)
 */
export function getDispute(
  db: Database.Database,
  id: string
): Dispute | null {
  // Try exact match first
  let dispute = db
    .prepare('SELECT * FROM disputes WHERE id = ?')
    .get(id) as Dispute | null;

  // If not found, try prefix match (for short IDs)
  if (!dispute && id.length >= 6) {
    dispute = db
      .prepare('SELECT * FROM disputes WHERE id LIKE ?')
      .get(`${id}%`) as Dispute | null;
  }

  return dispute;
}

/**
 * Get all disputes for a specific task
 */
export function getDisputesForTask(
  db: Database.Database,
  taskId: string
): Dispute[] {
  return db
    .prepare(
      `SELECT * FROM disputes
       WHERE task_id = ?
       ORDER BY created_at DESC`
    )
    .all(taskId) as Dispute[];
}

/**
 * Get the most recent open dispute for a task (if any)
 */
export function getOpenDisputeForTask(
  db: Database.Database,
  taskId: string
): Dispute | null {
  return db
    .prepare(
      `SELECT * FROM disputes
       WHERE task_id = ? AND status = 'open'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(taskId) as Dispute | null;
}

/**
 * List disputes with optional filtering
 */
export function listDisputes(
  db: Database.Database,
  options: {
    status?: DisputeStatus | 'all';
    type?: DisputeType;
    taskId?: string;
  } = {}
): Dispute[] {
  let sql = `
    SELECT d.* FROM disputes d
    WHERE 1=1
  `;
  const params: string[] = [];

  if (options.status && options.status !== 'all') {
    sql += ' AND d.status = ?';
    params.push(options.status);
  }

  if (options.type) {
    sql += ' AND d.type = ?';
    params.push(options.type);
  }

  if (options.taskId) {
    sql += ' AND d.task_id = ?';
    params.push(options.taskId);
  }

  sql += ' ORDER BY d.created_at DESC';

  return db.prepare(sql).all(...params) as Dispute[];
}

/**
 * Get stale disputes (open longer than specified days)
 */
export function getStaleDisputes(
  db: Database.Database,
  timeoutDays: number
): Dispute[] {
  return db
    .prepare(
      `SELECT * FROM disputes
       WHERE status = 'open'
         AND datetime(created_at, '+' || ? || ' days') < datetime('now')
       ORDER BY created_at ASC`
    )
    .all(timeoutDays) as Dispute[];
}

/**
 * Count disputes by status
 */
export function countDisputesByStatus(
  db: Database.Database
): { open: number; resolved: number; total: number } {
  const result = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
         SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
         COUNT(*) as total
       FROM disputes`
    )
    .get() as { open: number; resolved: number; total: number };

  return {
    open: result.open ?? 0,
    resolved: result.resolved ?? 0,
    total: result.total ?? 0,
  };
}

// ============ Write Operations ============

/**
 * Insert a new dispute into the database
 */
export function insertDispute(
  db: Database.Database,
  params: {
    taskId: string;
    type: DisputeType;
    reason: string;
    createdBy: string;
    coderPosition?: string;
    reviewerPosition?: string;
  }
): string {
  const id = uuidv4();

  db.prepare(
    `INSERT INTO disputes (
       id, task_id, type, reason, created_by,
       coder_position, reviewer_position
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.taskId,
    params.type,
    params.reason,
    params.createdBy,
    params.coderPosition ?? null,
    params.reviewerPosition ?? null
  );

  return id;
}

/**
 * Update coder position on a dispute
 */
export function updateCoderPosition(
  db: Database.Database,
  disputeId: string,
  position: string
): void {
  db.prepare(
    `UPDATE disputes SET coder_position = ? WHERE id = ?`
  ).run(position, disputeId);
}

/**
 * Update reviewer position on a dispute
 */
export function updateReviewerPosition(
  db: Database.Database,
  disputeId: string,
  position: string
): void {
  db.prepare(
    `UPDATE disputes SET reviewer_position = ? WHERE id = ?`
  ).run(position, disputeId);
}

/**
 * Resolve a dispute
 */
export function resolveDispute(
  db: Database.Database,
  disputeId: string,
  decision: ResolutionDecision,
  resolvedBy: string,
  notes?: string
): void {
  db.prepare(
    `UPDATE disputes
     SET status = 'resolved',
         resolution = ?,
         resolution_notes = ?,
         resolved_by = ?,
         resolved_at = datetime('now')
     WHERE id = ?`
  ).run(decision, notes ?? null, resolvedBy, disputeId);
}

// ============ Dispute with Task Info ============

/**
 * Dispute record with associated task title
 */
export interface DisputeWithTask extends Dispute {
  task_title: string;
  task_status: string;
}

/**
 * List disputes with associated task information
 */
export function listDisputesWithTasks(
  db: Database.Database,
  options: {
    status?: DisputeStatus | 'all';
    stale?: boolean;
    timeoutDays?: number;
  } = {}
): DisputeWithTask[] {
  let sql = `
    SELECT d.*, t.title as task_title, t.status as task_status
    FROM disputes d
    JOIN tasks t ON d.task_id = t.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (options.status && options.status !== 'all') {
    sql += ' AND d.status = ?';
    params.push(options.status);
  }

  if (options.stale && options.timeoutDays) {
    sql += ` AND d.status = 'open'
             AND datetime(d.created_at, '+' || ? || ' days') < datetime('now')`;
    params.push(options.timeoutDays);
  }

  sql += ' ORDER BY d.created_at DESC';

  return db.prepare(sql).all(...params) as DisputeWithTask[];
}

/**
 * Calculate days open for a dispute
 */
export function calculateDaysOpen(createdAt: string): number {
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}
