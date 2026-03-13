import type { HookEvent, TaskEvent, IntakeEvent, HealthEvent, DisputeEvent, CreditEvent } from './events.js';
import type { IntakeReportStatus, IntakeSeverity, IntakeSource } from '../intake/types.js';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'review';

export type HealthStatus = 'healthy' | 'warning' | 'critical';

export type DisputeStatus = 'open' | 'resolved';

export type DisputeType = 'scope' | 'quality' | 'requirements' | 'other';

export type DisputeResolution = 'coder_wins' | 'reviewer_wins' | 'compromise' | 'escalated';

export interface BasePayload {
  event: HookEvent;
  timestamp: string;
}

export interface ProjectContext {
  name: string;
  path: string;
}

export interface TaskData {
  id: string;
  title: string;
  status: TaskStatus;
  previousStatus?: TaskStatus;
  section?: string | null;
  sectionId?: string | null;
  file?: string;
  line?: number;
  sourceFile?: string | null;
  rejectionCount?: number;
}

export interface IntakeData {
  source: IntakeSource;
  externalId: string;
  url: string;
  fingerprint: string;
  title: string;
  summary?: string;
  severity: IntakeSeverity;
  status: IntakeReportStatus;
  linkedTaskId?: string | null;
  prNumber?: number;
}

export interface SectionData {
  id: string;
  name: string;
  taskCount: number;
  file?: string;
}

export interface TaskSummary {
  id: string;
  title: string;
}

export interface HealthData {
  score: number;
  previousScore?: number;
  status: HealthStatus;
  failedChecks?: string[];
}

export interface DisputeData {
  id: string;
  taskId: string;
  type: DisputeType;
  status: DisputeStatus;
  reason: string;
  coderPosition?: string;
  reviewerPosition?: string;
  resolution?: DisputeResolution;
  resolutionNotes?: string;
  createdBy: string;
  resolvedBy?: string;
}

export interface ProjectSummary {
  totalTasks: number;
  files: string[];
  sectionCount?: number;
}

export interface TaskCreatedPayload extends BasePayload {
  event: 'task.created';
  task: TaskData;
  project: ProjectContext;
}

export interface TaskUpdatedPayload extends BasePayload {
  event: 'task.updated';
  task: TaskData;
  project: ProjectContext;
}

export interface TaskCompletedPayload extends BasePayload {
  event: 'task.completed';
  task: TaskData;
  project: ProjectContext;
}

export interface TaskFailedPayload extends BasePayload {
  event: 'task.failed';
  task: TaskData;
  project: ProjectContext;
  maxRejections: number;
}

export interface IntakeReceivedPayload extends BasePayload {
  event: 'intake.received';
  intake: IntakeData;
  project: ProjectContext;
}

export interface IntakeTriagedPayload extends BasePayload {
  event: 'intake.triaged';
  intake: IntakeData;
  project: ProjectContext;
}

export interface IntakePRCreatedPayload extends BasePayload {
  event: 'intake.pr_created';
  intake: IntakeData;
  project: ProjectContext;
}

export interface SectionCompletedPayload extends BasePayload {
  event: 'section.completed';
  section: SectionData;
  tasks: TaskSummary[];
  project: ProjectContext;
}

export interface ProjectCompletedPayload extends BasePayload {
  event: 'project.completed';
  project: ProjectContext;
  summary: ProjectSummary;
}

export interface HealthChangedPayload extends BasePayload {
  event: 'health.changed';
  project: ProjectContext;
  health: HealthData;
}

export interface HealthCriticalPayload extends BasePayload {
  event: 'health.critical';
  project: ProjectContext;
  health: HealthData;
  threshold: number;
}

export interface DisputeCreatedPayload extends BasePayload {
  event: 'dispute.created';
  dispute: DisputeData;
  task: TaskData;
  project: ProjectContext;
}

export interface DisputeResolvedPayload extends BasePayload {
  event: 'dispute.resolved';
  dispute: DisputeData;
  task: TaskData;
  project: ProjectContext;
}

export interface CreditData {
  provider: string;
  model: string;
  role: 'orchestrator' | 'coder' | 'reviewer';
  message: string;
  runner_id?: string;
}

export interface CreditExhaustedPayload extends BasePayload {
  event: 'credit.exhausted';
  credit: CreditData;
  project: ProjectContext;
}

export interface CreditResolvedPayload extends BasePayload {
  event: 'credit.resolved';
  credit: CreditData;
  project: ProjectContext;
  resolution: 'config_changed';
}

export type CreditEventPayload = CreditExhaustedPayload | CreditResolvedPayload;

export type IntakeEventPayload =
  | IntakeReceivedPayload
  | IntakeTriagedPayload
  | IntakePRCreatedPayload;

export type TaskEventPayload =
  | TaskCreatedPayload
  | TaskUpdatedPayload
  | TaskCompletedPayload
  | TaskFailedPayload;

export type HealthEventPayload = HealthChangedPayload | HealthCriticalPayload;

export type DisputeEventPayload = DisputeCreatedPayload | DisputeResolvedPayload;

export type HookPayload =
  | TaskCreatedPayload
  | TaskUpdatedPayload
  | TaskCompletedPayload
  | TaskFailedPayload
  | IntakeReceivedPayload
  | IntakeTriagedPayload
  | IntakePRCreatedPayload
  | SectionCompletedPayload
  | ProjectCompletedPayload
  | HealthChangedPayload
  | HealthCriticalPayload
  | DisputeCreatedPayload
  | DisputeResolvedPayload
  | CreditExhaustedPayload
  | CreditResolvedPayload;

export type {
  TaskEvent,
  IntakeEvent,
  HealthEvent,
  DisputeEvent,
  CreditEvent,
};
