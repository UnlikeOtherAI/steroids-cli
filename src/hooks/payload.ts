/**
 * Hook Payload Schemas
 *
 * Defines the payload structures for each hook event type.
 * Payloads contain all context needed by hook handlers.
 */

import type { HookEvent, TaskEvent, HealthEvent, DisputeEvent, CreditEvent } from './events';

/**
 * Task status values
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'review';

/**
 * Health status values
 */
export type HealthStatus = 'healthy' | 'warning' | 'critical';

/**
 * Dispute status values
 */
export type DisputeStatus = 'open' | 'resolved';

/**
 * Dispute type values
 */
export type DisputeType = 'scope' | 'quality' | 'requirements' | 'other';

/**
 * Dispute resolution values
 */
export type DisputeResolution = 'coder_wins' | 'reviewer_wins' | 'compromise' | 'escalated';

/**
 * Base payload structure for all events
 */
export interface BasePayload {
  /** Event name that triggered this hook */
  event: HookEvent;
  /** ISO 8601 timestamp of when the event occurred */
  timestamp: string;
}

/**
 * Project context included in all payloads
 */
export interface ProjectContext {
  /** Project name (directory name) */
  name: string;
  /** Absolute path to project root */
  path: string;
}

/**
 * Task data for task-related events
 */
export interface TaskData {
  /** Unique task identifier */
  id: string;
  /** Task title/description */
  title: string;
  /** Current task status */
  status: TaskStatus;
  /** Previous status (for update events) */
  previousStatus?: TaskStatus;
  /** Section name the task belongs to */
  section?: string | null;
  /** Section ID the task belongs to */
  sectionId?: string | null;
  /** File where task is defined */
  file?: string;
  /** Line number in source file */
  line?: number;
  /** Original source file for synced tasks */
  sourceFile?: string | null;
  /** Number of times task was rejected */
  rejectionCount?: number;
}

/**
 * Section data for section-related events
 */
export interface SectionData {
  /** Unique section identifier */
  id: string;
  /** Section name */
  name: string;
  /** Number of tasks in section */
  taskCount: number;
  /** File where section is defined */
  file?: string;
}

/**
 * Task summary for section/project completion
 */
export interface TaskSummary {
  /** Task ID */
  id: string;
  /** Task title */
  title: string;
}

/**
 * Health data for health-related events
 */
export interface HealthData {
  /** Current health score (0-100) */
  score: number;
  /** Previous health score (for change events) */
  previousScore?: number;
  /** Health status category */
  status: HealthStatus;
  /** List of failed check names */
  failedChecks?: string[];
}

/**
 * Dispute data for dispute-related events
 */
export interface DisputeData {
  /** Unique dispute identifier */
  id: string;
  /** Task ID the dispute is about */
  taskId: string;
  /** Type of dispute */
  type: DisputeType;
  /** Dispute status */
  status: DisputeStatus;
  /** Reason for opening dispute */
  reason: string;
  /** Coder's position */
  coderPosition?: string;
  /** Reviewer's position */
  reviewerPosition?: string;
  /** Resolution (for resolved disputes) */
  resolution?: DisputeResolution;
  /** Resolution notes */
  resolutionNotes?: string;
  /** Who created the dispute */
  createdBy: string;
  /** Who resolved the dispute (if resolved) */
  resolvedBy?: string;
}

/**
 * Project summary for project completion
 */
export interface ProjectSummary {
  /** Total number of tasks in project */
  totalTasks: number;
  /** List of files containing tasks */
  files: string[];
  /** Number of sections */
  sectionCount?: number;
}

// ============================================================================
// Event-Specific Payloads
// ============================================================================

/**
 * Payload for task.created event
 */
export interface TaskCreatedPayload extends BasePayload {
  event: 'task.created';
  task: TaskData;
  project: ProjectContext;
}

/**
 * Payload for task.updated event
 */
export interface TaskUpdatedPayload extends BasePayload {
  event: 'task.updated';
  task: TaskData;
  project: ProjectContext;
}

/**
 * Payload for task.completed event
 */
export interface TaskCompletedPayload extends BasePayload {
  event: 'task.completed';
  task: TaskData;
  project: ProjectContext;
}

/**
 * Payload for task.failed event
 */
export interface TaskFailedPayload extends BasePayload {
  event: 'task.failed';
  task: TaskData;
  project: ProjectContext;
  /** Maximum rejections reached */
  maxRejections: number;
}

/**
 * Payload for section.completed event
 */
export interface SectionCompletedPayload extends BasePayload {
  event: 'section.completed';
  section: SectionData;
  tasks: TaskSummary[];
  project: ProjectContext;
}

/**
 * Payload for project.completed event
 */
export interface ProjectCompletedPayload extends BasePayload {
  event: 'project.completed';
  project: ProjectContext;
  summary: ProjectSummary;
}

/**
 * Payload for health.changed event
 */
export interface HealthChangedPayload extends BasePayload {
  event: 'health.changed';
  project: ProjectContext;
  health: HealthData;
}

/**
 * Payload for health.critical event
 */
