import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase, withDatabase } from '../database/connection.js';
import { getTask, getTaskByTitle, listTasks, getSectionDependencies, type Task } from '../database/queries.js';
import { createOutput } from '../cli/output.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';
import type { GlobalFlags } from '../cli/flags.js';
import { openGlobalDatabase } from '../runners/global-db.js';
import { deleteTaskBranchFromSlot } from '../workspace/git-lifecycle.js';
import { releaseSlot } from '../workspace/pool.js';
import { getProjectHash } from '../parallel/clone.js';

export async function resetTaskCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'tasks', subcommand: 'reset', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      failed: { type: 'boolean', default: false },
      disputed: { type: 'boolean', default: false },
      blocked: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help || (positionals.length === 0 && !values.failed && !values.disputed && !values.blocked && !values.all)) {
    out.log(`
steroids tasks reset [<id|title>] [options] - Reset failed/disputed/blocked tasks to pending

USAGE:
  steroids tasks reset <id|title>
  steroids tasks reset --failed
  steroids tasks reset --disputed
  steroids tasks reset --blocked
  steroids tasks reset --all

OPTIONS:
  --failed          Reset all failed tasks
  --disputed        Reset all disputed tasks
  --blocked         Reset all blocked tasks (blocked_error and blocked_conflict)
  --all             Reset all failed, disputed, and blocked tasks
  -h, --help        Show help

DESCRIPTION:
  Safely resets blocked tasks back to the 'pending' state. This command executes as an
  atomic transaction and performs rigorous pre-flight checks to ensure the workspace
  and dependencies are structurally sound before allowing the task to be picked up again.
  It also kills any active runner processes to prevent race conditions.
`);
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    let tasksToReset: Task[] = [];

    if (positionals.length > 0) {
      const identifier = positionals.join(' ');
      let task = getTask(db, identifier) || getTaskByTitle(db, identifier);
      if (!task) {
        out.error(ErrorCode.TASK_NOT_FOUND, `Task not found: ${identifier}`);
        process.exit(getExitCode(ErrorCode.TASK_NOT_FOUND));
      }
      tasksToReset.push(task);
    } else {
      if (values.all || values.failed) {
        tasksToReset.push(...listTasks(db, { status: 'failed' }));
      }
      if (values.all || values.disputed) {
        tasksToReset.push(...listTasks(db, { status: 'disputed' }));
      }
      if (values.all || values.blocked) {
        tasksToReset.push(...listTasks(db, { status: 'blocked_error' }));
        tasksToReset.push(...listTasks(db, { status: 'blocked_conflict' }));
      }
      
      // Deduplicate in case
      const seen = new Set<string>();
      tasksToReset = tasksToReset.filter(t => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
    }

    if (tasksToReset.length === 0) {
      out.log('No tasks found to reset.');
      return;
    }

    const validatedTasks: Task[] = [];

    for (const task of tasksToReset) {
      out.log(`Validating task: ${task.title} (${task.id})`);

      // 1. Dependency pre-flight check
      let preFlightPassed = true;
      
      if (task.reference_task_id && task.reference_commit) {
        const refTask = getTask(db, task.reference_task_id);
        if (refTask && refTask.file_path) {
          const check = spawnSync('git', ['ls-tree', task.reference_commit, refTask.file_path], { encoding: 'utf-8' });
          if (check.status !== 0 || !check.stdout.trim()) {
            out.error(ErrorCode.GENERAL_ERROR, `Pre-flight check failed: Dependency task ${refTask.id} reference_commit ${task.reference_commit} does not contain ${refTask.file_path}`);
            preFlightPassed = false;
          }
          
          // Untracked check for the reference task's file
          if (!existsSync(join(process.cwd(), refTask.file_path))) {
            out.error(ErrorCode.GENERAL_ERROR, `Pre-flight check failed: Required untracked dependency file does not exist: ${refTask.file_path}`);
            preFlightPassed = false;
          }
        }
      }

      if (!preFlightPassed) {
        out.log(`  -> Skipping reset due to pre-flight dependency failure.`);
        continue;
      }
      
      validatedTasks.push(task);
    }

    if (validatedTasks.length === 0) {
      out.error(ErrorCode.GENERAL_ERROR, 'All tasks failed pre-flight checks.');
      process.exit(1);
    }

    // 2. Terminate active runners and revoke leases
    const fullyValidatedTasks: Task[] = [];
    for (const task of validatedTasks) {
       try {
         killRunnerAndRevokeLease(task.id, db, out);
         fullyValidatedTasks.push(task);
       } catch (e: any) {
         out.error(ErrorCode.GENERAL_ERROR, `Failed to kill active runner for task ${task.id}: ${e.message}`);
         out.log(`  -> Skipping reset due to process termination failure.`);
       }
    }

    if (fullyValidatedTasks.length === 0) {
      out.error(ErrorCode.GENERAL_ERROR, 'All tasks failed pre-flight or runner termination checks.');
      process.exit(1);
    }

    // 2b. Clean up stale task branches — BEFORE DB transaction.
    // While tasks are still in blocked status, no runner can pick them up.
    // If we cleaned after the transaction (task = pending), a runner could
    // claim the slot between the transaction commit and branch deletion.
    const blockedTasks = fullyValidatedTasks.filter(
      t => t.status === 'blocked_conflict' || t.status === 'blocked_error'
    );

    if (blockedTasks.length > 0) {
      const projectId = getProjectHash(projectPath);
      const { db: globalDb2, close: closeGlobal2 } = openGlobalDatabase();
      try {
        for (const task of blockedTasks) {
          const taskBranch = `steroids/task-${task.id}`;

          // Find slots that are idle OR still bound to this task (SIGKILL'd runner)
          const slots = globalDb2
            .prepare(
              `SELECT id, slot_path, remote_url, status, task_id
               FROM workspace_pool_slots
               WHERE project_id = ? AND (status = 'idle' OR task_id = ?)`
            )
            .all(projectId, task.id) as Array<{
              id: number; slot_path: string; remote_url: string | null;
              status: string; task_id: string | null;
            }>;

          for (const slot of slots) {
            if (!slot.slot_path || !existsSync(join(slot.slot_path, '.git'))) continue;

            deleteTaskBranchFromSlot(slot.slot_path, taskBranch, {
              deleteRemote: true,
              remoteUrl: slot.remote_url,
            });

            // Release non-idle slots that were bound to this task
            if (slot.status !== 'idle' && slot.task_id === task.id) {
              releaseSlot(globalDb2, slot.id);
            }
          }
        }
      } finally {
        closeGlobal2();
      }
    }

    // 3. Atomic Database Transaction across ALL validated tasks
    db.transaction(() => {
      for (const task of fullyValidatedTasks) {
        // Update task status — clear all failure/rejection counters
        // Also clear conflict_count when resetting blocked_conflict tasks
        db.prepare(
          `UPDATE tasks SET status = 'pending', rejection_count = 0, failure_count = 0, merge_failure_count = 0,
           conflict_count = 0
           WHERE id = ?`
        ).run(task.id);

        // Auto-resolve open disputes
        db.prepare(`UPDATE disputes SET status = 'resolved', resolution = 'custom', resolution_notes = 'Bulk reset via CLI', resolved_at = datetime('now') WHERE task_id = ? AND status = 'open'`).run(task.id);

        // Delete task_locks
        db.prepare(`DELETE FROM task_locks WHERE task_id = ?`).run(task.id);

        // Insert audit log
        db.prepare(`INSERT INTO audit (task_id, from_status, to_status, actor, notes) VALUES (?, ?, 'pending', 'human:cli', 'Human-initiated bulk reset via CLI')`).run(task.id, task.status);
      }

      // When doing a bulk reset, also clear failure_count on pending tasks that were
      // previously auto-recovered from failed — they still carry failure history but
      // are no longer in a terminal state.
      if (values.all) {
        db.prepare(
          `UPDATE tasks SET failure_count = 0, merge_failure_count = 0, last_failure_at = NULL WHERE status = 'pending' AND (COALESCE(failure_count, 0) > 0 OR COALESCE(merge_failure_count, 0) > 0)`
        ).run();
      }
    })();

    for (const task of fullyValidatedTasks) {
      out.log(`  -> Successfully reset ${task.id} to pending.`);
    }

    if (flags.json) {
      out.success({ resetCount: fullyValidatedTasks.length, totalAttempted: tasksToReset.length });
    } else {
      out.log(`\nSuccessfully reset ${fullyValidatedTasks.length} task(s).`);
    }

  });
}

