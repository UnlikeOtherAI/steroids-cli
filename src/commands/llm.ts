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
import { createOutput } from '../cli/output.js';

const LLM_INSTRUCTIONS = `# STEROIDS LLM QUICK REFERENCE

## WHAT IS STEROIDS
Steroids=automated task orchestration system.
It manages tasks and invokes LLM agents (coders/reviewers) to execute them.
The system spawns separate LLM processes for coding and reviewing.
Deterministic daemon — never makes decisions, just follows the state machine.

## TASK SIZING (CRITICAL)

Tasks should be PR-sized chunks of work — not individual classes or functions,
but whole testable pieces of functionality. Think "what would make a good pull request?"

GOOD task sizing:
- "Implement user authentication endpoint with tests"
- "Add section dependency graph visualization"
- "Build CSV export for task reports"

BAD task sizing (too granular):
- "Create UserService class"
- "Add validateEmail helper function"
- "Write test for login method"

BAD task sizing (too large):
- "Build the entire frontend"
- "Implement all API endpoints"

Each task should produce a reviewable, testable unit of work that can be
merged independently. The reviewer needs enough context to verify correctness,
and the coder needs enough scope to make meaningful progress.

## TASK STATE MACHINE

### All 8 Statuses

| Marker | Status      | Terminal? | Runner picks it? | Description                                    |
|--------|-------------|-----------|-------------------|------------------------------------------------|
| [ ]    | pending     | No        | YES → coder       | Not started, waiting for coder                 |
| [-]    | in_progress | No        | YES → coder       | Coder is actively working                      |
| [o]    | review      | No        | YES → reviewer     | Coder finished, waiting for reviewer            |
| [x]    | completed   | YES       | No                | Reviewer approved, code pushed                 |
| [!]    | disputed    | YES       | No                | Coder/reviewer disagreement, code pushed       |
| [F]    | failed      | YES       | No                | Exceeded 15 rejections, needs human            |
| [S]    | skipped     | YES       | No                | Fully external — nothing to code               |
| [s]    | partial     | YES       | No                | Some coded, rest needs external setup           |

CRITICAL: skipped [S] and partial [s] are TERMINAL states. The runner will NEVER
pick them up for coding. Once a task is marked partial/skipped, it is DONE from the
runner's perspective. If coding is still needed, reset to pending manually.

### State Transitions

pending [ ] → in_progress [-] → review [o] → completed [x] (approved)
                                    ↓ rejected → back to in_progress [-]
                                    ↓ disputed → disputed [!] (code pushed, move on)
                              if 15 rejections → failed [F] (full stop)
Human can mark at any time → skipped [S] or partial [s] (terminal)

### Coordinator Intervention
At rejection thresholds [2, 5, 9], a coordinator LLM is invoked to analyze the
rejection pattern and provide guidance to both coder and reviewer. This breaks
coder/reviewer deadlocks without human intervention.

## TASK SELECTION ALGORITHM

Runner selects tasks in strict priority order:

  Priority 1: review [o]      — complete reviews before starting new work
  Priority 2: in_progress [-] — resume incomplete work
  Priority 3: pending [ ]     — start new work

Within each priority, ordered by: section position (lower=first), then created_at (older=first).

### Filters Applied Before Selection
1. Terminal statuses excluded: completed, disputed, failed, skipped, partial
2. Tasks in skipped sections excluded (unless runner focused on specific section)
3. Tasks in sections with UNMET DEPENDENCIES excluded (see below)
4. Tasks locked by another runner excluded

If no selectable task exists → runner goes idle.

## SECTION DEPENDENCIES

Sections can declare dependencies on other sections:
  steroids sections depends-on <A> <B>   → Section A depends on Section B

Effect: ALL tasks in section B must be completed before ANY task in section A
can be picked by the runner. "Completed" means status=completed (not just
skipped/partial — those count as incomplete for dependency purposes).

Dependency checks:
- Cycle detection prevents circular dependencies
- Runner evaluates dependencies at task selection time
- Use \`steroids sections graph\` to visualize the dependency tree

Commands:
  steroids sections depends-on <id> <dep-id>      # add dependency
  steroids sections no-depends-on <id> <dep-id>    # remove dependency
  steroids sections list --deps                     # show deps inline
  steroids sections graph                           # ASCII dependency tree
  steroids sections graph --mermaid                 # Mermaid syntax
  steroids sections graph --json                    # JSON output

## ARCHITECTURE
- Tasks stored in .steroids/steroids.db (SQLite, per project)
- Runner daemon executes the loop (one per project)
- Coder LLM: implements task, commits, submits for review
- Reviewer LLM: verifies implementation, approves or rejects
- Coordinator LLM: breaks deadlocks at rejection thresholds [2, 5, 9]
- Build verification: orchestrator re-runs build+tests after coder submits
- If build/tests fail → auto-reject back to in_progress (coder fixes)

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
steroids tasks audit <id>              # view task spec, history, rejection notes

### Add Tasks
steroids tasks add "Title" --section <id> --source <spec-file>
steroids tasks add "Title" --section <id> --source spec.md --file src/foo.ts --line 42
steroids tasks add "Advisory note" --feedback

Options:
  --section <id>     Section to add the task to (required unless --feedback)
  --source <file>    Specification markdown file (required unless --feedback)
  --file <path>      Anchor task to a specific file in the codebase
                     File must be committed in git (not dirty/untracked)
                     Auto-captures: commit SHA of last change + content hash
                     Coder/reviewer prompts will reference this exact location
  --line <number>    Line number in the anchored file (requires --file)
  --feedback         Add to skipped "Needs User Input" section for human review
                     Skips --section and --source requirements

BEST PRACTICE: When generating tasks from documentation or specs, commit the
documentation first, then fill in ALL values including optional ones:
  --source pointing to the committed spec file
  --file pointing to the relevant source file in the codebase
  --line pointing to the exact line where work applies
This gives the coder/reviewer maximum context and traceability.

### Manage Tasks
steroids tasks update <id> --status <s> --actor model --model <m>
  statuses: pending, in_progress, review, completed, skipped, partial
steroids tasks approve <id> --model <m> [--notes "msg"]     # mark completed
steroids tasks reject <id> --model <m> --notes "feedback"   # back to pending
steroids tasks skip <id> --notes "reason"                   # external setup, skip it
steroids tasks skip <id> --partial --notes "reason"         # coded some, rest external

### Sections
steroids sections list                  # list sections
steroids sections list --deps           # list with dependencies shown
steroids sections skip <id>             # exclude from runner
steroids sections unskip <id>           # include in runner
steroids sections priority <id> <val>   # set priority (0-100 or high/medium/low)
steroids sections depends-on <A> <B>    # A depends on B (B must complete first)
steroids sections no-depends-on <A> <B> # remove dependency
steroids sections graph                 # show dependency graph

### Runners (daemon that executes tasks)
steroids runners list                   # all runners (all projects)
steroids runners start --detach         # start background daemon
steroids runners start --section "X"    # focus on specific section
steroids runners stop --all             # stop all
steroids runners status                 # current state
steroids runners logs <pid>             # view daemon output

NOTE: Stopping a runner is temporary — the wakeup cron will respawn it.
To permanently stop a runner, DISABLE the project first:
  steroids projects disable             # then steroids runners stop --all

### Projects
steroids projects list                  # all registered projects

### Web Dashboard
steroids web                            # clone (first run) and launch dashboard
steroids web update                     # pull latest + reinstall deps
steroids web stop                       # stop running dashboard
steroids web status                     # check if dashboard is running

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

### Fix incorrectly marked partial/skipped tasks
steroids tasks update <id> --status pending --actor human:cli
# Use when: a task was marked partial/skipped but still needs coding

### Skip external setup task
steroids tasks skip <id> --notes "spec says SKIP, needs Cloud SQL setup"
# Use when: spec says SKIP/MANUAL, requires cloud console, account creation, etc.
# --partial: use if you coded some parts but rest needs human action

## PROJECT SETUP

SECTIONS = Features or Functional Areas
  - Each section represents ONE cohesive piece of functionality
  - Sections should be independent enough to be worked on in isolation
  - Sections have priorities and can depend on other sections

TASKS = PR-Sized Implementation Units
  - Each task produces a reviewable, testable unit of work
  - Tasks must have a specification file explaining exactly what to build
  - Tasks are ordered within sections — earlier tasks may set up later ones

SPECIFICATIONS = Markdown files describing what to build
  - Include: purpose, requirements, examples, acceptance criteria
  - Reference existing code patterns the implementation should follow
  - Create a specs/ directory with markdown files

INITIALIZING A PROJECT:
  1. steroids init -y                     # non-interactive, accept defaults
  2. Create specs/ with your specifications
  3. steroids sections add "Phase 1: Feature Name"
  4. steroids tasks add "Task title" --section <id> --source specs/spec.md
  5. steroids loop

## IMPORTANT NOTES
- Task spec is in source file (see tasks audit output)
- Max 15 rejections before task fails; coordinator intervenes at [2, 5, 9]
- Runner auto-restarts via cron (steroids runners cron install)
- Each project isolated: own database, own runner
- Section dependencies block entire sections, not individual tasks
- Build+test verification happens automatically after coder submits
- Always run build AND tests before submitting for review
- Never modify code outside the task scope
- If stuck, create a dispute rather than guessing
`;

