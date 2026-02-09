# CLI Command Reference

> Complete reference for all Steroids CLI commands with non-interactive options.
> For architecture overview, see [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## `steroids about`

**Start here if you're an LLM discovering this tool.**

Explains what Steroids is and how it works in detail suitable for AI agents.

```
Usage: steroids about [options]

Options:
  -j, --json    Output as structured JSON for LLM parsing
  -h, --help    Show help

Examples:
  steroids about              # Human-readable explanation
  steroids about --json       # Structured JSON for parsing
```

The about command covers:
- What Steroids is (AI task orchestration)
- The coder/reviewer loop concept
- Task lifecycle (pending → in_progress → review → completed)
- Key commands for working with tasks
- Important rules for implementation

---

## Design Philosophy

**Every command supports full non-interactive operation via explicit flags.**

- **Current directory = project context** - run `steroids` from your project root
- **File-based storage** - all changes write to TODO.md, no database
- **Hooks support** - trigger scripts/webhooks on task completion

---

## Global Options

These options work with all commands:

```
-j, --json            Output as JSON (for scripting/LLM parsing)
-q, --quiet           Minimal output, errors only
-v, --verbose         Detailed output for debugging
-h, --help            Display help for command
--version             Display version number
--no-color            Disable colored output
--config <path>       Use specific config file
--dry-run             Preview changes without executing
--timeout <duration>  Command timeout (e.g., 30s, 5m)
--no-hooks            Skip hook execution for this command
```

---

## `steroids init`

Initialize Steroids in the current directory.

```
Usage: steroids init [options]

Options:
  -y, --yes                 Accept all defaults, skip confirmations
  --skip-git                Skip Git setup entirely
  --no-remote               Initialize without creating remote repository
  --git-init                Initialize Git repo if not present
  --provider <provider>     Git provider: github | gitlab
  --repo-name <name>        Repository name for remote creation
  --visibility <vis>        Repository visibility: public | private (default: private)
  --description <desc>      Repository description
  --branch <name>           Initial branch name (default: main)
  --skip-config             Don't create .steroids/ config directory

Creates:
  .steroids/config.yaml    Project-level configuration
  .steroids/hooks.yaml     Hook definitions (empty template)

Examples:
  steroids init                                      # Interactive
  steroids init --yes                                # Accept all defaults
  steroids init --git-init --no-remote               # Local Git only
  steroids init --provider github --repo-name foo    # Full non-interactive
  steroids init --dry-run                            # Preview what would happen

Exit Codes:
  0  Success
  1  Git not installed or setup failed
  2  Invalid arguments
  3  Authentication required but not available
```

---

## `steroids scan`

Scan directory for multiple projects. Use from a parent directory to discover projects.

```
Usage: steroids scan [path] [options]

Arguments:
  path                      Directory to scan (default: current directory)

Options:
  -d, --depth <n>           Max directory depth (default: 3, max: 10)
  --include <patterns>      Glob patterns to include (comma-separated)
  --exclude <patterns>      Glob patterns to exclude (comma-separated)
  --type <types>            Filter by type: node,python,rust,go,ruby (comma-separated)
  --min-health <score>      Only show projects with health >= score (0-100)
  --max-health <score>      Only show projects with health <= score
  --has-tasks               Only projects with pending tasks
  --sort <field>            Sort by: name | health | updated | tasks (default: name)
  --sort-order <order>      Sort order: asc | desc (default: asc)
  --limit <n>               Limit results (default: no limit)
  --offset <n>              Skip first n results (for pagination)

Project Detection:
  Projects are identified by presence of:
  - node: package.json
  - python: pyproject.toml, setup.py, or requirements.txt
  - rust: Cargo.toml
  - go: go.mod
  - ruby: Gemfile

Default Behavior:
  With no flags, returns all detected projects sorted by name ascending.

Examples:
  steroids scan                                      # Scan current directory
  steroids scan ~/Projects                           # Scan specific path
  steroids scan --depth 5 --type node,python         # Deep scan, specific types
  steroids scan --min-health 50 --sort health        # Filter and sort
  steroids scan --has-tasks --sort-order desc        # Projects with tasks, most first
  steroids scan --json | jq '.data.projects[].name'  # Pipe to jq
```

---

## `steroids tasks`

List and manage tasks in the current project.

Tasks are identified by their title text (matched exactly or partially).

```
Usage: steroids tasks [options]
       steroids tasks update <title|id> [options]
       steroids tasks add <title> [options]
       steroids tasks approve <id> [options]
       steroids tasks reject <id> [options]
       steroids tasks skip <id> [options]
       steroids tasks audit <id>

Arguments:
  title                     Task title (exact or partial match)
  id                        Task GUID

List Options:
  -s, --status <status>     Filter: pending | in_progress | completed | review |
                                    skipped | partial | active | all
                            'active' = in_progress + review (tasks being worked on)
                            'skipped' = external setup tasks needing human action
                            'partial' = coded some, rest needs human action
                            Default: pending
  -g, --global              List tasks across ALL registered projects (not just current)
  --section <id>            Filter by section ID (local project only)
  --search <text>           Full-text search in task titles
  --file <path>             Only tasks from specific file (default: TODO.md)
  --sort <field>            Sort by: line | status | section (default: line)
  --limit <n>               Limit results
  --offset <n>              Skip first n results

Update Options:
  --status <status>         New status: pending | in_progress | completed | review
  --reset-rejections        Reset rejection count to 0 (keeps audit history)
  --no-hooks                Don't trigger completion hooks
  --actor <actor>           Actor making the change (for audit trail)
  --model <model>           Model identifier when actor is LLM

Add Options:
  --section <id>            Section ID (REQUIRED)
  --source <file>           Specification file (REQUIRED)
  --status <status>         Initial status (default: pending)
  --after <title>           Insert after this task

Approve/Reject Options:
  --model <model>           Model performing the review (required)
  --notes <text>            Review notes/comments
  --source-check            Verify against sourceFile before approving

Skip Options:
  --notes <text>            Reason for skipping (what human action is needed)
  --model <model>           Model identifying the skip (for LLM actors)
  -p, --partial             Mark as partial (coded some, rest external)

Task Status Markers:
  - [ ]  pending
  - [-]  in_progress
  - [x]  completed
  - [o]  review (ready for review)
  - [S]  skipped (fully external - nothing to code)
  - [s]  partial (coded what we could, rest is external)

Default Behavior:
  'steroids tasks' with no flags shows all PENDING tasks from TODO.md.

Examples:
  steroids tasks                                     # All pending tasks (local project)
  steroids tasks --status all                        # All tasks regardless of status
  steroids tasks --status active                     # In-progress + review tasks (local)
  steroids tasks --status active --global            # Active tasks across ALL projects
  steroids tasks --status pending --global           # Pending tasks across ALL projects
  steroids tasks --section abc123                    # Tasks in section abc123
  steroids tasks --search "login"                    # Find tasks containing "login"

  steroids tasks update "Fix login bug" --status completed
  steroids tasks update "Fix login" --status in_progress  # Partial match works

  steroids tasks add "New feature" --section abc123 --source specs/frontend.md
  steroids tasks add "Bug fix" --section def456 --source specs/bugfix.md

  # Mark task complete and trigger hooks
  steroids tasks update "Deploy to prod" --status completed

  # Mark complete without triggering hooks
  steroids tasks update "Deploy to prod" --status completed --no-hooks

  # Submit for review (with model actor)
  steroids tasks update "Fix login" --status review --actor model --model claude-sonnet-4

  # Approve a task in review
  steroids tasks approve a1b2c3d4-... --model claude-opus-4 --notes "LGTM"

  # Reject a task back to pending
  steroids tasks reject a1b2c3d4-... --model claude-opus-4 --notes "Missing tests"

  # Skip external setup task (spec says SKIP/MANUAL)
  steroids tasks skip a1b2c3d4-... --notes "Cloud SQL - spec says SKIP, needs manual setup"

  # Partial skip (coded deployment YAML, but cluster needs manual creation)
  steroids tasks skip a1b2c3d4-... --partial --notes "Created deployment.yaml. GKE cluster needs manual setup."

  # View audit trail
  steroids tasks audit a1b2c3d4-...
```

---

## `steroids health`

Check project health in the current directory.

```
Usage: steroids health [options]

Options:
  --check <checks>          Run specific checks: git,deps,tests,lint,todos (comma-separated)
  --threshold <score>       Exit code 1 if health below threshold (0-100)
  --fix                     Attempt to fix issues automatically
  --watch                   Continuously monitor (refresh every 30s)
  --watch-interval <dur>    Watch interval (e.g., 10s, 1m)

Health Checks:
  git      Clean working tree, no uncommitted changes
  deps     Dependencies installed and up to date
  tests    Tests passing (runs test command from package.json)
  lint     No linting errors
  todos    Task completion percentage

Default Behavior:
  Runs all checks and returns aggregate health score (0-100).

Examples:
  steroids health                                    # Full health check
  steroids health --verbose                          # Detailed breakdown
  steroids health --threshold 70                     # CI check, fail if < 70
  steroids health --check git,deps                   # Only specific checks
  steroids health --fix                              # Auto-fix issues
  steroids health --watch --watch-interval 10s       # Monitor continuously
  steroids health --json | jq '.data.score'          # Get score programmatically
```

---

## `steroids completion`

Generate shell completion scripts.

```
Usage: steroids completion <shell> [options]
       steroids completion install

Arguments:
  shell                     Target shell: bash | zsh | fish | powershell

Options:
  --output <path>           Write to file instead of stdout

Subcommands:
  steroids completion install    Auto-detect shell and install completions

Examples:
  # Auto-install for your shell
  steroids completion install

  # Manual installation
  steroids completion bash >> ~/.bashrc
  steroids completion zsh >> ~/.zshrc
  steroids completion fish > ~/.config/fish/completions/steroids.fish

  # Output to file
  steroids completion bash --output /etc/bash_completion.d/steroids

After Installation:
  Restart your shell or run:
  - bash: source ~/.bashrc
  - zsh:  source ~/.zshrc
  - fish: (automatic)
```

---

## `steroids config`

Manage Steroids configuration.

```
Usage: steroids config <subcommand> [options]

Subcommands:
  steroids config init         Create default configuration
  steroids config browse       Interactive config browser (TUI)
  steroids config show         Display current configuration
  steroids config set <k> <v>  Set a configuration value
  steroids config get <key>    Get a configuration value
  steroids config path         Show config file locations
  steroids config validate     Validate configuration syntax
  steroids config edit         Open config in $EDITOR

Config Locations (in priority order):
  1. ./.steroids/config.yaml   (project-level)
  2. ~/.steroids/config.yaml   (user-level)

Init Options:
  --force                   Overwrite existing config
  --global                  Create in ~/.steroids/ instead of project
  --template <name>         Use template: minimal | standard | full

Browse Options:
  --global                  Browse global config (~/.steroids/config.yaml)
  --local                   Browse local config (.steroids/config.yaml)
                            (default: local if exists, else global)

Examples:
  steroids config init                               # Create project config
  steroids config init --global                      # Create user config
  steroids config browse                             # Interactive TUI browser
  steroids config browse --global                    # Browse global config
  steroids config show                               # Show merged config
  steroids config show --json                        # As JSON
  steroids config set output.format json             # Set value
  steroids config get output.format                  # Get value
  steroids config validate                           # Check syntax
  steroids config edit                               # Open in editor
```

### Config Browse TUI

The `browse` command opens an interactive terminal UI:

```
┌─ Steroids Config (.steroids/config.yaml) ─────────────────┐
│                                                              │
│  ▸ output          Output formatting options                 │
│    health          Health check settings                     │
│    tasks           Task management settings                  │
│    backup          Backup configuration                      │
│                                                              │
│  [↑↓] Navigate  [Enter] Drill down  [q] Back/Quit           │
└──────────────────────────────────────────────────────────────┘
```

Drill into a category:

```
┌─ output ────────────────────────────────────────────────────┐
│                                                              │
│  format         table                                        │
│                 Output format for CLI commands               │
│                 Options: table, json                         │
│                                                              │
│  colors         true                                         │
│                 Enable colored output                        │
│                 Options: true, false                         │
│                                                              │
│  verbose        false                                        │
│                 Show detailed output                         │
│                 Options: true, false                         │
│                                                              │
│  [↑↓] Navigate  [Enter] Edit  [q] Back                      │
└──────────────────────────────────────────────────────────────┘
```

---

## `steroids sections`

Manage task sections (groups of related tasks).

```
Usage: steroids sections [options]
       steroids sections add <name> [options]
       steroids sections update <id> [options]
       steroids sections remove <id> [options]
       steroids sections reorder [options]
       steroids sections skip <id|name> [options]
       steroids sections unskip <id|name> [options]
       steroids sections priority <id> <priority>
       steroids sections depends-on <id> <depends-on-id>
       steroids sections no-depends-on <id> <dep-id>
       steroids sections graph [options]

Arguments:
  name                      Section name
  id                        Section GUID (or partial match)
  priority                  Priority value (0-100) or high/medium/low
  depends-on-id             Section ID that must be completed first
  dep-id                    Dependency to remove

List Options:
  --include-tasks           Include task count for each section
  --all                     Include skipped sections (hidden by default)
  --deps                    Show dependencies inline

Add Options:
  --position <n>            Position in ordering (default: append)
  --description <text>      Section description

Update Options:
  --name <name>             New section name
  --position <n>            New position

Remove Options:
  --force                   Remove even if section has tasks
  --reassign <id>           Move tasks to another section

Reorder Options:
  --id <id>                 Section ID to move
  --position <n>            New position

Skip/Unskip Options:
  (none)                    Section is identified by ID or name

Priority Options:
  high                      Sets priority to 10
  medium                    Sets priority to 50 (default)
  low                       Sets priority to 90
  0-100                     Custom priority value (0 = highest, 100 = lowest)

Graph Options:
  --mermaid                 Output Mermaid flowchart syntax
  --output <format>         Generate image file (png or svg)
  -o, --open                Auto-open generated file
  --tasks                   Include tasks within sections
  --status <status>         Filter tasks by status (pending, active, etc.)
  --section <id>            Show only specified section

Examples:
  steroids sections                                  # List active sections
  steroids sections --all                            # Include skipped sections
  steroids sections --include-tasks                  # Show task counts
  steroids sections list --deps                      # Show dependencies inline
  steroids sections add "Phase 1 - Backend"          # Add new section
  steroids sections add "Phase 2" --position 2       # Insert at position
  steroids sections update abc123 --name "Phase 1"   # Rename section
  steroids sections remove abc123                    # Remove empty section
  steroids sections remove abc123 --force            # Remove with tasks
  steroids sections reorder --id abc123 --position 1 # Move to first
  steroids sections skip "Phase 3"                   # Skip section (defer work)
  steroids sections skip abc123                      # Skip by ID
  steroids sections unskip "Phase 3"                 # Re-enable section

  # Priority management
  steroids sections priority abc123 high             # Set to high priority (10)
  steroids sections priority abc123 25               # Set to custom priority (25)
  steroids sections priority abc123 low              # Set to low priority (90)

  # Dependency management
  steroids sections depends-on abc123 def456         # Phase abc123 depends on def456
  steroids sections no-depends-on abc123 def456      # Remove dependency

  # Dependency graph visualization
  steroids sections graph                            # ASCII dependency tree
  steroids sections graph --mermaid                  # Mermaid flowchart syntax
  steroids sections graph --output png               # Generate PNG file
  steroids sections graph --output svg -o            # Generate SVG and open it
  steroids sections graph --tasks                    # Include tasks in graph
  steroids sections graph --tasks --status active    # Show only active tasks
  steroids sections graph --section abc123 --tasks   # Graph one section with tasks
```

### Section Skip Behavior

When a section is marked as **skipped**:

1. **Task selection ignores it** - The orchestrator loop will not pull tasks from skipped sections
2. **Hidden by default** - `steroids sections list` hides skipped sections (use `--all` to show)
3. **Tasks remain intact** - Tasks are not deleted or modified, just deferred
4. **Visual indicator** - Skipped sections show `[SKIPPED]` marker in listings

Use cases:
- Future development phases not ready to start
- Temporarily parking work on a feature
- Focusing the loop on specific priorities

### Section Priorities

Sections can have priorities to control the order in which tasks are selected:

- **Priority range:** 0-100 (0 = highest priority, 100 = lowest priority)
- **Default priority:** 50 (medium)
- **Presets:** high (10), medium (50), low (90)

**Priority affects task selection:**
1. Sections are ordered by: unmet dependencies (blocked last), then priority, then position
2. Tasks from higher priority sections are selected first
3. Skipped sections are never selected regardless of priority

**Examples:**
```bash
steroids sections priority abc123 high    # Critical section (priority 10)
steroids sections priority def456 25      # Custom high priority
steroids sections priority ghi789 low     # Defer work (priority 90)
```

### Section Dependencies

Sections can depend on other sections, creating a dependency graph:

- **Dependency rules:** A section cannot start until all its dependencies are completed
- **Circular detection:** The system prevents circular dependencies
- **Blocked indicator:** Sections with unmet dependencies show `[BLOCKED]` marker

**How dependencies work:**
1. `sections depends-on A B` means "A depends on B" (B must complete first)
2. Task selection skips sections where any dependency has incomplete tasks
3. The orchestrator respects the dependency order automatically

**Examples:**
```bash
# Phase 2 depends on Phase 1
steroids sections depends-on phase2-id phase1-id

# Remove the dependency
steroids sections no-depends-on phase2-id phase1-id

# View the dependency tree
steroids sections graph
```

### Dependency Graph Visualization

The `graph` subcommand visualizes section dependencies and tasks:

**Output formats:**
1. **ASCII tree (default):** Text-based tree view for terminal
2. **Mermaid syntax:** For embedding in markdown/docs
3. **PNG/SVG images:** Rendered diagrams (requires Mermaid CLI)

**Graph features:**
- Shows section hierarchy based on dependencies
- Displays priorities for each section
- Marks blocked sections with `[BLOCKED]` indicator
- Can include tasks with status indicators
- Filter by task status or single section

**ASCII tree example:**
```
SECTION DEPENDENCY GRAPH
─────────────────────────────────────────────────────────────────
└─> Phase 0.4: Global Runner Registry (priority: 10) [IN PROGRESS]
    ├─> Phase 0.7: Section Focus (priority: 20)
    │   └─> Phase 0.8: Priorities & Dependencies (priority: 30)
    └─> Phase 2: Configuration (priority: 50) [BLOCKED]
```

**Mermaid output:**
```bash
steroids sections graph --mermaid
# Outputs Mermaid flowchart syntax to stdout
# Can be embedded in markdown or docs
```

**Image generation:**
```bash
# Generate PNG file
steroids sections graph --output png
# Output: /tmp/steroids-sections-graph-1707412345.png

# Generate and auto-open SVG
steroids sections graph --output svg -o
# Automatically opens the generated file
```

**Including tasks:**
```bash
# Show sections with all their tasks
steroids sections graph --tasks

# Show only active tasks (in_progress + review)
steroids sections graph --tasks --status active

# Focus on one section with its tasks
steroids sections graph --section abc123 --tasks
```

**Task status indicators in graphs:**
- `[ ]` pending - gray
- `[-]` in_progress - blue
- `[o]` review - yellow
- `[x]` completed - green
- `[!]` disputed - orange
- `[F]` failed - red
- Rejection counts shown: `(3)` means 3 rejections

**Mermaid CLI installation:**

Image generation requires the Mermaid CLI tool. If not installed:
```bash
# Manual installation
npm install -g @mermaid-js/mermaid-cli

# Or let steroids prompt you interactively
steroids sections graph --output png
# Will prompt: "Install now? [y/N]"
```

The Mermaid CLI (`mmdc`) converts Mermaid syntax to PNG/SVG images with proper styling and colors.

---

## `steroids projects`

Manage the global project registry for multi-project monitoring.

```
Usage: steroids projects <subcommand> [options]

Subcommands:
  list                List all registered projects
  add <path>          Register a project
  remove <path>       Unregister a project
  enable <path>       Enable a project (include in wakeup)
  disable <path>      Disable a project (skip in wakeup)
  prune               Remove projects that no longer exist

Options:
  -a, --all           Include disabled projects (list only)
  -h, --help          Show help

Examples:
  steroids projects list                         # List enabled projects
  steroids projects list --all                   # Include disabled projects
  steroids projects list --json                  # JSON output
  steroids projects add ~/code/my-app            # Register a project
  steroids projects remove ~/old-project         # Unregister a project
  steroids projects disable ~/code/on-hold       # Disable project (skip wakeup)
  steroids projects enable ~/code/on-hold        # Re-enable project
  steroids projects prune                        # Remove stale projects
```

### Global Project Registry

The global project registry is stored in `~/.steroids/steroids.db` and tracks all steroids projects across your system. This enables:

- **Multi-project monitoring** - The wakeup system can restart runners for any registered project
- **Centralized management** - View and control all projects from one place
- **Automatic registration** - Projects are registered automatically when you run `steroids init`

### Project States

- **Enabled** - Project is monitored by the wakeup system
- **Disabled** - Project remains registered but is skipped during wakeup

### Prune Behavior

The `prune` command removes projects that:
- No longer exist on disk
- Are missing the `.steroids` directory
- Are missing the `.steroids/steroids.db` file

This keeps the registry clean as projects are moved or deleted.

### Multi-Project Warnings

When multiple projects are registered, listing commands display warnings to help LLMs understand project boundaries:

```
⚠️  MULTI-PROJECT ENVIRONMENT
   Your current project: /path/to/current/project
   DO NOT modify files in other projects.
   Each runner/coder works ONLY on its own project.
```

This warning appears in:
- `steroids projects list` (when 2+ projects)
- `steroids runners list` (when runners from 2+ projects)
- `steroids tasks --global` (when showing tasks from multiple projects)

---

## `steroids loop`

Run the orchestrator loop (coder/reviewer cycle).

```
Usage: steroids loop [options]

Options:
  --project <path>      Run loop for specific project directory
  --section <id|name>   Focus on a specific section only
  --max-iterations <n>  Maximum iterations before stopping
  --once                Run one iteration only (don't loop)
  --dry-run             Preview what would run without executing
  -v, --verbose         Detailed output
  -j, --json            Output as JSON
  -h, --help            Show help

Examples:
  steroids loop                              # Run until all tasks complete
  steroids loop --project ~/code/myapp       # Run loop for specific project
  steroids loop --section "Phase 2"          # Focus on specific section
  steroids loop --section fd1f               # Focus by section ID prefix
  steroids loop --max-iterations 5           # Run at most 5 iterations
  steroids loop --once                       # Run one iteration only
  steroids loop --dry-run                    # Preview without executing
```

### Project Path Behavior

When `--project <path>` is specified:
1. Changes to the specified project directory before starting
2. Validates that the path exists and contains `.steroids/steroids.db`
3. Runs the loop in that project's context
4. Useful for cron jobs and multi-project orchestration

**Note:** Without `--project`, the loop runs in the current working directory.

### Section Focus Behavior

When `--section` is specified:
- Only tasks from that section are selected
- Task counts reflect only that section
- Loop exits when that section is complete
- Skipped sections cannot be focused (error)

### Batch Mode

When `sections.batchMode: true` is set in config:
- The loop selects ALL pending tasks from a section at once
- Coder receives a combined prompt with all task specs
- Coder commits after EACH task individually (maintains good git history)
- Coder runs `steroids tasks update <id> --status review` after each commit
- Reviewer still reviews each task individually (quality control maintained)

**Configuration:**
```yaml
# .steroids/config.yaml
sections:
  batchMode: true       # Enable batch processing
  maxBatchSize: 10      # Max tasks per batch (prevents context overflow)
```

**When to use batch mode:**
- Tasks in a section are related and benefit from shared context
- Reduces AI invocation overhead for many small tasks
- Section tasks have natural ordering that should be preserved

**When NOT to use batch mode:**
- Tasks are independent and benefit from fresh context each time
- Section has very large tasks that would overflow context window
- You need maximum isolation between task implementations

---

## `steroids runners`

Manage runner daemons for background task execution.

```
Usage: steroids runners <subcommand> [options]

Subcommands:
  start                 Start a runner daemon
  stop                  Stop runner(s)
  status                Show runner status
  list                  List all runners
  wakeup                Check and restart stale runners
  cron                  Manage cron job for auto-wakeup

Start Options:
  --detach              Run in background (daemonize)
  --project <path>      Project path to work on
  --section <id|name>   Focus on a specific section only

Stop Options:
  --id <id>             Stop specific runner by ID
  --all                 Stop all runners

Wakeup Options:
  --quiet               Suppress output (for cron)
  --dry-run             Check without acting

Cron Subcommands:
  cron install          Install cron job (every minute)
  cron uninstall        Remove cron job
  cron status           Check cron status

Examples:
  steroids runners start                           # Start in foreground
  steroids runners start --detach                  # Start in background
  steroids runners start --section "Phase 2"       # Focus on section
  steroids runners stop                            # Stop current runner
  steroids runners stop --all                      # Stop all runners
  steroids runners list                            # List all runners
  steroids runners wakeup --dry-run                # Check stale runners
  steroids runners cron install                    # Install auto-wakeup
```

### Multiple Focused Runners

You can run multiple runners focused on different sections:

```bash
# Terminal 1: Work on backend
steroids runners start --section "Phase 2: Backend" --detach

# Terminal 2: Work on frontend
steroids runners start --section "Phase 3: Frontend" --detach

# Check status
steroids runners list
```

### Multi-Project Runners

Different projects can run runners in parallel (one runner per project):

```bash
# In project A
cd ~/code/project-a && steroids runners start --detach

# In project B
cd ~/code/project-b && steroids runners start --detach

# List all runners across all projects
steroids runners list
```

The `runners list` output shows:
- **PROJECT** column with path to each project
- **SECTION** column if runner is focused on a section
- Multi-project warning when runners from different projects exist

---

## Advanced Commands

For advanced commands (purge, runners, backup, gc), see [COMMANDS-ADVANCED.md](./COMMANDS-ADVANCED.md).

---

## Date Format Reference

Commands accepting dates support:

| Format | Example | Description |
|--------|---------|-------------|
| ISO 8601 | `2024-01-15` | Specific date |
| ISO 8601 | `2024-01-15T10:30:00Z` | Specific datetime |
| Relative | `1d`, `7d`, `30d` | Days ago |
| Relative | `1w`, `2w` | Weeks ago |
| Relative | `1m`, `3m` | Months ago |
| Named | `today`, `yesterday` | Common references |
| Named | `last-week`, `last-month` | Period references |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Configuration error |
| 4 | Project/task not found |
| 5 | Permission denied |
| 6 | Hook execution failed |
| 7 | Health threshold not met |

---

## Related Documentation

- [CLI Architecture](./ARCHITECTURE.md) - Architecture, hooks system, storage model
- [CLI API](./API.md) - JSON schemas and error codes
- [Global Coding Standards](../CLAUDE.md) - Project-wide standards
