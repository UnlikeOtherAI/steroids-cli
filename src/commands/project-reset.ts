import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { withDatabase } from '../database/connection.js';
import { openGlobalDatabase } from '../runners/global-db-connection.js';
import { createOutput } from '../cli/output.js';
import type { GlobalFlags } from '../cli/flags.js';
import { listRunners, unregisterRunner } from '../runners/daemon.js';
import { isProcessAlive } from '../runners/lock.js';

export async function resetProject(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'reset-project', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    out.log(`
steroids reset-project - Reset project to clean state

USAGE:
  steroids reset-project [options]

OPTIONS:
  -y, --yes         Skip confirmation prompt
  -h, --help        Show help

DESCRIPTION:
  Resets all tasks back to pending and clears all execution history
  (invocations, audit trail, disputes, locks, feedback, incidents).
  Preserves task/section/dependency structure.

  Stops all active runners for this project before resetting.
`);
    return;
  }

  const projectPath = process.cwd();

  // Preview what will be reset
  const preview = withDatabase(projectPath, (db: any) => {
    const taskCount = (db.prepare(`SELECT COUNT(*) as c FROM tasks`).get() as any).c;
    const invocationCount = (db.prepare(`SELECT COUNT(*) as c FROM task_invocations`).get() as any).c;
    const auditCount = (db.prepare(`SELECT COUNT(*) as c FROM audit`).get() as any).c;
    const disputeCount = (db.prepare(`SELECT COUNT(*) as c FROM disputes`).get() as any).c;
    const feedbackCount = (db.prepare(`SELECT COUNT(*) as c FROM task_feedback`).get() as any).c;
    const incidentCount = (db.prepare(`SELECT COUNT(*) as c FROM incidents`).get() as any).c;
    return { taskCount, invocationCount, auditCount, disputeCount, feedbackCount, incidentCount };
  });

  if (!preview) {
    out.log('No database found for this project. Run "steroids init" first.');
    return;
  }

  if (preview.taskCount === 0) {
    out.log('No tasks found in this project. Nothing to reset.');
    return;
  }

  // Confirmation
  if (!values.yes) {
    out.log(`This will reset the project at: ${projectPath}\n`);
    out.log(`  ${preview.taskCount} task(s) → status=pending, counters zeroed`);
    out.log(`  ${preview.invocationCount} invocation record(s) → deleted`);
    out.log(`  ${preview.auditCount} audit record(s) → deleted`);
    out.log(`  ${preview.disputeCount} dispute(s) → deleted`);
    out.log(`  ${preview.feedbackCount} feedback record(s) → deleted`);
    out.log(`  ${preview.incidentCount} incident(s) → deleted`);
    out.log(`\nTask/section/dependency structure will be preserved.`);

    const confirmed = await promptConfirm('Proceed with reset? [y/N] ');
    if (!confirmed) {
      out.log('Reset cancelled.');
      return;
    }
  }

  // Stop all runners for this project
  const runners = listRunners().filter((r) => r.project_path === projectPath);
  let stopped = 0;
  for (const runner of runners) {
    if (runner.pid && isProcessAlive(runner.pid)) {
      try {
        process.kill(runner.pid, 'SIGTERM');
        stopped++;
      } catch {
        // Process already dead
      }
    }
    unregisterRunner(runner.id);
  }
  if (stopped > 0) {
    out.log(`Stopped ${stopped} runner(s) for this project.`);
    // Wait for runners to exit before resetting DB
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Clean parallel sessions/workstreams from global DB
  try {
    const globalConn = openGlobalDatabase();
    globalConn.db.prepare(`UPDATE parallel_sessions SET status = 'failed' WHERE project_path = ? AND status = 'running'`).run(projectPath);
    globalConn.db.prepare(`UPDATE workstreams SET status = 'failed' WHERE session_id IN (SELECT id FROM parallel_sessions WHERE project_path = ?)`).run(projectPath);
    globalConn.close();
  } catch {
    // Global DB cleanup is best-effort
  }

  // Perform the reset in a single transaction
  withDatabase(projectPath, (db: any) => {
    db.transaction(() => {
      // Clear execution history
      db.prepare(`DELETE FROM task_invocations`).run();
      db.prepare(`DELETE FROM audit`).run();
      db.prepare(`DELETE FROM disputes`).run();
      db.prepare(`DELETE FROM task_feedback`).run();
      db.prepare(`DELETE FROM incidents`).run();
      db.prepare(`DELETE FROM task_locks`).run();
      db.prepare(`DELETE FROM section_locks`).run();
      db.prepare(`DELETE FROM merge_locks`).run();
      db.prepare(`DELETE FROM merge_progress`).run();

      // Reset all tasks to pending
      db.prepare(`UPDATE tasks SET
        status = 'pending',
        rejection_count = 0,
        failure_count = 0,
        merge_failure_count = 0,
        conflict_count = 0,
        start_commit_sha = NULL,
        blocked_reason = NULL,
        updated_at = datetime('now')
      `).run();
    })();
  });

  out.log(`\nProject reset complete:`);
  out.log(`  ${preview.taskCount} task(s) reset to pending`);
  const cleared =
    preview.invocationCount + preview.auditCount + preview.disputeCount +
    preview.feedbackCount + preview.incidentCount;
  out.log(`  ${cleared} history record(s) cleared`);
}

function promptConfirm(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}