export interface HealthCriticalPayload extends BasePayload {
  event: 'health.critical';
  project: ProjectContext;
  health: HealthData;
  /** Threshold that was violated */
  threshold: number;
}

/**
 * Payload for dispute.created event
 */
export interface DisputeCreatedPayload extends BasePayload {
  event: 'dispute.created';
  dispute: DisputeData;
  task: TaskData;
  project: ProjectContext;
}

/**
 * Payload for dispute.resolved event
 */
export interface DisputeResolvedPayload extends BasePayload {
  event: 'dispute.resolved';
  dispute: DisputeData;
  task: TaskData;
  project: ProjectContext;
}

/**
 * Credit exhaustion data for credit-related events
 */
export interface CreditData {
  /** Provider name (e.g. 'claude', 'codex', 'gemini') */
  provider: string;
  /** Model name */
  model: string;
  /** Role that was affected */
  role: 'orchestrator' | 'coder' | 'reviewer';
  /** Error message from the provider */
  message: string;
  /** Runner ID if available */
  runner_id?: string;
}

/**
 * Payload for credit.exhausted event
 */
export interface CreditExhaustedPayload extends BasePayload {
  event: 'credit.exhausted';
  credit: CreditData;
  project: ProjectContext;
}

/**
 * Payload for credit.resolved event
 */
export interface CreditResolvedPayload extends BasePayload {
  event: 'credit.resolved';
  credit: CreditData;
  project: ProjectContext;
  resolution: 'config_changed';
}

/**
 * Union of all credit event payloads
 */
export type CreditEventPayload = CreditExhaustedPayload | CreditResolvedPayload;

/**
 * Union of all task event payloads
 */
export type TaskEventPayload =
  | TaskCreatedPayload
  | TaskUpdatedPayload
  | TaskCompletedPayload
  | TaskFailedPayload;

/**
 * Union of all health event payloads
 */
export type HealthEventPayload = HealthChangedPayload | HealthCriticalPayload;

/**
 * Union of all dispute event payloads
 */
export type DisputeEventPayload = DisputeCreatedPayload | DisputeResolvedPayload;

/**
 * Union of all possible hook payloads
 */
export type HookPayload =
  | TaskCreatedPayload
  | TaskUpdatedPayload
  | TaskCompletedPayload
  | TaskFailedPayload
  | SectionCompletedPayload
  | ProjectCompletedPayload
  | HealthChangedPayload
  | HealthCriticalPayload
  | DisputeCreatedPayload
  | DisputeResolvedPayload
  | CreditExhaustedPayload
  | CreditResolvedPayload;

// ============================================================================
// Payload Factory Functions
// ============================================================================

/**
 * Create a base payload with common fields
 */
