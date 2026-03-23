/**
 * Helpers for First Responder actions — branch cleanup and workspace operations.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openGlobalDatabase } from '../runners/global-db-connection.js';
import { deleteTaskBranchFromSlot } from '../workspace/git-lifecycle.js';
import { releaseSlot } from '../workspace/pool.js';
import { getProjectHash } from '../parallel/clone.js';

export function cleanupBlockedTaskBranch(projectPath: string, taskId: string): void {
  try {
    const projectId = getProjectHash(projectPath);
    const { db: globalDb, close } = openGlobalDatabase();
    try {
      const taskBranch = `steroids/task-${taskId}`;
      const slots = globalDb
        .prepare(
          `SELECT id, slot_path, remote_url, status, task_id
           FROM workspace_pool_slots
           WHERE project_id = ? AND (status = 'idle' OR task_id = ?)`
        )
        .all(projectId, taskId) as Array<{
        id: number; slot_path: string; remote_url: string | null;
        status: string; task_id: string | null;
      }>;

      for (const slot of slots) {
        if (!slot.slot_path || !existsSync(join(slot.slot_path, '.git'))) continue;
        deleteTaskBranchFromSlot(slot.slot_path, taskBranch, {
          deleteRemote: true,
          remoteUrl: slot.remote_url,
        });
        if (slot.status !== 'idle' && slot.task_id === taskId) {
          releaseSlot(globalDb, slot.id);
        }
      }
    } finally {
      close();
    }
  } catch {
    // Branch cleanup is best-effort — the coder will create a fresh branch regardless
  }
}
