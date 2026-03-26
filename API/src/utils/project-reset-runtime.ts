import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';
import { hasActiveParallelSessionForProjectDb } from '../../../dist/runners/parallel-session-state.js';
import { cleanupTaskRuntimeState } from '../../../src/commands/task-runtime-cleanup.js';

interface TaskIdRow {
  id: string;
}

function hasActiveStandaloneRunner(globalDb: Database.Database, projectPath: string): boolean {
  return (
    globalDb.prepare(
      `SELECT 1
       FROM runners
       WHERE project_path = ?
         AND status != 'stopped'
         AND heartbeat_at > datetime('now', '-5 minutes')
         AND parallel_session_id IS NULL`,
    ).get(projectPath) !== undefined
  );
}

function resetTaskToPending(projectDb: Database.Database, taskId: string): void {
  projectDb.prepare(`DELETE FROM task_locks WHERE task_id = ?`).run(taskId);
  projectDb
    .prepare(
      `UPDATE task_invocations
       SET status = 'failed'
       WHERE task_id = ?
         AND status = 'running'`,
    )
    .run(taskId);
  projectDb
    .prepare(
      `UPDATE tasks
       SET status = 'pending',
           updated_at = datetime('now')
       WHERE id = ?
         AND status = 'in_progress'`,
    )
    .run(taskId);
}

export function resetOrphanedInProgressTasks(projectPath: string): number {
  const { db: globalDb, close: closeGlobalDb } = openGlobalDatabase();
  try {
    if (hasActiveStandaloneRunner(globalDb, projectPath)) {
      return 0;
    }

    if (hasActiveParallelSessionForProjectDb(globalDb as never, projectPath)) {
      return 0;
    }

    const dbPath = join(projectPath, '.steroids', 'steroids.db');
    if (!existsSync(dbPath)) {
      return 0;
    }

    let projectDb: Database.Database | undefined;
    try {
      projectDb = new Database(dbPath, { fileMustExist: true });
      const taskRows = projectDb
        .prepare(`SELECT id FROM tasks WHERE status = 'in_progress'`)
        .all() as TaskIdRow[];

      if (taskRows.length === 0) {
        return 0;
      }

      for (const task of taskRows) {
        cleanupTaskRuntimeState(globalDb, task.id, projectPath, undefined, projectDb);
      }

      const resetTasks = projectDb.transaction((taskIds: string[]) => {
        for (const taskId of taskIds) {
          resetTaskToPending(projectDb!, taskId);
        }
      });
      resetTasks(taskRows.map((task) => task.id));

      return taskRows.length;
    } finally {
      projectDb?.close();
    }
  } finally {
    closeGlobalDb();
  }
}
