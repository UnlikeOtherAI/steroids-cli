/**
 * Dispute resolution logic
 *
 * Handles resolving disputes with decisions (coder/reviewer/custom)
 * and updates task status accordingly.
 */

import type Database from 'better-sqlite3';
import {
  getDispute,
  resolveDispute as resolveDisputeQuery,
} from './queries.js';
import {
  getTask,
  updateTaskStatus,
  addAuditEntry,
} from '../database/queries.js';
import type {
  Dispute,
  ResolutionDecision,
  ResolveDisputeInput,
} from './types.js';
import { isResolutionDecision } from './types.js';

// ============ Result Types ============

export interface ResolveDisputeResult {
  success: true;
  disputeId: string;
  taskId: string;
  decision: ResolutionDecision;
  taskNewStatus: string;
}

export interface ResolveDisputeError {
  success: false;
  error: string;
  code:
    | 'DISPUTE_NOT_FOUND'
    | 'ALREADY_RESOLVED'
    | 'TASK_NOT_FOUND'
    | 'INVALID_DECISION';
}

export type ResolveDisputeOutcome = ResolveDisputeResult | ResolveDisputeError;

// ============ Validation ============

/**
 * Validate resolution input
 */
function validateInput(
  db: Database.Database,
  input: ResolveDisputeInput
): ResolveDisputeError | null {
  // Check dispute exists
  const dispute = getDispute(db, input.disputeId);
  if (!dispute) {
    return {
      success: false,
      error: `Dispute not found: ${input.disputeId}`,
      code: 'DISPUTE_NOT_FOUND',
    };
  }

  // Check dispute is not already resolved
  if (dispute.status === 'resolved') {
    return {
      success: false,
      error: `Dispute already resolved: ${input.disputeId}`,
      code: 'ALREADY_RESOLVED',
    };
  }

  // Check decision is valid
  if (!isResolutionDecision(input.decision)) {
    return {
      success: false,
      error: `Invalid decision: ${input.decision}. Must be coder, reviewer, or custom`,
      code: 'INVALID_DECISION',
    };
  }

  // Check task exists
  const task = getTask(db, dispute.task_id);
  if (!task) {
    return {
      success: false,
      error: `Task not found for dispute: ${dispute.task_id}`,
      code: 'TASK_NOT_FOUND',
    };
  }

  return null;
}

// ============ Main Resolve Function ============

/**
 * Resolve a dispute with a decision
 *
 * Effects based on decision:
 * - coder: Task stays completed/disputed (dispute resolved, coder's implementation accepted)
 * - reviewer: Task goes back to in_progress (coder must fix per reviewer feedback)
 * - custom: Task goes back to in_progress (coder implements custom solution)
 */
export function resolve(
  db: Database.Database,
  input: ResolveDisputeInput
): ResolveDisputeOutcome {
  // Validate input
  const validationError = validateInput(db, input);
  if (validationError) {
    return validationError;
  }

  // Get dispute and task (we know they exist from validation)
  const dispute = getDispute(db, input.disputeId)!;
  const task = getTask(db, dispute.task_id)!;

  // Update dispute to resolved
  resolveDisputeQuery(
    db,
    dispute.id,
    input.decision,
    input.resolvedBy,
    input.notes
  );

  // Update task status based on decision
  let taskNewStatus: string;

  if (input.decision === 'coder') {
    // Accept coder's implementation - mark as completed
    taskNewStatus = 'completed';
    updateTaskStatus(
      db,
      task.id,
      'completed',
      input.resolvedBy,
      `Dispute resolved in favor of coder. ${input.notes ?? ''}`
    );
  } else {
    // Reviewer or custom - task goes back to in_progress
    taskNewStatus = 'in_progress';
    updateTaskStatus(
      db,
      task.id,
      'in_progress',
      input.resolvedBy,
      `Dispute resolved in favor of ${input.decision}. Coder must implement changes. ${input.notes ?? ''}`
    );
  }

  return {
    success: true,
    disputeId: dispute.id,
    taskId: task.id,
    decision: input.decision,
    taskNewStatus,
  };
}

// ============ Specialized Resolution Functions ============

/**
 * Resolve dispute in favor of coder
 * Task is marked as completed.
 */
export function resolveInFavorOfCoder(
  db: Database.Database,
  disputeId: string,
  resolvedBy: string,
  notes?: string
): ResolveDisputeOutcome {
  return resolve(db, {
    disputeId,
    decision: 'coder',
    resolvedBy,
    notes,
  });
}

/**
 * Resolve dispute in favor of reviewer
 * Task goes back to in_progress for coder to fix.
 */
export function resolveInFavorOfReviewer(
  db: Database.Database,
  disputeId: string,
  resolvedBy: string,
  notes?: string
): ResolveDisputeOutcome {
  return resolve(db, {
    disputeId,
    decision: 'reviewer',
    resolvedBy,
    notes,
  });
}

/**
 * Resolve dispute with custom solution
 * Task goes back to in_progress for coder to implement custom solution.
 */
export function resolveWithCustomSolution(
  db: Database.Database,
  disputeId: string,
  resolvedBy: string,
  notes: string
): ResolveDisputeOutcome {
  return resolve(db, {
    disputeId,
    decision: 'custom',
    resolvedBy,
    notes,
  });
}

// ============ Dispute State Helpers ============

/**
 * Check if a dispute can be resolved
 */
export function canResolve(
  db: Database.Database,
  disputeId: string
): { canResolve: boolean; reason?: string } {
  const dispute = getDispute(db, disputeId);

  if (!dispute) {
    return { canResolve: false, reason: 'Dispute not found' };
  }

  if (dispute.status === 'resolved') {
    return { canResolve: false, reason: 'Dispute already resolved' };
  }

  const task = getTask(db, dispute.task_id);
  if (!task) {
    return { canResolve: false, reason: 'Associated task not found' };
  }

  return { canResolve: true };
}

/**
 * Get resolution summary for a resolved dispute
 */
export function getResolutionSummary(dispute: Dispute): string | null {
  if (dispute.status !== 'resolved' || !dispute.resolution) {
    return null;
  }

  const decisionText =
    dispute.resolution === 'coder'
      ? "Coder's implementation accepted"
      : dispute.resolution === 'reviewer'
        ? 'Reviewer position accepted, coder must fix'
        : 'Custom solution required';

  const resolvedDate = dispute.resolved_at
    ? new Date(dispute.resolved_at).toLocaleDateString()
    : 'unknown date';

  return `Resolved: ${decisionText} on ${resolvedDate}. ${dispute.resolution_notes ?? ''}`;
}
