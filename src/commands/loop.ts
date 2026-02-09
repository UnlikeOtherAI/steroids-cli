import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids loop - Main orchestrator loop
 * Runs continuously until all tasks are done
 */

import { parseArgs } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDatabase } from '../database/connection.js';
import {
  getSection,
  getSectionByName,
  listSections,
} from '../database/queries.js';
import {
  selectNextTask,
  markTaskInProgress,
  getTaskCounts,
} from '../orchestrator/task-selector.js';
import { hasActiveRunnerForProject } from '../runners/wakeup.js';
import { getRegisteredProject } from '../runners/projects.js';
import { runCoderPhase, runReviewerPhase, type CoordinatorResult } from './loop-phases.js';
import { generateHelp } from '../cli/help.js';
import { createOutput } from '../cli/output.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';

const HELP = generateHelp({
  command: 'loop',
  description: 'Run the automated coder/reviewer orchestration loop',
  details: `The orchestrator loop is the heart of Steroids automation.
It continuously selects tasks, assigns them to coder or reviewer, and tracks progress.
Runs until all tasks are completed or interrupted.`,
  usage: ['steroids loop [options]'],
  options: [
    { long: 'project', description: 'Run loop for specific project directory', values: '<path>' },
    { long: 'section', description: 'Focus on a specific section only', values: '<id|name>' },
    { long: 'once', description: 'Run one iteration only (don\'t loop continuously)' },
  ],
  examples: [
    { command: 'steroids loop', description: 'Run until all tasks done' },
    { command: 'steroids loop --once', description: 'Process one task only' },
    { command: 'steroids loop --dry-run', description: 'Preview without executing' },
    { command: 'steroids loop --verbose', description: 'Show detailed progress' },
    { command: 'steroids loop --project ~/code/myapp', description: 'Run for specific project' },
    { command: 'steroids loop --section "Phase 2"', description: 'Focus on specific section' },
    { command: 'steroids loop --section fd1f', description: 'Section by ID prefix' },
    { command: 'STEROIDS_NO_HOOKS=1 steroids loop', description: 'Run without git hooks' },
  ],
  related: [
    { command: 'steroids tasks', description: 'View task status during loop execution' },
    { command: 'steroids runners', description: 'Manage background loop runners' },
    { command: 'steroids dispute', description: 'View coder/reviewer disputes' },
  ],
  sections: [
    {
      title: 'HOW IT WORKS',
      content: `1. Select next task (review > in_progress > pending)
2. Invoke coder (Claude) for pending/rejected tasks
3. Invoke reviewer (Codex) for tasks in review
4. Push to git on task completion
5. Repeat until all tasks complete or interrupted

Coder is responsible for running build/test commands.
Reviewer checks code quality and adherence to spec.`,
    },
    {
      title: 'TASK PRIORITY',
      content: `Tasks are selected in this order:
- Status priority: review > in_progress > pending
- Within same status: section position, then creation time
- Section dependencies respected (waiting sections blocked)`,
    },
  ],
});