function killRunnerAndRevokeLease(taskId: string, projDb: any, out: any) {
  const { db: globalDb, close: closeGlobal } = openGlobalDatabase();
  try {
    let runnerId: string | null = null;
    try {
      const inv = projDb.prepare(`SELECT runner_id FROM task_invocations WHERE task_id = ? AND runner_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(taskId) as any;
      if (inv) runnerId = inv.runner_id;
    } catch (err) {
      // ignore
    }

    if (runnerId) {
      // Find the active runner PID in global registry
      const runner = globalDb.prepare(`SELECT pid, parallel_session_id FROM runners WHERE id = ?`).get(runnerId) as any;
      if (runner && runner.pid) {
        // PID Reuse Sanity Check: Ensure it belongs to a Steroids runner process
        const ps = spawnSync('ps', ['-p', String(runner.pid), '-o', 'command='], { encoding: 'utf-8' });
        const cmdOutput = ps.stdout.toLowerCase();
        if (cmdOutput.includes('steroids') && cmdOutput.includes('runners')) {
          out.log(`  -> Killing active runner process (PID: ${runner.pid})`);
          try {
            process.kill(runner.pid, 'SIGKILL');
            spawnSync('sleep', ['0.1']);
          } catch (e: any) {
            if (e.code !== 'ESRCH') {
              throw new Error(`Failed to kill active runner PID ${runner.pid}: ${e.message}`);
            }
          }
        }
      }

      // Revoke lease and unblock session
      globalDb.transaction(() => {
        // Find workstream using deterministic lookup
        const ws = globalDb.prepare(`SELECT id, session_id FROM workstreams WHERE runner_id = ?`).get(runnerId) as any;
        if (ws) {
          out.log(`  -> Revoking workstream lease (${ws.id})`);
          globalDb.prepare(`UPDATE workstreams SET runner_id = NULL, lease_expires_at = NULL WHERE id = ?`).run(ws.id);
          
          // Unblock session
          globalDb.prepare(`UPDATE parallel_sessions SET status = 'running' WHERE id = ? AND status IN ('blocked_recovery', 'failed', 'blocked_validation', 'blocked_conflict')`).run(ws.session_id);
        }
      })();
    }
  } finally {
    closeGlobal();
  }
}
