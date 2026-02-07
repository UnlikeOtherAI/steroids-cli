/**
 * Dispute types and interfaces
 *
 * Disputes occur when coder and reviewer fundamentally disagree about
 * implementation. The dispute system treats tasks as effectively complete
 * and records both positions for optional human review.
 */

// ============ Dispute Type Enum ============

/**
 * Type of dispute
 * - major: Blocks task, requires human resolution
 * - minor: Logged only, continues with coder's implementation
 * - coder: Coder disputes reviewer's rejection
 * - reviewer: Reviewer raises concern
 * - system: Auto-created after 15 rejections
 */
export type DisputeType = 'major' | 'minor' | 'coder' | 'reviewer' | 'system';

export const DISPUTE_TYPES: readonly DisputeType[] = [
  'major',
  'minor',
  'coder',
  'reviewer',
  'system',
] as const;

// ============ Dispute Reason Enum ============

/**
 * Standard reasons for disputes
 */
export type DisputeReason =
  | 'architecture'
  | 'specification'
  | 'approach'
  | 'requirements'
  | 'style'
  | 'security'
  | 'scope'
  | 'other';

export const DISPUTE_REASONS: readonly DisputeReason[] = [
  'architecture',
  'specification',
  'approach',
  'requirements',
  'style',
  'security',
  'scope',
  'other',
] as const;

/**
 * Human-readable descriptions for dispute reasons
 */
export const DISPUTE_REASON_DESCRIPTIONS: Record<DisputeReason, string> = {
  architecture: 'Architectural disagreement - different technical approaches',
  specification: 'Specification ambiguity - unclear requirements',
  approach: 'Different valid approaches to implementation',
  requirements: 'Unclear or conflicting requirements',
  style: 'Style/convention disagreement',
  security: 'Security concern or vulnerability',
  scope: 'Scope disagreement - what is in/out of scope',
  other: 'Other reason (custom explanation)',
};

// ============ Dispute Status Enum ============

/**
 * Status of a dispute
 */
export type DisputeStatus = 'open' | 'resolved';

// ============ Resolution Decision Enum ============

/**
 * Resolution decision for a dispute
 */
export type ResolutionDecision = 'coder' | 'reviewer' | 'custom';

// ============ Dispute Entity ============

/**
 * Full dispute record from database
 */
export interface Dispute {
  id: string;
  task_id: string;
  type: DisputeType;
  status: DisputeStatus;
  reason: DisputeReason | string;
  coder_position: string | null;
  reviewer_position: string | null;
  resolution: ResolutionDecision | null;
  resolution_notes: string | null;
  created_by: string;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ============ Create Dispute Input ============

/**
 * Input for creating a new dispute
 */
export interface CreateDisputeInput {
  taskId: string;
  type: DisputeType;
  reason: DisputeReason | string;
  position: string;
  createdBy: string;
}

// ============ Resolve Dispute Input ============

/**
 * Input for resolving a dispute
 */
export interface ResolveDisputeInput {
  disputeId: string;
  decision: ResolutionDecision;
  notes?: string;
  resolvedBy: string;
}

// ============ Type Guards ============

/**
 * Check if a string is a valid dispute type
 */
export function isDisputeType(value: string): value is DisputeType {
  return (DISPUTE_TYPES as readonly string[]).includes(value);
}

/**
 * Check if a string is a valid dispute reason
 */
export function isDisputeReason(value: string): value is DisputeReason {
  return (DISPUTE_REASONS as readonly string[]).includes(value);
}

/**
 * Check if a string is a valid resolution decision
 */
export function isResolutionDecision(value: string): value is ResolutionDecision {
  return ['coder', 'reviewer', 'custom'].includes(value);
}

// ============ Display Helpers ============

/**
 * Get display marker for dispute type
 */
export function getDisputeTypeMarker(type: DisputeType): string {
  switch (type) {
    case 'major':
      return '[!!]';
    case 'minor':
      return '[~]';
    case 'coder':
      return '[C]';
    case 'reviewer':
      return '[R]';
    case 'system':
      return '[S]';
  }
}

/**
 * Get human-readable description for dispute type
 */
export function getDisputeTypeDescription(type: DisputeType): string {
  switch (type) {
    case 'major':
      return 'Major dispute - blocks task, requires human resolution';
    case 'minor':
      return 'Minor dispute - logged only, continues with coder implementation';
    case 'coder':
      return 'Coder disputes reviewer rejection';
    case 'reviewer':
      return 'Reviewer raises concern';
    case 'system':
      return 'System-created after 15 rejections';
  }
}