export async function loopCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'loop', flags });

  // Check global help flag first
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { values } = parseArgs({
    args,
    options: {
      once: { type: 'boolean', default: false },
      project: { type: 'string' },
      section: { type: 'string' },
    },
    allowPositionals: false,
  });

  // Handle --project flag: change directory if specified
  if (values.project) {
    const projectPath = resolve(values.project as string);
    const steroidsDbPath = join(projectPath, '.steroids', 'steroids.db');

    // Validate project path exists
    if (!existsSync(projectPath)) {
      if (flags.json) {
        out.error(ErrorCode.CONFIG_ERROR, `Path does not exist: ${projectPath}`, { path: projectPath });
      } else {
        console.error(`Error: Path does not exist: ${projectPath}`);
      }
      process.exit(getExitCode(ErrorCode.CONFIG_ERROR));
    }

    // Validate it's a directory, not a file
    try {
      const stats = statSync(projectPath);
      if (!stats.isDirectory()) {
        if (flags.json) {
          out.error(ErrorCode.CONFIG_ERROR, `Path is not a directory: ${projectPath}`, { path: projectPath });
        } else {
          console.error(`Error: Path is not a directory: ${projectPath}`);
        }
        process.exit(getExitCode(ErrorCode.CONFIG_ERROR));
      }
    } catch (error) {
      if (flags.json) {
        out.error(ErrorCode.CONFIG_ERROR, `Cannot access path: ${projectPath}`, { path: projectPath });
      } else {
        console.error(`Error: Cannot access path: ${projectPath}`);
      }
      process.exit(getExitCode(ErrorCode.CONFIG_ERROR));
    }

    // Validate it's a steroids project
    if (!existsSync(steroidsDbPath)) {
      if (flags.json) {
        out.error(ErrorCode.NOT_INITIALIZED, `Not a steroids project: ${projectPath}`, {
          path: projectPath,
          missing: steroidsDbPath,
          hint: 'Run "steroids init" in that directory first.',
        });
      } else {
        console.error(`Error: Not a steroids project: ${projectPath}`);
        console.error(`  Missing: ${steroidsDbPath}`);
        console.error('  Run "steroids init" in that directory first.');
      }
      process.exit(getExitCode(ErrorCode.NOT_INITIALIZED));
    }

    // Change to project directory
    process.chdir(projectPath);

    // Only show message if not in dry-run mode (for scripting consistency)
    if (!flags.dryRun && !flags.json) {
      console.log(`Switched to project: ${projectPath}`);
      console.log('');
    }
  }

  const projectPath = process.cwd();

  // Check if project is disabled in the global registry
  const registeredProject = getRegisteredProject(projectPath);
  if (registeredProject && !registeredProject.enabled) {
    if (flags.json) {
      out.error(ErrorCode.CONFIG_ERROR, 'Project is disabled', {
        project: projectPath,
        hint: 'Run "steroids projects enable" to enable it.',
      });
    } else {
      console.error('Error: Project is disabled');
      console.error('  Project: ' + projectPath);
      console.error('');
      console.error('Run "steroids projects enable" to enable it.');
    }
    process.exit(getExitCode(ErrorCode.CONFIG_ERROR));
  }

  // Check if a runner is already active for this project
  if (hasActiveRunnerForProject(projectPath)) {
    if (flags.json) {
      out.error(ErrorCode.RESOURCE_LOCKED, 'A runner is already active for this project', {
        project: projectPath,
        hint: 'Only one runner per project is allowed. Use "steroids runners list" to see active runners.',
      });
    } else {
      console.error('Error: A runner is already active for this project');
      console.error('  Project: ' + projectPath);
      console.error('');
      console.error('Only one runner per project is allowed.');
      console.error('Use "steroids runners list" to see active runners.');
    }
    process.exit(getExitCode(ErrorCode.RESOURCE_LOCKED));
  }

  const { db, close } = openDatabase();

  // Declare these outside the try block so they're available throughout the function
  let focusedSectionId: string | undefined;
  let focusedSectionName: string | undefined;

  try {
    // Resolve section if --section flag is provided
    if (values.section) {
      const sectionInput = values.section as string;

      try {
        // Try to resolve by ID (exact or prefix match)
        let section = getSection(db, sectionInput);

        // If not found by ID, try by name
        if (!section) {
          section = getSectionByName(db, sectionInput);
        }

        if (!section) {
          const sections = listSections(db);
          if (flags.json) {
            out.error(ErrorCode.SECTION_NOT_FOUND, `Section not found: ${sectionInput}`, {
              sectionId: sectionInput,
              availableSections: sections.map(s => ({ id: s.id.substring(0, 8), name: s.name })),
            });
          } else {
            console.error(`Error: Section not found: ${sectionInput}`);
            console.error('');
            console.error('Available sections:');
            if (sections.length === 0) {
              console.error('  (no sections defined)');
            } else {
              for (const s of sections) {
                console.error(`  ${s.id.substring(0, 8)}  ${s.name}`);
              }
            }
          }
          process.exit(getExitCode(ErrorCode.SECTION_NOT_FOUND));
        }

        // Check if section is skipped (Phase 0.6 feature)
        if (section.skipped === 1) {
          if (flags.json) {
            out.error(ErrorCode.CONFIG_ERROR, `Section "${section.name}" is currently skipped`, {
              sectionId: section.id,
              sectionName: section.name,
              hint: `Run 'steroids sections unskip "${section.name}"' to re-enable it.`,
            });
          } else {
            console.error(`Error: Section "${section.name}" is currently skipped`);
            console.error('');
            console.error(`Run 'steroids sections unskip "${section.name}"' to re-enable it.`);
          }
          process.exit(getExitCode(ErrorCode.CONFIG_ERROR));
        }

        focusedSectionId = section.id;
        focusedSectionName = section.name;
      } catch (error) {
        // Handle ambiguous prefix error from getSection()
        const errorMessage = error instanceof Error ? error.message : 'Failed to resolve section';
        if (flags.json) {
          out.error(ErrorCode.CONFIG_ERROR, errorMessage, { sectionInput });
        } else {
          console.error(`Error: ${errorMessage}`);
        }
        process.exit(getExitCode(ErrorCode.CONFIG_ERROR));
      }
    }

    // Show initial status (skip in JSON mode)
    if (!flags.json) {
      console.log('');
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║                    STEROIDS ORCHESTRATOR                      ║');
      if (focusedSectionName) {
        const sectionLabel = `Focused: ${focusedSectionName}`;
        const padding = Math.floor((60 - sectionLabel.length) / 2);
        console.log(`║${' '.repeat(padding)}${sectionLabel}${' '.repeat(60 - padding - sectionLabel.length)}║`);
      }
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log('');
    }

    const counts = getTaskCounts(db, focusedSectionId);
    if (!flags.json) {
      const statusLabel = focusedSectionName ? `Task Status (${focusedSectionName} only):` : 'Task Status:';
      console.log(statusLabel);
      console.log(`  Pending:     ${counts.pending}`);
      console.log(`  In Progress: ${counts.in_progress}`);
      console.log(`  Review:      ${counts.review}`);
      console.log(`  Completed:   ${counts.completed}`);
      console.log(`  Disputed:    ${counts.disputed}`);
      console.log(`  Failed:      ${counts.failed}`);
      console.log(`  ─────────────────`);
      console.log(`  Total:       ${counts.total}`);
      console.log('');
    }

    if (flags.dryRun) {
      const next = selectNextTask(db, focusedSectionId);
      if (flags.json) {
        out.success({
          dryRun: true,
          nextTask: next ? {
            id: next.task.id,
            title: next.task.title,
            action: next.action,
            status: next.task.status,
          } : null,
          counts,
        });
      } else {
        if (next) {
          console.log(`[DRY RUN] Would process: ${next.task.title}`);
          console.log(`  Action: ${next.action}`);
          console.log(`  Task ID: ${next.task.id}`);
        } else {
          console.log('[DRY RUN] No tasks to process');
        }
      }
      return;
    }

    let iteration = 0;
    const processedTasks: { taskId: string; title: string; action: string; status: string }[] = [];

    // Cache coordinator results so they can flow from coder phase to reviewer phase
    // Key: task ID, Value: coordinator result
    const coordinatorCache = new Map<string, CoordinatorResult>();

    // Coordinator only runs at specific rejection thresholds to avoid redundant LLM calls
    const COORDINATOR_THRESHOLDS = [2, 5, 9];

    // Main loop
    while (true) {
      iteration++;
      if (!flags.json) {
        console.log(`\n─── Iteration ${iteration} ───\n`);
      }

      // Select next task
      const selected = selectNextTask(db, focusedSectionId);

      if (!selected) {
        if (!flags.json) {
          console.log('');
          console.log('╔════════════════════════════════════════════════════════════╗');
          if (focusedSectionName) {
            const completeLabel = `SECTION "${focusedSectionName}" COMPLETE`;
            const padding = Math.floor((60 - completeLabel.length) / 2);
            console.log(`║${' '.repeat(padding)}${completeLabel}${' '.repeat(60 - padding - completeLabel.length)}║`);
          } else {
            console.log('║                      ALL TASKS COMPLETE                       ║');
          }
          console.log('╚════════════════════════════════════════════════════════════╝');
          console.log('');
        }
        break;
      }

      const { task, action } = selected;

      if (!flags.json) {
        console.log(`Task: ${task.title}`);
        console.log(`Action: ${action}`);
        console.log(`Status: ${task.status}`);
      }

      // Track processed task for JSON output
      processedTasks.push({
        taskId: task.id,
        title: task.title,
        action,
        status: task.status,
      });

      if (action === 'start') {
        // Starting a new task
        markTaskInProgress(db, task.id);
        await runCoderPhase(db, task, projectPath, 'start', flags.json, coordinatorCache, COORDINATOR_THRESHOLDS);
      } else if (action === 'resume') {
        // Resuming in-progress task
        await runCoderPhase(db, task, projectPath, 'resume', flags.json, coordinatorCache, COORDINATOR_THRESHOLDS);
      } else if (action === 'review') {
        // Task ready for review - pass coordinator guidance if available
        const cachedCoord = coordinatorCache.get(task.id);
        await runReviewerPhase(db, task, projectPath, flags.json, cachedCoord);
      }

      // Check if we should continue
      if (values.once) {
        if (!flags.json) {
          console.log('\n[--once] Stopping after one iteration');
        }
        break;
      }

      // Brief pause between iterations to avoid overwhelming the system
      await sleep(1000);
    }

    // Final status
    const finalCounts = getTaskCounts(db, focusedSectionId);

    if (flags.json) {
      out.success({
        iterations: iteration,
        processedTasks,
        initialCounts: counts,
        finalCounts,
        focusedSection: focusedSectionName || null,
      });
    } else {
      const finalLabel = focusedSectionName ? `\nFinal Status (${focusedSectionName}):` : '\nFinal Status:';
      console.log(finalLabel);
      console.log(`  Completed: ${finalCounts.completed}`);
      console.log(`  Failed:    ${finalCounts.failed}`);
      console.log(`  Disputed:  ${finalCounts.disputed}`);
    }
  } finally {
    close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
