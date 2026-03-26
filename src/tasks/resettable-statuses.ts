import type { TaskStatus } from '../database/queries.js';

export const PROJECT_RESETTABLE_STATUSES = [
  'failed',
  'disputed',
  'blocked_error',
  'blocked_conflict',
] as const satisfies readonly TaskStatus[];

export type ProjectResettableStatus = (typeof PROJECT_RESETTABLE_STATUSES)[number];

export function isProjectResettableStatus(status: string): status is ProjectResettableStatus {
  return (PROJECT_RESETTABLE_STATUSES as readonly string[]).includes(status);
}
