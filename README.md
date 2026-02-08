# Steroids

**Spec-driven, autonomous software development — with a built-in coder/reviewer loop.**

Steroids is an AI-powered task orchestration system that automates software development through a strict *implement → review → fix* workflow. You define work in markdown specification files, group them into sections (features/phases), and Steroids runs the loop until tasks are done — or a dispute is raised.

> **A developer command center for managing multiple software projects with confidence.**

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
* **Endless loops are prevented** via dispute escalation (after 15 rejections).
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
3. A **reviewer AI** evaluates:
   * Does it match the spec?
   * Does the build pass? Do tests pass?
   * Is it maintainable and architecturally sound?
4. If **rejected**, feedback is appended and the task goes back to the coder.
5. If **approved**, Steroids commits, pushes, and moves to the next task.
6. After **15 rejections**, Steroids raises a **dispute** (human attention required).

```
pending → in_progress → review → completed
              ↑           │
              │           ↓ (rejected)
              └───────────┘
                    │
                    ↓ (external setup)
               skipped/partial
```

**External Setup:** Some tasks require human action (Cloud SQL, account creation, etc.). When the spec says SKIP or MANUAL, the coder can mark it as `skipped` (fully external) or `partial` (some coded, rest external). The runner moves on, and you'll see what needs manual action in `steroids llm --context`.

---

## Key Features

* **Markdown specs** as the contract (task definitions, acceptance criteria, constraints)
* **Sections/phases** to organize features and execution order
* **Coder/Reviewer loop** with strict approval gating
* **Dispute escalation** after 15 rejections to avoid infinite churn
* **CLI-first workflow** for power users and automation
* **Background runner daemon** to process tasks without babysitting
* **Multi-project support** with global project registry
* **Web dashboard** for monitoring progress across projects
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
# Clone the repository
git clone https://github.com/UnlikeOtherAI/steroids-cli.git
cd steroids-cli

# Install dependencies and build
npm install
npm run build

# Link globally
npm link
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
| `steroids tasks add <title> --section <id> --source <file>` | Add a new task |
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

### Runner Management

| Command | Description |
|---------|-------------|
| `steroids runners list` | List active runners |
| `steroids runners start` | Start runner in foreground |
| `steroids runners start --detach` | Start runner in background |
| `steroids runners stop --all` | Stop all runners |
| `steroids runners wakeup` | Check and start runners for projects with pending work |

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

---

## Runner Daemon

Steroids includes a runner daemon for background processing:

```bash
# Start in background
steroids runners start --detach

# Check status
steroids runners list

# Stop all runners
steroids runners stop --all
```

The daemon:
- Picks up pending tasks automatically
- Updates heartbeat for health monitoring
- Pushes approved work to git
- Continues until all tasks complete or shutdown signal received

---

## Web Dashboard

Steroids includes a web dashboard for visual monitoring:

```bash
# From the steroids-cli directory
make launch

# Or start components individually
cd API && npm start &
cd WebUI && npm run dev &

# Access at
# Web UI: http://localhost:3500
# API: http://localhost:3501
```

### Features

- **Multi-project view** — See all registered projects
- **Task queues** — Pending, in-progress, review, completed
- **Runner status** — Active daemons with heartbeat
- **Audit trails** — Full history of task state changes

---

## Configuration

### Project Config (`.steroids/config.yaml`)

```yaml
ai:
  coder:
    provider: claude
    model: claude-sonnet-4
  reviewer:
    provider: claude
    model: claude-sonnet-4

output:
  format: table
  colors: true

quality:
  tests:
    required: true
    minCoverage: 80
```

### Global Config (`~/.steroids/config.yaml`)

Same schema — acts as default, overridden by project config.

### Environment Variables

```bash
ANTHROPIC_API_KEY=...        # For Claude models
OPENAI_API_KEY=...           # For OpenAI models

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

The reviewer verifies:
- Implementation matches the spec
- Build and tests pass
- Code follows project conventions

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
- [ ] Mac menu bar app
- [ ] Interactive config wizard
- [ ] Section priorities and dependencies
- [ ] Provider adapters (multi-vendor coder/reviewer)
- [ ] Token accounting and budgets

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
