import type { Task } from '../database/queries.js';

export interface SectionCompletionState {
  totalCount: number;
  activeCount: number;
  completedCount: number;
  done: boolean;
}

const ACTIVE_SECTION_TASK_STATUSES = new Set<Task['status']>([
  'pending',
  'in_progress',
  'review',
  'merge_pending',
  'partial',
]);

export function getSectionCompletionState(
  tasks: Array<Pick<Task, 'status'>>
): SectionCompletionState {
  const totalCount = tasks.length;
  const activeCount = tasks.filter((task) => ACTIVE_SECTION_TASK_STATUSES.has(task.status)).length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;

  return {
    totalCount,
    activeCount,
    completedCount,
    done: totalCount > 0 && activeCount === 0 && completedCount > 0,
  };
}
