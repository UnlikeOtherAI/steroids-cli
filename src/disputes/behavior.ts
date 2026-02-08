/**
 * Major/minor dispute behavior
 *
 * Defines how different dispute types affect the loop:
 * - Major disputes can block the loop if configured
 * - Minor disputes are logged but work continues
 */

import type Database from 'better-sqlite3';
import {
  listDisputes,
  countDisputesByStatus,
} from './queries.js';
import type { DisputeType, Dispute } from './types.js';

// ============ Configuration ============

/**
 * Dispute behavior configuration
 */
export interface DisputeBehaviorConfig {
  /** If true, major disputes block the automation loop */
  majorBlocksLoop: boolean;
  /** Auto-create system dispute after 15 rejections */
  autoCreateOnMaxRejections: boolean;
  /** Days before dispute is considered stale */
  timeoutDays: number;
}

/**
 * Default dispute behavior configuration
 */
export const DEFAULT_DISPUTE_BEHAVIOR: DisputeBehaviorConfig = {
  majorBlocksLoop: false,
  autoCreateOnMaxRejections: true,
  timeoutDays: 7,
};

// ============ Dispute Behavior Logic ============

/**
 * Result of checking if loop should be blocked
 */
export interface LoopBlockResult {
  /** Whether the loop should be blocked */
  blocked: boolean;
  /** Reason for blocking */
  reason?: string;
  /** Disputes causing the block */
  blockingDisputes?: Dispute[];
}

/**
 * Check if the loop should be blocked due to major disputes
 */
export function checkLoopBlocked(
  db: Database.Database,
  config: DisputeBehaviorConfig = DEFAULT_DISPUTE_BEHAVIOR
): LoopBlockResult {
  // If major disputes don't block the loop, return immediately
  if (!config.majorBlocksLoop) {
    return { blocked: false };
  }

  // Find open major disputes
  const majorDisputes = listDisputes(db, { type: 'major', status: 'open' });

  if (majorDisputes.length === 0) {
    return { blocked: false };
  }

  return {
    blocked: true,
    reason: `${majorDisputes.length} major dispute(s) require human resolution`,
    blockingDisputes: majorDisputes,
  };
}

/**
 * Determine the behavior for a dispute type
 */
export interface DisputeBehavior {
  /** Whether this type blocks the task */
  blocksTask: boolean;
  /** Whether task status changes to 'disputed' */
  changesTaskStatus: boolean;
  /** Whether this type can block the loop */
  canBlockLoop: boolean;
  /** Human-readable description */
  description: string;
}

/**
 * Get the behavior for a dispute type
 */
export function getDisputeBehavior(
  type: DisputeType,
  config: DisputeBehaviorConfig = DEFAULT_DISPUTE_BEHAVIOR
): DisputeBehavior {
  switch (type) {
    case 'major':
      return {
        blocksTask: true,
        changesTaskStatus: true,
        canBlockLoop: config.majorBlocksLoop,
        description: config.majorBlocksLoop
          ? 'Blocks task and loop until resolved by human'
          : 'Blocks task, loop continues to next task',
      };

    case 'minor':
      return {
        blocksTask: false,
        changesTaskStatus: false,
        canBlockLoop: false,
        description: 'Logged disagreement, coder implementation continues',
      };

    case 'coder':
      return {
        blocksTask: true,
        changesTaskStatus: true,
        canBlockLoop: false,
        description: 'Coder disputes rejection, task marked disputed, loop continues',
      };

    case 'reviewer':
      return {
        blocksTask: true,
        changesTaskStatus: true,
        canBlockLoop: false,
        description: 'Reviewer raises concern, task marked disputed, loop continues',
      };

    case 'system':
      return {
        blocksTask: true,
        changesTaskStatus: true,
        canBlockLoop: false,
        description: 'Auto-created after max rejections, requires human intervention',
      };
  }
}

// ============ Loop Integration ============

/**
 * Actions to take when a dispute is created
 */
export interface DisputeCreatedActions {
  /** Push work to git */
  pushToGit: boolean;
  /** Move to next task */
  moveToNextTask: boolean;
  /** Block the loop */
  blockLoop: boolean;
  /** Update dispute.md */
  updateDisputeLog: boolean;
}

/**
 * Get actions to take when a dispute is created
 */
export function getActionsOnDisputeCreated(
  type: DisputeType,
  config: DisputeBehaviorConfig = DEFAULT_DISPUTE_BEHAVIOR
): DisputeCreatedActions {
  const behavior = getDisputeBehavior(type, config);

  return {
    pushToGit: type !== 'minor', // Always push for non-minor disputes
    moveToNextTask: !behavior.canBlockLoop, // Move on unless loop is blocked
    blockLoop: behavior.canBlockLoop,
    updateDisputeLog: true, // Always update dispute.md
  };
}

// ============ Summary Helpers ============

/**
 * Get a summary of current dispute status for loop
 */
export function getDisputeLoopSummary(
  db: Database.Database,
  config: DisputeBehaviorConfig = DEFAULT_DISPUTE_BEHAVIOR
): string {
  const counts = countDisputesByStatus(db);
  const blockResult = checkLoopBlocked(db, config);

  const lines: string[] = [];

  if (blockResult.blocked) {
    lines.push(`LOOP BLOCKED: ${blockResult.reason}`);
    lines.push('');
  }

  lines.push(`Disputes: ${counts.open} open, ${counts.resolved} resolved`);

  if (config.majorBlocksLoop) {
    lines.push('Config: Major disputes block loop');
  } else {
    lines.push('Config: Major disputes logged but loop continues');
  }

  return lines.join('\n');
}

/**
 * Check if loop can proceed (not blocked by disputes)
 */
export function canLoopProceed(
  db: Database.Database,
  config: DisputeBehaviorConfig = DEFAULT_DISPUTE_BEHAVIOR
): boolean {
  return !checkLoopBlocked(db, config).blocked;
}

// ============ Disputed Task Handling ============

/**
 * Options for handling a disputed task
 */
export interface DisputedTaskHandling {
  /** Should the task be skipped in task selection */
  skipInSelection: boolean;
  /** Is the task considered "done" for loop purposes */
  consideredDone: boolean;
  /** Should the task be included in progress reports */
  includeInProgress: boolean;
}

/**
 * Get handling options for disputed tasks
 */
export function getDisputedTaskHandling(): DisputedTaskHandling {
  return {
    skipInSelection: true, // Disputed tasks are skipped
    consideredDone: true, // Treated as done for loop progress
    includeInProgress: false, // Not counted as work in progress
  };
}

/**
 * Status markers for terminal states
 * Disputed [!] is considered terminal like completed [x]
 */
export const TERMINAL_STATUSES = ['completed', 'disputed', 'failed'] as const;

/**
 * Check if a task status is terminal (no more work needed)
 */
export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