function createBasePayload<E extends HookEvent>(event: E): BasePayload & { event: E } {
  return {
    event,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a task.created payload
 */
export function createTaskCreatedPayload(
  task: TaskData,
  project: ProjectContext
): TaskCreatedPayload {
  return {
    ...createBasePayload('task.created'),
    task,
    project,
  };
}

/**
 * Create a task.updated payload
 */
export function createTaskUpdatedPayload(
  task: TaskData,
  project: ProjectContext
): TaskUpdatedPayload {
  return {
    ...createBasePayload('task.updated'),
    task,
    project,
  };
}

/**
 * Create a task.completed payload
 */
export function createTaskCompletedPayload(
  task: TaskData,
  project: ProjectContext
): TaskCompletedPayload {
  return {
    ...createBasePayload('task.completed'),
    task,
    project,
  };
}

/**
 * Create a task.failed payload
 */
export function createTaskFailedPayload(
  task: TaskData,
  project: ProjectContext,
  maxRejections: number
): TaskFailedPayload {
  return {
    ...createBasePayload('task.failed'),
    task,
    project,
    maxRejections,
  };
}

/**
 * Create a section.completed payload
 */
export function createSectionCompletedPayload(
  section: SectionData,
  tasks: TaskSummary[],
  project: ProjectContext
): SectionCompletedPayload {
  return {
    ...createBasePayload('section.completed'),
    section,
    tasks,
    project,
  };
}

/**
 * Create a project.completed payload
 */
export function createProjectCompletedPayload(
  project: ProjectContext,
  summary: ProjectSummary
): ProjectCompletedPayload {
  return {
    ...createBasePayload('project.completed'),
    project,
    summary,
  };
}

/**
 * Create a health.changed payload
 */
export function createHealthChangedPayload(
  project: ProjectContext,
  health: HealthData
): HealthChangedPayload {
  return {
    ...createBasePayload('health.changed'),
    project,
    health,
  };
}

/**
 * Create a health.critical payload
 */
export function createHealthCriticalPayload(
  project: ProjectContext,
  health: HealthData,
  threshold: number
): HealthCriticalPayload {
  return {
    ...createBasePayload('health.critical'),
    project,
    health,
    threshold,
  };
}

/**
 * Create a dispute.created payload
 */
export function createDisputeCreatedPayload(
  dispute: DisputeData,
  task: TaskData,
  project: ProjectContext
): DisputeCreatedPayload {
  return {
    ...createBasePayload('dispute.created'),
    dispute,
    task,
    project,
  };
}

/**
 * Create a dispute.resolved payload
 */
export function createDisputeResolvedPayload(
  dispute: DisputeData,
  task: TaskData,
  project: ProjectContext
): DisputeResolvedPayload {
  return {
    ...createBasePayload('dispute.resolved'),
    dispute,
    task,
    project,
  };
}

/**
 * Create a credit.exhausted payload
 */
export function createCreditExhaustedPayload(
  credit: CreditData,
  project: ProjectContext
): CreditExhaustedPayload {
  return {
    ...createBasePayload('credit.exhausted'),
    credit,
    project,
  };
}

/**
 * Create a credit.resolved payload
 */
export function createCreditResolvedPayload(
  credit: CreditData,
  project: ProjectContext,
  resolution: 'config_changed'
): CreditResolvedPayload {
  return {
    ...createBasePayload('credit.resolved'),
    credit,
    project,
    resolution,
  };
}

// ============================================================================
// Payload Validation
// ============================================================================

/**
 * Validate that a payload has required fields for its event type
 */
export function validatePayload(payload: HookPayload): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Base validation
  if (!payload.event) {
    errors.push('Missing required field: event');
  }
  if (!payload.timestamp) {
    errors.push('Missing required field: timestamp');
  }

  // Event-specific validation
  switch (payload.event) {
    case 'task.created':
    case 'task.updated':
    case 'task.completed':
    case 'task.failed':
      validateTaskPayload(payload as TaskEventPayload, errors);
      break;

    case 'section.completed':
      validateSectionPayload(payload as SectionCompletedPayload, errors);
      break;

    case 'project.completed':
      validateProjectPayload(payload as ProjectCompletedPayload, errors);
      break;

    case 'health.changed':
    case 'health.critical':
      validateHealthPayload(payload as HealthEventPayload, errors);
      break;

    case 'dispute.created':
    case 'dispute.resolved':
      validateDisputePayload(payload as DisputeEventPayload, errors);
      break;

    case 'credit.exhausted':
    case 'credit.resolved':
      validateCreditPayload(payload as CreditEventPayload, errors);
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateTaskPayload(payload: TaskEventPayload, errors: string[]): void {
  if (!payload.task) {
    errors.push('Missing required field: task');
    return;
  }
  if (!payload.task.id) {
    errors.push('Missing required field: task.id');
  }
  if (!payload.task.title) {
    errors.push('Missing required field: task.title');
  }
  if (!payload.task.status) {
    errors.push('Missing required field: task.status');
  }
  if (!payload.project) {
    errors.push('Missing required field: project');
  }
}

function validateSectionPayload(payload: SectionCompletedPayload, errors: string[]): void {
  if (!payload.section) {
    errors.push('Missing required field: section');
    return;
  }
  if (!payload.section.id) {
    errors.push('Missing required field: section.id');
  }
  if (!payload.section.name) {
    errors.push('Missing required field: section.name');
  }
  if (!payload.project) {
    errors.push('Missing required field: project');
  }
}

function validateProjectPayload(payload: ProjectCompletedPayload, errors: string[]): void {
  if (!payload.project) {
    errors.push('Missing required field: project');
    return;
  }
  if (!payload.project.name) {
    errors.push('Missing required field: project.name');
  }
  if (!payload.project.path) {
    errors.push('Missing required field: project.path');
  }
  if (!payload.summary) {
    errors.push('Missing required field: summary');
  }
}

function validateHealthPayload(payload: HealthEventPayload, errors: string[]): void {
  if (!payload.health) {
    errors.push('Missing required field: health');
    return;
  }
  if (typeof payload.health.score !== 'number') {
    errors.push('Missing or invalid field: health.score');
  }
  if (!payload.health.status) {
    errors.push('Missing required field: health.status');
  }
  if (!payload.project) {
    errors.push('Missing required field: project');
  }
  if (payload.event === 'health.critical') {
    const criticalPayload = payload as HealthCriticalPayload;
    if (typeof criticalPayload.threshold !== 'number') {
      errors.push('Missing required field: threshold');
    }
  }
}

function validateDisputePayload(payload: DisputeEventPayload, errors: string[]): void {
  if (!payload.dispute) {
    errors.push('Missing required field: dispute');
    return;
  }
  if (!payload.dispute.id) {
    errors.push('Missing required field: dispute.id');
  }
  if (!payload.dispute.taskId) {
    errors.push('Missing required field: dispute.taskId');
  }
  if (!payload.task) {
    errors.push('Missing required field: task');
  }
  if (!payload.project) {
    errors.push('Missing required field: project');
  }
}

function validateCreditPayload(payload: CreditEventPayload, errors: string[]): void {
  if (!payload.credit) {
    errors.push('Missing required field: credit');
    return;
  }
  if (!payload.credit.provider) {
    errors.push('Missing required field: credit.provider');
  }
  if (!payload.credit.model) {
    errors.push('Missing required field: credit.model');
  }
  if (!payload.credit.role) {
    errors.push('Missing required field: credit.role');
  }
  if (!payload.project) {
    errors.push('Missing required field: project');
  }
}
