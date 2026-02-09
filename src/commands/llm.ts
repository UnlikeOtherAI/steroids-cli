/**
 * steroids llm - Compact instructions for LLM agents
 * Call this when context is lost to quickly understand the system
 */

import type { GlobalFlags } from '../cli/flags.js';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getRegisteredProjects } from '../runners/projects.js';
import { listRunners } from '../runners/daemon.js';
import { openDatabase } from '../database/connection.js';
import { listTasks } from '../database/queries.js';
import { generateHelp } from '../cli/help.js';

const LLM_INSTRUCTIONS = `# STEROIDS LLM QUICK REFERENCE

## WHAT IS STEROIDS
Steroids=automated task orchestration system.
It manages tasks and invokes LLM agents (coders/reviewers) to execute them.
The system spawns separate LLM processes for coding and reviewing.

## TASK FLOW
pending → in_progress (coder works) → review (reviewer checks) → completed OR rejected→pending
Runner daemon picks tasks and invokes appropriate LLM agents automatically.

## ARCHITECTURE
- Tasks stored in .steroids/steroids.db (per project)
- Runner daemon executes the loop (one per project)
- Coder LLM: implements task, commits, submits for review
- Reviewer LLM: verifies implementation, approves or rejects
- You (reading this): likely helping user manage/debug the system

## MULTI-PROJECT
- Multiple projects can have runners simultaneously
- Each runner bound to ONE project only
- Global registry at ~/.steroids/steroids.db tracks all projects
- NEVER modify files outside current project

## KEY COMMANDS

### View Tasks
steroids tasks stats                    # task counts by status
steroids tasks                          # pending tasks (current project)
steroids tasks --status active          # in_progress+review (current project)
steroids tasks --status active --global # active across ALL projects
steroids tasks --status all             # all tasks
steroids tasks audit <id>               # view task spec, history, rejection notes

### Add Tasks
steroids tasks add "Title" --section <id> --source <spec-file>
steroids tasks add "Title" --section <id> --source spec.md --file src/foo.ts --line 42
  --file must be committed in git (auto-captures commit SHA + content hash)
  --line requires --file
steroids tasks add "Advisory note" --feedback
  --feedback: creates task in skipped "Needs User Input" section (no --section/--source needed)

### Manage Tasks
steroids tasks update <id> --status <s> --actor model --model <m>
  statuses: pending, in_progress, review, completed, skipped, partial
steroids tasks approve <id> --model <m> [--notes "msg"]     # mark completed
steroids tasks reject <id> --model <m> --notes "feedback"   # back to pending
steroids tasks skip <id> --notes "reason"                   # external setup, skip it
steroids tasks skip <id> --partial --notes "reason"         # coded some, rest external

### Sections
steroids sections list                  # list sections
steroids sections skip <id>             # exclude from runner
steroids sections unskip <id>           # include in runner

### Runners (daemon that executes tasks)
steroids runners list                   # all runners (all projects)
steroids runners start --detach         # start background daemon
steroids runners start --section "X"    # focus on specific section
steroids runners stop --all             # stop all
steroids runners status                 # current state
steroids runners logs <pid>             # view daemon output

### Projects
steroids projects list                  # all registered projects

## COMMON OPERATIONS

### Start automation
steroids runners start --detach         # daemon picks tasks and invokes coders/reviewers

### Check what's happening
steroids tasks --status active --global # see all active work
steroids runners list                   # see all running daemons

### Unblock stuck task in review
steroids tasks approve <id> --model human   # approve manually
steroids tasks reject <id> --model human --notes "reason"  # reject manually

### Restart failed task
steroids tasks update <id> --status pending --reset-rejections  # reset to pending with fresh count

### Skip external setup task
steroids tasks skip <id> --notes "spec says SKIP, needs Cloud SQL setup"
# Use when: spec says SKIP/MANUAL, requires cloud console, account creation, etc.
# --partial: use if you coded some parts but rest needs human action

## TASK STATES
- pending: waiting to be picked up
- in_progress: coder is working on it
- review: coder submitted, waiting for reviewer
- completed: approved by reviewer
- skipped: fully external (Cloud SQL, manual setup) - human must do
- partial: some coded, rest external - human must complete
- failed: exceeded 15 rejections, needs human intervention
- disputed: coder/reviewer disagreement, needs human resolution

## IMPORTANT NOTES
- Task spec is in source file (see tasks audit output)
- Max 15 rejections before task fails
- Runner auto-restarts via cron (steroids runners cron install)
- Each project isolated: own database, own runner
`;

