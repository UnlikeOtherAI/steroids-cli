/**
 * Hook Event Types
 *
 * Defines all hook events that can trigger scripts or webhooks.
 * Events are emitted when state changes occur in the system.
 */

/**
 * All supported hook event names
 */
export const HOOK_EVENTS = [
  'task.created',
  'task.updated',
  'task.completed',
  'task.failed',
  'section.completed',
  'project.completed',
  'health.changed',
  'health.critical',
  'dispute.created',
  'dispute.resolved',
  'credit.exhausted',
  'credit.resolved',
] as const;

/**
 * Hook event type (union of all event names)
 */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Task-related events
 */
export const TASK_EVENTS = [
  'task.created',
  'task.updated',
  'task.completed',
  'task.failed',
] as const;

export type TaskEvent = (typeof TASK_EVENTS)[number];

/**
 * Section-related events
 */
export const SECTION_EVENTS = ['section.completed'] as const;

export type SectionEvent = (typeof SECTION_EVENTS)[number];

/**
 * Project-related events
 */
export const PROJECT_EVENTS = ['project.completed'] as const;

export type ProjectEvent = (typeof PROJECT_EVENTS)[number];

/**
 * Health-related events
 */
export const HEALTH_EVENTS = ['health.changed', 'health.critical'] as const;

export type HealthEvent = (typeof HEALTH_EVENTS)[number];

/**
 * Dispute-related events
 */
export const DISPUTE_EVENTS = ['dispute.created', 'dispute.resolved'] as const;

export type DisputeEvent = (typeof DISPUTE_EVENTS)[number];

/**
 * Credit-related events
 */
export const CREDIT_EVENTS = ['credit.exhausted', 'credit.resolved'] as const;

export type CreditEvent = (typeof CREDIT_EVENTS)[number];

/**
 * Event descriptions for documentation and help text
 */
export const EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  'task.created': 'Triggered when a new task is added',
  'task.updated': 'Triggered when a task status changes',
  'task.completed': 'Triggered when a task is marked complete',
  'task.failed': 'Triggered when a task fails (max rejections reached)',
  'section.completed': 'Triggered when all tasks in a section are done',
  'project.completed': 'Triggered when all tasks in the project are done',
  'health.changed': 'Triggered when the project health score changes',
  'health.critical': 'Triggered when health drops below threshold',
  'dispute.created': 'Triggered when a dispute is opened',
  'dispute.resolved': 'Triggered when a dispute is resolved',
  'credit.exhausted': 'Triggered when a provider runs out of credits',
  'credit.resolved': 'Triggered when credit exhaustion is resolved (config changed)',
};

/**
 * Check if a string is a valid hook event
 */
export function isValidHookEvent(event: string): event is HookEvent {
  return HOOK_EVENTS.includes(event as HookEvent);
}

/**
 * Check if an event is a task event
 */
export function isTaskEvent(event: HookEvent): event is TaskEvent {
  return TASK_EVENTS.includes(event as TaskEvent);
}

/**
 * Check if an event is a section event
 */
export function isSectionEvent(event: HookEvent): event is SectionEvent {
  return SECTION_EVENTS.includes(event as SectionEvent);
}

/**
 * Check if an event is a project event
 */
export function isProjectEvent(event: HookEvent): event is ProjectEvent {
  return PROJECT_EVENTS.includes(event as ProjectEvent);
}

/**
 * Check if an event is a health event
 */
export function isHealthEvent(event: HookEvent): event is HealthEvent {
  return HEALTH_EVENTS.includes(event as HealthEvent);
}

/**
 * Check if an event is a dispute event
 */
export function isDisputeEvent(event: HookEvent): event is DisputeEvent {
  return DISPUTE_EVENTS.includes(event as DisputeEvent);
}

/**
 * Get all events in a category
 */
export function getEventsByCategory(): Record<string, HookEvent[]> {
  return {
    task: [...TASK_EVENTS],
    section: [...SECTION_EVENTS],
    project: [...PROJECT_EVENTS],
    health: [...HEALTH_EVENTS],
    dispute: [...DISPUTE_EVENTS],
    credit: [...CREDIT_EVENTS],
  };
}

/**
 * Check if an event is a credit event
 */
export function isCreditEvent(event: HookEvent): event is CreditEvent {
  return CREDIT_EVENTS.includes(event as CreditEvent);
}
