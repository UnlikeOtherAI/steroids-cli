# CLI Command Reference

> Complete reference for all Steroids CLI commands with non-interactive options.
> For architecture overview, see [ARCHITECTURE.md](./ARCHITECTURE.md)

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
       steroids tasks audit <id>

Arguments:
  title                     Task title (exact or partial match)
  id                        Task GUID

List Options:
  -s, --status <status>     Filter: pending | in_progress | completed | review | all (default: pending)
  --section <name>          Filter by section heading
  --search <text>           Full-text search in task titles
  --file <path>             Only tasks from specific file (default: TODO.md)
  --sort <field>            Sort by: line | status | section (default: line)
  --limit <n>               Limit results
  --offset <n>              Skip first n results

Update Options:
  --status <status>         New status: pending | in_progress | completed | review
  --no-hooks                Don't trigger completion hooks
  --actor <actor>           Actor making the change (for audit trail)
  --model <model>           Model identifier when actor is LLM

Add Options:
  --source <file>           Specification file (REQUIRED)
  --section <name>          Add under section heading
  --status <status>         Initial status (default: pending)
  --after <title>           Insert after this task

Approve/Reject Options:
  --model <model>           Model performing the review (required)
  --notes <text>            Review notes/comments
  --source-check            Verify against sourceFile before approving

Task Status Markers:
  - [ ]  pending
  - [-]  in_progress
  - [x]  completed
  - [o]  review (ready for review)

Default Behavior:
  'steroids tasks' with no flags shows all PENDING tasks from TODO.md.

Examples:
  steroids tasks                                     # All pending tasks
  steroids tasks --status all                        # All tasks regardless of status
  steroids tasks --section "Backend"                 # Tasks under ## Backend
  steroids tasks --search "login"                    # Find tasks containing "login"

  steroids tasks update "Fix login bug" --status completed
  steroids tasks update "Fix login" --status in_progress  # Partial match works

  steroids tasks add "New feature" --source specs/frontend.md --section "Frontend"
  steroids tasks add "Bug fix" --source specs/bugfix.md --after "Fix login bug"

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

## `steroids hooks`

Manage webhooks and completion scripts.

```
Usage: steroids hooks <subcommand> [options]

Subcommands:
  steroids hooks list                    List all configured hooks
  steroids hooks add                     Add a new hook (interactive)
  steroids hooks remove <name>           Remove a hook by name
  steroids hooks test <event>            Test a hook without side effects
  steroids hooks run <event>             Manually trigger hooks for event
  steroids hooks validate                Validate hooks configuration
  steroids hooks logs                    Show recent hook execution logs

Events:
  task.completed        When a task is marked complete
  task.created          When a new task is added
  section.completed     When all tasks in a section are done
  project.completed     When all tasks in TODO.md are done
  health.changed        When health score changes
  health.critical       When health drops below threshold

Add Options:
  --event <event>           Event to trigger on
  --type <type>             Hook type: script | webhook
  --command <cmd>           Script command (for type=script)
  --url <url>               Webhook URL (for type=webhook)
  --name <name>             Hook name (for identification)
  --async                   Run asynchronously (don't block CLI)

Test Options:
  --task <title>            Mock task for testing
  --section <name>          Mock section for testing
  --payload <json>          Custom payload JSON

Examples:
  steroids hooks list
  steroids hooks list --json

  # Add a script hook
  steroids hooks add --event task.completed --type script \
    --command "./notify.sh" --name "slack-notify"

  # Add a webhook
  steroids hooks add --event project.completed --type webhook \
    --url "https://hooks.slack.com/xxx" --name "slack-webhook"

  # Test without actually running
  steroids hooks test task.completed --task "Fix login bug"

  # Manually trigger
  steroids hooks run section.completed --payload '{"section": "Backend"}'

  # View logs
  steroids hooks logs --limit 20
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

## `steroids serve`

Launch the WebUI server.

```
Usage: steroids serve [options]
       steroids serve start [options]
       steroids serve stop
       steroids serve restart
       steroids serve status

Options:
  -p, --port <port>         Server port (default: 3000)
  -H, --host <host>         Server host (default: localhost)
  --open                    Open browser automatically
  --no-open                 Don't open browser
  --watch                   Reload on file changes
  --base-path <path>        Base path for scanning projects

Background Mode:
  -d, --detach              Run server in background
  --pid-file <path>         Write PID to file (with --detach)
  --log-file <path>         Log output to file (with --detach)

Examples:
  steroids serve                                     # Start on localhost:3000
  steroids serve --port 8080 --open                  # Custom port, open browser
  steroids serve start --detach                      # Background mode
  steroids serve stop                                # Stop background server
  steroids serve restart                             # Restart server
  steroids serve status                              # Check if running
  steroids serve --base-path ~/Projects              # Serve multiple projects
```

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
