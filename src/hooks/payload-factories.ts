import type { HookEvent } from './events.js';
import type {
  BasePayload,
  CreditData,
  CreditExhaustedPayload,
  CreditResolvedPayload,
  DisputeCreatedPayload,
  DisputeData,
  DisputeResolvedPayload,
  HealthChangedPayload,
  HealthCriticalPayload,
  HealthData,
  IntakeData,
  IntakePRCreatedPayload,
  IntakeReceivedPayload,
  IntakeTriagedPayload,
  ProjectCompletedPayload,
  ProjectContext,
  ProjectSummary,
  SectionCompletedPayload,
  SectionData,
  TaskCompletedPayload,
  TaskCreatedPayload,
  TaskData,
  TaskFailedPayload,
  TaskSummary,
  TaskUpdatedPayload,
} from './payload-types.js';

function createBasePayload<E extends HookEvent>(event: E): BasePayload & { event: E } {
  return {
    event,
    timestamp: new Date().toISOString(),
  };
}

export function createTaskCreatedPayload(task: TaskData, project: ProjectContext): TaskCreatedPayload {
  return { ...createBasePayload('task.created'), task, project };
}

export function createTaskUpdatedPayload(task: TaskData, project: ProjectContext): TaskUpdatedPayload {
  return { ...createBasePayload('task.updated'), task, project };
}

export function createTaskCompletedPayload(task: TaskData, project: ProjectContext): TaskCompletedPayload {
  return { ...createBasePayload('task.completed'), task, project };
}

export function createTaskFailedPayload(
  task: TaskData,
  project: ProjectContext,
  maxRejections: number
): TaskFailedPayload {
  return { ...createBasePayload('task.failed'), task, project, maxRejections };
}

export function createIntakeReceivedPayload(
  intake: IntakeData,
  project: ProjectContext
): IntakeReceivedPayload {
  return { ...createBasePayload('intake.received'), intake, project };
}

export function createIntakeTriagedPayload(
  intake: IntakeData,
  project: ProjectContext
): IntakeTriagedPayload {
  return { ...createBasePayload('intake.triaged'), intake, project };
}

export function createIntakePRCreatedPayload(
  intake: IntakeData,
  project: ProjectContext
): IntakePRCreatedPayload {
  return { ...createBasePayload('intake.pr_created'), intake, project };
}

export function createSectionCompletedPayload(
  section: SectionData,
  tasks: TaskSummary[],
  project: ProjectContext
): SectionCompletedPayload {
  return { ...createBasePayload('section.completed'), section, tasks, project };
}

export function createProjectCompletedPayload(
  project: ProjectContext,
  summary: ProjectSummary
): ProjectCompletedPayload {
  return { ...createBasePayload('project.completed'), project, summary };
}

export function createHealthChangedPayload(
  project: ProjectContext,
  health: HealthData
): HealthChangedPayload {
  return { ...createBasePayload('health.changed'), project, health };
}

export function createHealthCriticalPayload(
  project: ProjectContext,
  health: HealthData,
  threshold: number
): HealthCriticalPayload {
  return { ...createBasePayload('health.critical'), project, health, threshold };
}

export function createDisputeCreatedPayload(
  dispute: DisputeData,
  task: TaskData,
  project: ProjectContext
): DisputeCreatedPayload {
  return { ...createBasePayload('dispute.created'), dispute, task, project };
}

export function createDisputeResolvedPayload(
  dispute: DisputeData,
  task: TaskData,
  project: ProjectContext
): DisputeResolvedPayload {
  return { ...createBasePayload('dispute.resolved'), dispute, task, project };
}

export function createCreditExhaustedPayload(
  credit: CreditData,
  project: ProjectContext
): CreditExhaustedPayload {
  return { ...createBasePayload('credit.exhausted'), credit, project };
}

export function createCreditResolvedPayload(
  credit: CreditData,
  project: ProjectContext,
  resolution: 'config_changed'
): CreditResolvedPayload {
  return { ...createBasePayload('credit.resolved'), credit, project, resolution };
}
