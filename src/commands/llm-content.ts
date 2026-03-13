export const LLM_INSTRUCTIONS = `# STEROIDS LLM QUICK REFERENCE

## WHAT IS STEROIDS
Steroids=automated task orchestration system.
It manages tasks and invokes LLM agents (coders/reviewers) to execute them.
The system spawns separate LLM processes for coding and reviewing.
Deterministic daemon — never makes decisions, just follows the state machine.

## DATABASE ACCESS RULES (CRITICAL)
- Never touch '.steroids/steroids.db' directly — no raw SQL, no sqlite3.
- Use 'steroids llm' first to understand how to inspect or manipulate the system.
- Read/write operations must go through the steroids CLI only.

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
steroids tasks feedback "Advisory note"

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
steroids tasks update <id> --source <file>              # fix/change spec file
steroids tasks update <id> --title "New title"          # rename task
steroids tasks update <id> --section <id>               # move to different section
steroids tasks update <id> --file <path> --line <n>     # change file anchor
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
steroids runners wakeup                 # poll intake + restart stale runners

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
steroids web config                     # manage web dashboard configuration

## BUG INTAKE

External bug intake is config-driven and currently supports the GitHub Issues
connector. If \`intake.connectors.sentry.enabled=true\`, registry construction
fails fast because the Sentry runtime connector is not implemented here.

Key concepts:
- Connector: pulls normalized reports from an external source into Steroids
- Intake report: stored record keyed by source + external_id
- Approval gate: GitHub issue flow that approves or rejects intake reports
- Intake hooks: \`intake.received\`, \`intake.triaged\`, \`intake.pr_created\`
- Intake pipeline tasks: \`Triage intake report ...\`, \`Reproduce intake report ...\`,
  \`Fix intake report ...\`

Useful commands:
  steroids config show intake                 # inspect merged intake config
  steroids config schema intake               # JSON Schema for intake settings
  steroids config validate                    # validate connector config
  steroids hooks list --event intake.received # inspect intake automation hooks
  steroids runners wakeup                     # poll due connectors + sync gate issues
  steroids web                                # view intake reports in dashboard

Intake report statuses:
  open -> triaged -> in_progress -> resolved
                              \\-> ignored

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

## DATABASE MIGRATIONS (IMPORTANT)

Each project has its own SQLite database (.steroids/steroids.db). When Steroids is
updated with schema changes, older project databases need migration.

Migrations run AUTOMATICALLY on any command that opens the database. However, if a
project hasn't been used for a while and the schema has drifted significantly,
auto-migration may fail.

### Before Adding Tasks to an Existing Project
Always verify the database is healthy first:
  steroids health                         # checks DB, runs auto-migration

If you see "Database schema is out of date" errors:
  STEROIDS_AUTO_MIGRATE=1 steroids health # force migration + health check

### How Migrations Work
- Migration files live in migrations/ (SQL with UP/DOWN sections)
- Applied automatically when the database is opened
- A backup is created before each migration (.steroids/backups/)
- Safe to run multiple times (idempotent)
- If migration fails: fix the issue, then re-run any steroids command

### For LLM Agents
ALWAYS run \`steroids health\` before adding the first task to a project you haven't
touched recently. This ensures the schema is current and prevents cryptic SQL errors
during task creation or runner execution.

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