const HELP = generateHelp({
  command: 'llm',
  description: 'Quick reference for LLM agents (alias: steroids about)',
  details: 'Complete reference guide for AI agents working with Steroids. Shows key commands, task flow, project setup, and current context.',
  usage: [
    'steroids llm',
    'steroids llm --context',
    'steroids llm --json',
    'steroids about            # alias for steroids llm',
  ],
  options: [
    { long: 'context', description: 'Include current project context (projects, runners, tasks)' },
    { short: 'j', long: 'json', description: 'Output structured JSON for LLM parsing' },
  ],
  examples: [
    { command: 'steroids llm', description: 'Show LLM quick reference' },
    { command: 'steroids llm --context', description: 'Show reference with current context' },
    { command: 'steroids about --json', description: 'Structured JSON output' },
  ],
  related: [
    { command: 'steroids tasks', description: 'Manage tasks' },
    { command: 'steroids sections', description: 'Manage sections' },
  ],
  showGlobalOptions: false,
  showEnvVars: false,
  showExitCodes: false,
});

export async function llmCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'llm', flags });

  // Check for help
  if (flags.help || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  // JSON output mode
  if (flags.json) {
    out.success({
      name: 'Steroids',
      description: 'AI-powered task orchestration with coder/reviewer loop',
      version: process.env.npm_package_version ?? '0.0.0',
      concept: {
        roles: [
          { name: 'coder', purpose: 'Implements tasks by writing code, running builds and tests' },
          { name: 'reviewer', purpose: 'Reviews completed work, approves or rejects with feedback' },
        ],
        workflow: [
          'Human creates tasks with specifications',
          'Runner picks up pending tasks',
          'Coder implements following specification',
          'Reviewer evaluates implementation',
          'Approved: task complete, next starts',
          'Rejected: returns to coder with notes',
          'After 15 rejections: dispute raised',
        ],
        lifecycle: ['pending', 'in_progress', 'review', 'completed'],
      },
      taskSizing: 'PR-sized chunks — whole testable pieces of functionality, not individual classes',
      projectSetup: {
        sections: 'Features or functional areas — each represents ONE cohesive piece of functionality',
        tasks: 'PR-sized implementation units — reviewable, testable units of work',
        specifications: 'Markdown files in specs/ with purpose, requirements, examples, acceptance criteria',
      },
      commands: [
        { command: 'steroids tasks list', description: 'List pending tasks' },
        { command: 'steroids tasks list --status all', description: 'Show all tasks' },
        { command: 'steroids sections list', description: 'Show task sections' },
        { command: 'steroids tasks approve <id>', description: 'Approve as reviewer' },
        { command: 'steroids tasks reject <id> --notes "..."', description: 'Reject with feedback' },
      ],
      rules: [
        'Always run build AND tests before submitting for review',
        'Read the task specification thoroughly before implementing',
        'Make small, focused commits',
        'Never modify code outside the task scope',
        'If stuck, create a dispute rather than guessing',
      ],
    });
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
