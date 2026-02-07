/**
 * Disputes module
 *
 * Handles coder/reviewer disagreements gracefully.
 * Disputes treat tasks as effectively complete and record
 * both positions for optional human review.
 */

// Types
export type {
  DisputeType,
  DisputeReason,
  DisputeStatus,
  ResolutionDecision,
  Dispute,
  CreateDisputeInput,
  ResolveDisputeInput,
} from './types.js';

export {
  DISPUTE_TYPES,
  DISPUTE_REASONS,
  DISPUTE_REASON_DESCRIPTIONS,
  isDisputeType,
  isDisputeReason,
  isResolutionDecision,
  getDisputeTypeMarker,
  getDisputeTypeDescription,
} from './types.js';

// Queries
export type { DisputeWithTask } from './queries.js';

export {
  getDispute,
  getDisputesForTask,
  getOpenDisputeForTask,
  listDisputes,
  getStaleDisputes,
  countDisputesByStatus,
  insertDispute,
  updateCoderPosition,
  updateReviewerPosition,
  resolveDispute,
  listDisputesWithTasks,
  calculateDaysOpen,
} from './queries.js';

// Create operations
export type {
  CreateDisputeResult,
  CreateDisputeError,
  CreateDisputeOutcome,
} from './create.js';

export {
  createDispute,
  createCoderDispute,
  createReviewerDispute,
  createMajorDispute,
  createMinorDispute,
  createSystemDispute,
  logMinorDisagreement,
} from './create.js';
