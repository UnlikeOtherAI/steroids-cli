<p align="center">
  <img src="Assets/logo.png" alt="Steroids Logo" width="200">
</p>

# Steroids

**Spec-driven, autonomous software development — with a built-in coder/reviewer loop.**

Steroids is an AI-powered task orchestration system that automates software development through a strict *implement → review → fix* workflow. You define work in markdown specification files, group them into sections (features/phases), and Steroids runs the loop until tasks are done — or a dispute is raised.

> **A developer command center for managing multiple software projects with confidence.**

<table align="center" border="0" cellspacing="0" cellpadding="4">
  <tr>
    <td valign="top" style="border: none;"><a href="Assets/Screenshots/Steroids Dashboard.png"><img src="Assets/Screenshots/Steroids Dashboard.png" alt="Dashboard" width="100%"></a></td>
    <td valign="top" style="border: none;"><a href="Assets/Screenshots/Steroids Projects.png"><img src="Assets/Screenshots/Steroids Projects.png" alt="Projects" width="100%"></a></td>
  </tr>
  <tr>
    <td valign="top" style="border: none;"><a href="Assets/Screenshots/Steroids Config.png"><img src="Assets/Screenshots/Steroids Config.png" alt="Config" width="100%"></a></td>
    <td valign="top" style="border: none;"><a href="Assets/Screenshots/Steroids Settings.png"><img src="Assets/Screenshots/Steroids Settings.png" alt="Settings" width="100%"></a></td>
  </tr>
</table>

---

## Table of Contents

