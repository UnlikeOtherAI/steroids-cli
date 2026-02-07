/**
 * Dispute creation logic
 *
 * Creates disputes linked to tasks, sets appropriate positions
 * based on the actor (coder or reviewer), and updates task status.
 */

import type Database from 'better-sqlite3';
import { insertDispute, getOpenDisputeForTask } from './queries.js';
import { getTask, updateTaskStatus, addAuditEntry } from '../database/queries.js';
import type {
  Dispute,
  DisputeType,
  CreateDisputeInput,
} from './types.js';
import { isDisputeReason } from './types.js';

// ============ Result Types ============

export interface CreateDisputeResult {
  success: true;
  disputeId: string;
  taskId: string;
  type: DisputeType;
  taskStatusUpdated: boolean;
}

export interface CreateDisputeError {
  success: false;
  error: string;
  code: 'TASK_NOT_FOUND' | 'DISPUTE_EXISTS' | 'INVALID_TYPE' | 'INVALID_REASON';
}

export type CreateDisputeOutcome = CreateDisputeResult | CreateDisputeError;

// ============ Validation ============

/**
 * Validate dispute creation input
 */
function validateInput(
  db: Database.Database,
  input: CreateDisputeInput
): CreateDisputeError | null {
  // Check task exists
  const task = getTask(db, input.taskId);
  if (!task) {
    return {
      success: false,
      error: `Task not found: ${input.taskId}`,
      code: 'TASK_NOT_FOUND',
    };
  }

  // Check for existing open dispute (only for non-minor disputes)
  if (input.type !== 'minor') {
    const existingDispute = getOpenDisputeForTask(db, task.id);
    if (existingDispute) {
      return {
        success: false,
        error: `Task already has an open dispute: ${existingDispute.id}`,
        code: 'DISPUTE_EXISTS',
      };
    }
  }

  return null;
}

// ============ Actor Detection ============

/**
 * Determine if actor is coder or reviewer based on actor string
 */
function detectActorRole(actor: string): 'coder' | 'reviewer' | 'unknown' {
  const lowerActor = actor.toLowerCase();

  // Explicit role markers
  if (lowerActor.includes('coder') || lowerActor.includes('sonnet')) {
    return 'coder';
  }
  if (lowerActor.includes('reviewer') || lowerActor.includes('opus')) {
    return 'reviewer';
  }

  // Model-based inference (Sonnet is typically coder, Opus is typically reviewer)
  if (lowerActor.includes('claude-sonnet')) {
    return 'coder';
  }
  if (lowerActor.includes('claude-opus')) {
    return 'reviewer';
  }

  return 'unknown';
}

// ============ Main Create Function ============

/**
 * Create a new dispute for a task
 *
 * This function:
 * 1. Validates the input
 * 2. Creates the dispute record
 * 3. Sets the position based on actor role (coder or reviewer)
 * 4. Updates task status to 'disputed' (except for minor disputes)
 * 5. Adds an audit entry
 */
export function createDispute(
  db: Database.Database,
  input: CreateDisputeInput
): CreateDisputeOutcome {
  // Validate input
  const validationError = validateInput(db, input);
  if (validationError) {
    return validationError;
  }

  // Get the task (we know it exists from validation)
  const task = getTask(db, input.taskId)!;

  // Determine actor role and set appropriate position
  const role = detectActorRole(input.createdBy);
  let coderPosition: string | undefined;
  let reviewerPosition: string | undefined;

  if (role === 'coder') {
    coderPosition = input.position;
  } else if (role === 'reviewer') {
    reviewerPosition = input.position;
  } else {
    // Unknown role - set as coder position by default for 'coder' type disputes
    // and reviewer position for 'reviewer' type disputes
    if (input.type === 'reviewer') {
      reviewerPosition = input.position;
    } else {
      coderPosition = input.position;
    }
  }

  // Create the dispute record
  const disputeId = insertDispute(db, {
    taskId: task.id,
    type: input.type,
    reason: input.reason,
    createdBy: input.createdBy,
    coderPosition,
    reviewerPosition,
  });

  // Update task status to 'disputed' (except for minor disputes)
  let taskStatusUpdated = false;
  if (input.type !== 'minor' && task.status !== 'disputed') {
    updateTaskStatus(
      db,
      task.id,
      'disputed',
      input.createdBy,
      `Dispute created: ${input.reason}`
    );
    taskStatusUpdated = true;
  }

  return {
    success: true,
    disputeId,
    taskId: task.id,
    type: input.type,
    taskStatusUpdated,
  };
}

// ============ Specialized Create Functions ============

/**
 * Create a coder dispute (coder disagrees with reviewer rejection)
 */
export function createCoderDispute(
  db: Database.Database,
  taskId: string,
  reason: string,
  position: string,
  model: string
): CreateDisputeOutcome {
  return createDispute(db, {
    taskId,
    type: 'coder',
    reason,
    position,
    createdBy: `model:${model}`,
  });
}

/**
 * Create a reviewer dispute (reviewer raises concern)
 */
export function createReviewerDispute(
  db: Database.Database,
  taskId: string,
  reason: string,
  position: string,
  model: string
): CreateDisputeOutcome {
  return createDispute(db, {
    taskId,
    type: 'reviewer',
    reason,
    position,
    createdBy: `model:${model}`,
  });
}

/**
 * Create a major dispute (blocks task, requires human resolution)
 */
export function createMajorDispute(
  db: Database.Database,
  taskId: string,
  reason: string,
  position: string,
  createdBy: string
): CreateDisputeOutcome {
  return createDispute(db, {
    taskId,
    type: 'major',
    reason,
    position,
    createdBy,
  });
}

/**
 * Create a minor dispute (logged only, doesn't block)
 */
export function createMinorDispute(
  db: Database.Database,
  taskId: string,
  reason: string,
  position: string,
  createdBy: string
): CreateDisputeOutcome {
  return createDispute(db, {
    taskId,
    type: 'minor',
    reason,
    position,
    createdBy,
  });
}

/**
 * Create a system dispute (auto-created after 15 rejections)
 * Called from the task rejection logic
 */
export function createSystemDispute(
  db: Database.Database,
  taskId: string,
  reason: string = 'Exceeded 15 rejections'
): CreateDisputeOutcome {
  return createDispute(db, {
    taskId,
    type: 'system',
    reason,
    position: 'Task exceeded maximum rejection count and requires human intervention.',
    createdBy: 'system',
  });
}

// ============ Log Minor Disagreement ============

/**
 * Log a minor disagreement without changing task status
 * Used for non-blocking style/preference disagreements
 */
export function logMinorDisagreement(
  db: Database.Database,
  taskId: string,
  notes: string,
  createdBy: string
): CreateDisputeOutcome {
  const task = getTask(db, taskId);
  if (!task) {
    return {
      success: false,
      error: `Task not found: ${taskId}`,
      code: 'TASK_NOT_FOUND',
    };
  }

  const disputeId = insertDispute(db, {
    taskId: task.id,
    type: 'minor',
    reason: 'style',
    createdBy,
    coderPosition: notes,
  });

  // Add audit entry for the minor disagreement
  addAuditEntry(
    db,
    task.id,
    task.status,
    task.status,
    createdBy,
    `Minor disagreement logged: ${notes}`
  );

  return {
    success: true,
    disputeId,
    taskId: task.id,
    type: 'minor',
    taskStatusUpdated: false,
  };
}