const HELP = generateHelp({
  command: 'llm',
  description: 'Compact instructions for LLM agents',
  details: 'Quick reference guide for AI agents working with Steroids. Shows key commands, task flow, and current context.',
  usage: [
    'steroids llm',
    'steroids llm --context',
  ],
  options: [
    { long: 'context', description: 'Include current project context (projects, runners, tasks)' },
  ],
  examples: [
    { command: 'steroids llm', description: 'Show LLM quick reference' },
    { command: 'steroids llm --context', description: 'Show reference with current context' },
  ],
  related: [
    { command: 'steroids about', description: 'Explain what Steroids is' },
    { command: 'steroids tasks', description: 'Manage tasks' },
  ],
  showGlobalOptions: false,
  showEnvVars: false,
  showExitCodes: false,
});

export async function llmCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check for help
  if (flags.help || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  const includeContext = args.includes('--context');

  // Always print instructions
  console.log(LLM_INSTRUCTIONS);

  // Optionally include current context
  if (includeContext) {
    console.log('## CURRENT CONTEXT\n');

    // Current project
    console.log(`Project: ${process.cwd()}`);

    // Registered projects
    try {
      const projects = getRegisteredProjects(false);
      console.log(`Registered projects: ${projects.length}`);
      if (projects.length > 1) {
        console.log('WARNING: Multi-project environment. Only work on YOUR project.');
      }
    } catch {
      console.log('Registered projects: unknown');
    }

    // Active runners
    try {
      const runners = listRunners();
      const activeRunners = runners.filter(r => r.status === 'running');
      console.log(`Active runners: ${activeRunners.length}`);
      for (const r of activeRunners) {
        const proj = r.project_path ? r.project_path.split('/').pop() : 'unknown';
        console.log(`  - ${r.id.slice(0,8)} on ${proj} (PID ${r.pid})`);
      }
    } catch {
      console.log('Active runners: unknown');
    }

    // Global active tasks
    console.log('');
    console.log('Active tasks (all projects):');
    try {
      const projects = getRegisteredProjects(false);
      let totalActive = 0;
      for (const project of projects) {
        const dbPath = `${project.path}/.steroids/steroids.db`;
        if (!existsSync(dbPath)) continue;

        try {
          const { db, close } = openDatabase(project.path);
          try {
            const inProgress = listTasks(db, { status: 'in_progress' });
            const review = listTasks(db, { status: 'review' });
            const active = [...inProgress, ...review];
            const projName = project.name || basename(project.path);

            for (const task of active) {
              totalActive++;
              const status = task.status === 'in_progress' ? 'CODING' : 'REVIEW';
              console.log(`  [${status}] ${projName}: ${task.title.slice(0,50)} (${task.id.slice(0,8)})`);
            }
          } finally {
            close();
          }
        } catch {
          // Skip inaccessible projects
        }
      }
      if (totalActive === 0) {
        console.log('  (none)');
      }
    } catch {
      console.log('  (unknown)');
    }

    // Skipped tasks requiring manual action
    console.log('');
    console.log('Skipped tasks (need manual action):');
    try {
      const projects = getRegisteredProjects(false);
      let totalSkipped = 0;
      for (const project of projects) {
        const dbPath = `${project.path}/.steroids/steroids.db`;
        if (!existsSync(dbPath)) continue;

        try {
          const { db, close } = openDatabase(project.path);
          try {
            const skipped = listTasks(db, { status: 'skipped' });
            const partial = listTasks(db, { status: 'partial' });
            const allSkipped = [...skipped, ...partial];
            const projName = project.name || basename(project.path);

            for (const task of allSkipped) {
              totalSkipped++;
              const marker = task.status === 'skipped' ? '[S]' : '[s]';
              console.log(`  ${marker} ${projName}: ${task.title.slice(0,50)} (${task.id.slice(0,8)})`);
            }
          } finally {
            close();
          }
        } catch {
          // Skip inaccessible projects
        }
      }
      if (totalSkipped === 0) {
        console.log('  (none - all tasks are automated)');
      } else {
        console.log('');
        console.log('  [S] = Fully external (human must do entire task)');
        console.log('  [s] = Partial (some coded, rest needs human)');
        console.log('  Use: steroids tasks audit <id> to see what action is needed');
      }
    } catch {
      console.log('  (unknown)');
    }

    console.log('');
  }
}
