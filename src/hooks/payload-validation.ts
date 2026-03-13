import type {
  CreditEventPayload,
  DisputeEventPayload,
  HealthCriticalPayload,
  HealthEventPayload,
  HookPayload,
  IntakeEventPayload,
  ProjectCompletedPayload,
  SectionCompletedPayload,
  TaskEventPayload,
} from './payload-types.js';

export function validatePayload(payload: HookPayload): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!payload.event) {
    errors.push('Missing required field: event');
  }
  if (!payload.timestamp) {
    errors.push('Missing required field: timestamp');
  }

  switch (payload.event) {
    case 'task.created':
    case 'task.updated':
    case 'task.completed':
    case 'task.failed':
      validateTaskPayload(payload as TaskEventPayload, errors);
      break;
    case 'intake.received':
    case 'intake.triaged':
    case 'intake.pr_created':
      validateIntakePayload(payload as IntakeEventPayload, errors);
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

function validateIntakePayload(payload: IntakeEventPayload, errors: string[]): void {
  if (!payload.intake) {
    errors.push('Missing required field: intake');
    return;
  }
  if (!payload.intake.source) {
    errors.push('Missing required field: intake.source');
  }
  if (!payload.intake.externalId) {
    errors.push('Missing required field: intake.externalId');
  }
  if (!payload.intake.url) {
    errors.push('Missing required field: intake.url');
  }
  if (!payload.intake.fingerprint) {
    errors.push('Missing required field: intake.fingerprint');
  }
  if (!payload.intake.title) {
    errors.push('Missing required field: intake.title');
  }
  if (!payload.intake.severity) {
    errors.push('Missing required field: intake.severity');
  }
  if (!payload.intake.status) {
    errors.push('Missing required field: intake.status');
  }
  if (!payload.project) {
    errors.push('Missing required field: project');
  }
  if (payload.event === 'intake.pr_created' && typeof payload.intake.prNumber !== 'number') {
    errors.push('Missing required field: intake.prNumber');
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