* [Why Steroids](#why-steroids)
* [Who It's For](#who-its-for)
* [How It Works](#how-it-works)
* [Key Features](#key-features)
* [Project Structure](#project-structure)
* [Quickstart](#quickstart)
* [CLI Commands](#cli-commands)
* [Runner Daemon](#runner-daemon)
* [Coordinator System](#coordinator-system)
* [Disputes](#disputes)
* [Hooks](#hooks)
* [Web Dashboard](#web-dashboard)
* [Configuration](#configuration)
* [Quality & Safety](#quality--safety)
* [The Suite](#the-suite)
* [Roadmap](#roadmap)
* [Contributing](#contributing)
* [License](#license)
* [Credits](#credits)

---

## Why Steroids

Most AI coding tools optimize for speed. Steroids optimizes for **repeatable delivery**:

* **Specs are the source of truth** — not chat vibes.
* **Coder and reviewer are separated** by design.
* **Nothing progresses without review approval.**
* **Endless loops are prevented** via coordinator intervention and dispute escalation.
* Built for **hands-off runs** — overnight or while you focus elsewhere.

Steroids is for power developers who refuse to let their projects become unmaintainable slop.

---

## Who It's For

Steroids is for software teams and solo developers who want to delegate routine development work to AI while maintaining quality control.

It's especially useful for:

1. Breaking down large projects into small, spec-driven tasks that AI can execute reliably
2. Enforcing consistent code review standards through an automated reviewer
3. Running development work in the background while you focus on higher-level decisions

The coder/reviewer separation ensures work is checked before being accepted, and the dispute mechanism escalates genuinely hard problems to humans rather than spinning endlessly.

---

## How It Works

Steroids runs an autonomous loop per task:

1. **You write specs** in markdown files (tasks grouped into sections/phases).
2. A **coder AI** implements the task strictly according to the spec.
3. A **reviewer AI** evaluates: does it match the spec? Do builds/tests pass? Is the code secure?
4. If **rejected**, feedback is appended and the task goes back to the coder.
5. If **approved**, Steroids commits, pushes, and moves to the next task.
6. A **coordinator AI** intervenes at rejection thresholds (2, 5, 9) to break deadlocks.
7. After **15 rejections**, Steroids raises a **dispute** (human attention required).

```
pending → in_progress → review → completed
              ↑           │
              │           ↓ (rejected)
              └───────────┘
                    │
                    ↓ (15 rejections)
                disputed/failed
```

**External Setup:** Some tasks require human action (Cloud SQL, account creation, etc.). When the spec says SKIP or MANUAL, the coder can mark it as `skipped` (fully external) or `partial` (some coded, rest external). The runner moves on, and you'll see what needs manual action in `steroids llm --context`.

**Feedback Tasks:** Both coder and reviewer can create feedback tasks for advisory items (pre-existing concerns, minor disputes, things needing human review). These go to a special skipped section called "Needs User Input" and never block the pipeline.

---

## Key Features

* **Markdown specs** as the contract (task definitions, acceptance criteria, constraints)
* **Sections/phases** to organize features with priorities and dependencies
* **Coder/Reviewer loop** with strict approval gating
* **Coordinator intervention** at rejection thresholds to break deadlocks
* **Dispute escalation** after 15 rejections to avoid infinite churn
* **Security review** built into the reviewer (injection, shell safety, secrets, permissions)
* **File anchoring** — pin tasks to specific file:line locations with auto-captured commit SHA
* **Feedback tasks** — advisory items in a skipped section for human review
* **Multi-provider support** — Claude, OpenAI, Codex, Gemini
* **CLI-first workflow** for power users and automation
* **Background runner daemon** to process tasks without babysitting
* **Event hooks** — trigger scripts/webhooks on task completion, project events
* **Multi-project support** with global project registry
* **Web dashboard** for monitoring progress across projects
* **Shell completion** for bash, zsh, and fish
* **Backup & restore** for Steroids data
* **Health checks** with weighted scoring for project fitness
* *(Planned)* **Mac menu bar companion** for real-time status at a glance

---

## Project Structure

A typical repo using Steroids:

```
my-project/
├── .steroids/
│   ├── steroids.db        # Task state, sections, audit logs
│   └── config.yaml        # Project configuration
├── specs/
│   ├── auth.md            # Specification files
│   ├── billing.md
│   └── dashboard.md
├── AGENTS.md              # Guidelines for AI agents
└── src/                   # Your code
```

> **Specs are stable, state is generated.** The `.steroids/` directory contains the SQLite database tracking all task state.

---

## Quickstart

### 1. Install

```bash
# Option A: Install from npm
npm install -g steroids-cli

# Option B: Install from source
git clone https://github.com/UnlikeOtherAI/steroids-cli.git
cd steroids-cli
npm install && npm run build && npm link
```

### 2. Initialize in a project

```bash
cd ~/Projects/my-app
steroids init
```

This creates `.steroids/` with the database and default config.

### 3. Create sections and tasks

```bash
# Add a section (feature/phase)
steroids sections add "Phase 1: User Authentication"

# Add tasks with specs
steroids tasks add "Implement login endpoint" \
  --section <section-id> \
  --source specs/auth.md

# Anchor a task to a specific file and line
steroids tasks add "Fix null check in utils" \
  --section <section-id> \
  --source specs/fix.md \
  --file src/utils.ts --line 42

# Create a feedback task for human review
steroids tasks add "Should we use Redis or in-memory cache?" --feedback
```

### 4. Run the loop

```bash
# Interactive loop (foreground)
steroids loop

# Or start background daemon
steroids runners start --detach
```

Steroids processes tasks in order, looping coder/reviewer until completion or dispute.

---

## CLI Commands

### Core Commands

| Command | Description |
|---------|-------------|
| `steroids init` | Initialize Steroids in current directory |
| `steroids about` | Explain what Steroids is (for LLMs discovering the tool) |
| `steroids llm` | Compact instructions for LLM agents (call when context lost) |
| `steroids llm --context` | Include current project context (active tasks, runners) |
| `steroids loop` | Run the coder/reviewer loop interactively |
| `steroids loop --once` | Run one iteration only |

### Task Management

| Command | Description |
|---------|-------------|
| `steroids tasks stats` | Show task counts by status |
| `steroids tasks list` | List pending tasks |
| `steroids tasks list --status all` | List all tasks with status |
| `steroids tasks list --status active` | Show in_progress + review tasks |
| `steroids tasks show <id>` | Show task details with invocation logs |
| `steroids tasks add <title> --section <id> --source <file>` | Add a new task |
| `steroids tasks add <title> ... --file <path> --line <n>` | Add task anchored to a committed file |
| `steroids tasks add <title> --feedback` | Add feedback task (skipped section, no --section/--source needed) |
| `steroids tasks update <id> --status review` | Submit task for review |
| `steroids tasks approve <id> --model <model>` | Approve a task |
| `steroids tasks reject <id> --model <model> --notes "..."` | Reject with feedback |
| `steroids tasks skip <id> --notes "..."` | Skip external setup task |
| `steroids tasks skip <id> --partial --notes "..."` | Partial skip (coded some, rest external) |
| `steroids tasks audit <id>` | View task audit trail |

### Section Management

| Command | Description |
|---------|-------------|
| `steroids sections list` | List all sections |
| `steroids sections add <name>` | Create a new section |
| `steroids sections skip <id>` | Exclude section from runner |
| `steroids sections unskip <id>` | Include section in runner |
| `steroids sections priority <id> <value>` | Set section priority (0-100 or high/medium/low) |
| `steroids sections depends-on <id> <dep-id>` | Add section dependency |
| `steroids sections no-depends-on <id> <dep-id>` | Remove section dependency |
| `steroids sections graph` | Show dependency graph (ASCII, `--mermaid`, or `--output png`) |

### Runner Management

| Command | Description |
|---------|-------------|
| `steroids runners list` | List active runners |
| `steroids runners start` | Start runner in foreground |
| `steroids runners start --detach` | Start runner in background |
| `steroids runners start --section <name>` | Focus on a specific section |
| `steroids runners stop --all` | Stop all runners |
| `steroids runners status` | Current runner state |
| `steroids runners logs [pid]` | View daemon output (`--tail`, `--follow`) |
| `steroids runners wakeup` | Check and start runners for projects with pending work |
| `steroids runners cron install` | Install cron job for auto-wakeup |
| `steroids runners cron uninstall` | Remove cron job |

### Dispute Management

| Command | Description |
|---------|-------------|
| `steroids dispute list` | List open disputes |
| `steroids dispute show <id>` | Show dispute details |
| `steroids dispute create <task-id> --reason "..." --type <type>` | Create a dispute (types: major, minor, coder, reviewer) |
| `steroids dispute resolve <id> --decision <coder\|reviewer\|custom>` | Resolve a dispute |
| `steroids dispute log <task-id> --notes "..."` | Log minor disagreement without blocking |

### AI Providers

| Command | Description |
|---------|-------------|
| `steroids ai providers` | List detected AI providers |
| `steroids ai models <provider>` | List available models for a provider |
| `steroids ai test` | Test AI configuration (coder/reviewer connectivity) |
| `steroids ai setup` | Interactive provider setup |

### Project Registry

| Command | Description |
|---------|-------------|
| `steroids projects list` | List registered projects |
| `steroids projects add <path>` | Register a project |
| `steroids projects remove <path>` | Unregister a project |
| `steroids projects prune` | Remove stale project entries |

### Configuration

| Command | Description |
|---------|-------------|
| `steroids config show [key]` | Display configuration (supports nested paths like `quality.tests`) |
| `steroids config set <key> <value>` | Set configuration value (supports nested paths) |
| `steroids config init` | Initialize config with defaults |
| `steroids config validate` | Validate configuration syntax |
| `steroids config edit` | Open config in $EDITOR |

### Maintenance & Utilities

| Command | Description |
|---------|-------------|
| `steroids health` | Project health check with weighted scoring |
| `steroids scan` | Scan directory for projects (auto-detects language/framework) |
| `steroids backup create` | Backup Steroids data |
| `steroids backup restore <file>` | Restore from backup |
| `steroids gc` | Garbage collection (orphaned IDs, stale runners, DB optimization) |
| `steroids purge tasks --older-than 30d` | Purge old data |
| `steroids locks list` | View active task/section locks |
| `steroids locks release <id>` | Release a stuck lock |
| `steroids stats` | Global activity statistics |
| `steroids stats 7d` | Activity stats for last 7 days |
| `steroids git status` | Git status with task context |
| `steroids git push` | Push with retry logic |
| `steroids logs list` | List invocation log files |
| `steroids completion bash` | Generate shell completion script |
| `steroids completion install` | Auto-install completion for your shell |
| `steroids hooks list` | List configured event hooks |
| `steroids hooks add` | Add an event hook |
| `steroids hooks test <event>` | Test a hook |

---

## Runner Daemon

Steroids includes a runner daemon for background processing:

```bash
# Start in background
steroids runners start --detach

# Check status
steroids runners list

# View logs
steroids runners logs <pid> --follow

# Stop all runners
steroids runners stop --all

# Auto-restart via cron
steroids runners cron install
```

The daemon:
- Picks up pending tasks automatically
- Updates heartbeat for health monitoring
- Pushes approved work to git
- Continues until all tasks complete or shutdown signal received
- Skips sections marked as skipped (e.g., "Needs User Input")

---

## Coordinator System

When the coder and reviewer get stuck in a rejection loop, the **coordinator** intervenes automatically at rejection thresholds (2, 5, and 9 rejections):

The coordinator analyzes the rejection history and makes one of three decisions:

| Decision | Effect |
|----------|--------|
| **guide_coder** | Reviewer feedback is valid — gives the coder clearer direction |
| **override_reviewer** | Some reviewer demands are out of scope — tells the reviewer to stop raising them |
| **narrow_scope** | Reduces the task scope to an achievable subset |

The coordinator's guidance flows to **both** the coder and the reviewer on subsequent iterations, ensuring alignment. This prevents death spirals where the coder and reviewer talk past each other.

Configure the coordinator in `.steroids/config.yaml`:

```yaml
ai:
  orchestrator:
    provider: claude
    model: claude-sonnet-4
```

---

## Disputes

When a task hits 15 rejections, or when a coder/reviewer raises one manually, Steroids creates a **dispute**:

```bash
# View open disputes
steroids dispute list

# Resolve a dispute
steroids dispute resolve <id> --decision coder --notes "Coder's approach is correct"
```

Dispute types:
- **major** — Fundamental disagreement blocking progress
- **minor** — Logged for record, doesn't block
- **coder** — Raised by the coder against reviewer feedback
- **reviewer** — Raised by the reviewer against coder's implementation

---

## Hooks

Steroids supports event hooks that trigger shell commands or webhooks:

```bash
# List configured hooks
steroids hooks list

# Add a hook
steroids hooks add

# Test a hook
steroids hooks test task.completed
```

Events: `task.created`, `task.completed`, `task.failed`, `section.completed`, `project.completed`

Configure hooks in `.steroids/config.yaml` or manage via CLI.

---

## Web Dashboard

Steroids includes a web dashboard for visual monitoring. It auto-clones on first run:

```bash
# Launch the dashboard (clones repo to ~/.steroids/webui/ on first run)
steroids web

# Check status
steroids web status

# Pull latest changes and reinstall
steroids web update

# Stop the dashboard
steroids web stop

# Access at
# Web UI: http://localhost:3500
# API: http://localhost:3501
```

| Command | Description |
|---------|-------------|
| `steroids web` | Clone (if needed) and launch WebUI + API |
| `steroids web update` | Pull latest code and reinstall dependencies |
| `steroids web stop` | Stop running WebUI and API processes |
| `steroids web status` | Check if dashboard is running |

### Features

- **Multi-project view** — See all registered projects
- **Task queues** — Pending, in-progress, review, completed
- **Runner status** — Active daemons with heartbeat
- **Audit trails** — Full history of task state changes
- **Configuration** — Edit project settings from the browser

---

## Configuration

### Project Config (`.steroids/config.yaml`)

```yaml
ai:
  coder:
    provider: claude          # claude, openai, codex, gemini
    model: claude-sonnet-4
  reviewer:
    provider: claude
    model: claude-sonnet-4
  orchestrator:               # Coordinator for breaking rejection loops
    provider: claude
    model: claude-sonnet-4

output:
  format: table
  colors: true

quality:
  tests:
    required: true
    minCoverage: 80           # Per-task modified files, not global

sections:
  batchMode: false            # Process all section tasks at once
  maxBatchSize: 10            # Max tasks per batch

disputes:
  timeoutDays: 7
  autoCreateOnMaxRejections: true

runners:
  heartbeatInterval: 30s
  staleTimeout: 5m
  maxConcurrent: 1

locking:
  taskTimeout: 60m
  sectionTimeout: 120m

database:
  autoMigrate: true
  backupBeforeMigrate: true

build:
  timeout: 5m

test:
  timeout: 10m

logs:
  retention: 30d
  level: info                 # debug, info, warn, error

backup:
  enabled: true
  retention: 7d
```

### Global Config (`~/.steroids/config.yaml`)

Same schema — acts as default, overridden by project config.

### Environment Variables

```bash
ANTHROPIC_API_KEY=...        # For Claude models
OPENAI_API_KEY=...           # For OpenAI models
GOOGLE_API_KEY=...           # For Gemini models

STEROIDS_JSON=1              # Output as JSON
STEROIDS_QUIET=1             # Minimal output
STEROIDS_VERBOSE=1           # Detailed output
STEROIDS_NO_COLOR=1          # Disable colors
```

---

## Quality & Safety

Steroids is built for developers who believe in:

* **Testable code** over "it works on my machine"
* **Clean architecture** over vibe coding
* **Maintainable structures** over quick hacks
* **Developer experience** over feature bloat

The coder is required to:
- Run build before submitting for review
- Run tests before submitting for review
- Fix errors until both pass
- Use secure patterns (array-based shell APIs, parameterized queries)
- Create feedback tasks for pre-existing concerns

The reviewer verifies:
- Implementation matches the spec
- Build and tests pass
- Code follows project conventions
- **Security review** of new/changed code (injection, shell safety, secrets, permissions, unsafe execution)
- Test coverage for modified files (when configured)
- Creates feedback tasks for advisory items that don't block approval

---

## The Suite

### Steroids CLI
The main task orchestration CLI. Manages tasks, sections, runners, and the coder/reviewer loop.

### Monitor *(Planned)*
Mac menu bar companion app for real-time status at a glance across multiple projects.

### Pump *(Planned)*
Data gathering CLI using Google APIs (Gemini, Search). Grounds LLM responses with real-time data.

### Iron *(Planned)*
Documentation scaffolding wizard. Interactive CLI for setting up CLAUDE.md, AGENTS.md, and architecture docs.

---

## Roadmap

- [x] Core CLI with task/section management
- [x] Coder/Reviewer loop with dispute escalation
- [x] Background runner daemon
- [x] Multi-project registry
- [x] Web dashboard (basic)
- [x] Section priorities and dependencies
- [x] Section batch mode (process all tasks at once)
- [x] Multi-provider support (Claude, OpenAI, Codex, Gemini)
- [x] Coordinator system for breaking rejection loops
- [x] Event hooks (shell commands, webhooks)
- [x] Security review in reviewer prompt
- [x] File anchoring for tasks
- [x] Feedback tasks (skipped "Needs User Input" section)
- [x] Shell completion (bash, zsh, fish)
- [x] Backup & restore
- [x] Health checks and project scanning
- [ ] Mac menu bar app
- [ ] Token accounting and budgets
- [ ] Jira integration (sync tasks, update tickets)

---

## Contributing

We welcome contributions that improve code quality and developer experience.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See [CONTRIBUTING.md](./Docs/CONTRIBUTING.md) for detailed guidelines.

---

## License

MIT License — see [LICENSE](./LICENSE) for details.

---

## Credits

Created by [UnlikeOther.ai](https://unlikeother.ai)

**Author:** Ondrej Rafaj ([@rafiki270](https://github.com/rafiki270))

<p align="center">
  <em>Made with love in Scotland.</em>
</p>
