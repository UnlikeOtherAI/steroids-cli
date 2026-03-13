import type { TemplateContext } from './templates.js';

export function resolveTaskVariable(
  path: string[],
  task: TemplateContext['task']
): string | undefined {
  if (!task) return undefined;

  const key = path[0];
  switch (key) {
    case 'id':
      return task.id;
    case 'title':
      return task.title;
    case 'status':
      return task.status;
    case 'section':
      return task.section ?? undefined;
    case 'sectionId':
      return task.sectionId ?? undefined;
    default:
      return undefined;
  }
}

export function resolveSectionVariable(
  path: string[],
  section: TemplateContext['section']
): string | undefined {
  if (!section) return undefined;

  const key = path[0];
  switch (key) {
    case 'id':
      return section.id;
    case 'name':
      return section.name;
    default:
      return undefined;
  }
}

export function resolveProjectVariable(
  path: string[],
  project: TemplateContext['project']
): string | undefined {
  if (!project) return undefined;

  const key = path[0];
  switch (key) {
    case 'name':
      return project.name;
    case 'path':
      return project.path;
    default:
      return undefined;
  }
}

export function resolveHealthVariable(
  path: string[],
  health: TemplateContext['health']
): string | number | undefined {
  if (!health) return undefined;

  const key = path[0];
  switch (key) {
    case 'score':
      return health.score;
    case 'previousScore':
      return health.previousScore;
    case 'status':
      return health.status;
    default:
      return undefined;
  }
}

export function resolveDisputeVariable(
  path: string[],
  dispute: TemplateContext['dispute']
): string | undefined {
  if (!dispute) return undefined;

  const key = path[0];
  switch (key) {
    case 'id':
      return dispute.id;
    case 'taskId':
      return dispute.taskId;
    case 'type':
      return dispute.type;
    case 'status':
      return dispute.status;
    default:
      return undefined;
  }
}

export function resolveCreditVariable(
  path: string[],
  credit: TemplateContext['credit']
): string | undefined {
  if (!credit) return undefined;

  const key = path[0];
  switch (key) {
    case 'provider':
      return credit.provider;
    case 'model':
      return credit.model;
    case 'role':
      return credit.role;
    case 'message':
      return credit.message;
    default:
      return undefined;
  }
}

export function resolveIntakeVariable(
  path: string[],
  intake: TemplateContext['intake']
): string | number | undefined {
  if (!intake) return undefined;

  const key = path[0];
  switch (key) {
    case 'source':
      return intake.source;
    case 'externalId':
      return intake.externalId;
    case 'url':
      return intake.url;
    case 'fingerprint':
      return intake.fingerprint;
    case 'title':
      return intake.title;
    case 'summary':
      return intake.summary;
    case 'severity':
      return intake.severity;
    case 'status':
      return intake.status;
    case 'linkedTaskId':
      return intake.linkedTaskId ?? undefined;
    case 'prNumber':
      return intake.prNumber;
    default:
      return undefined;
  }
}
