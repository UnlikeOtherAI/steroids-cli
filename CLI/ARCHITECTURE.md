# CLI Architecture

> For global coding rules (500-line limit, testability, patterns), see [CLAUDE.md](../CLAUDE.md)

## Related Documentation

### Orchestrator System (Core)
- [ORCHESTRATOR.md](./ORCHESTRATOR.md) - **Main daemon loop, task state machine, cron wake-up**
- [AI-PROVIDERS.md](./AI-PROVIDERS.md) - **Provider configuration (Claude, Gemini, OpenAI)**
- [PROMPTS.md](./PROMPTS.md) - **Prompt templates for coder/reviewer/orchestrator**
- [GIT-WORKFLOW.md](./GIT-WORKFLOW.md) - **When and how git push happens**
- [DISPUTES.md](./DISPUTES.md) - **Coder/reviewer disagreement handling**

### Commands & API
- [COMMANDS.md](./COMMANDS.md) - Core command reference
- [COMMANDS-ADVANCED.md](./COMMANDS-ADVANCED.md) - Runners, purge, backup commands
- [API.md](./API.md) - JSON schemas, error codes, environment variables

### Configuration & Storage
- [CONFIG-SCHEMA.md](./CONFIG-SCHEMA.md) - Config schema system and TUI browser
- [STORAGE.md](./STORAGE.md) - SQLite storage, database schema
- [MIGRATIONS.md](./MIGRATIONS.md) - Database migration system
- [SCHEMAS.md](./SCHEMAS.md) - JSON validation schemas

### Task Coordination
- [RUNNERS.md](./RUNNERS.md) - LLM agent coordination and wake-up system
- [LOCKING.md](./LOCKING.md) - Task locking for multi-runner coordination
- [AUDIT.md](./AUDIT.md) - Audit trail and approval workflow
- [HOOKS.md](./HOOKS.md) - Event hooks configuration

### Implementation
- [IMPLEMENTATION.md](./IMPLEMENTATION.md) - Code examples for implementers

## Overview

The Steroids CLI is a command-line utility for managing tasks, checking health, and launching the WebUI server. It operates in the **current directory context** - wherever you run `steroids`, that's your project.

---

## Core Principles

### 1. File-Based Storage (No Database)

All state is stored in plain files - no SQLite, no PostgreSQL for CLI operations.

```
your-project/
├── TODO.md              # Tasks (human-readable)
├── AGENTS.md            # Project guidelines
├── .steroids/          # Local project config & state
│   ├── config.yaml      # Project-specific settings
│   ├── hooks.yaml       # Webhook/script definitions
│   └── steroids.db      # SQLite database (tasks, audit, disputes)
└── ...

~/.steroids/            # Global config
├── config.yaml          # Global settings
├── hooks.yaml           # Global hooks (all projects)
└── runners/             # Runner coordination
    ├── steroids.db      # Global SQLite (runner states)
    ├── lock/            # Singleton lock directory
    └── logs/            # Runner execution logs
```

### 2. Current Directory = Project Context

- No `project` command needed
- Run `steroids` from your project root
- All commands operate on current directory
- Use `steroids scan` from a parent directory to see multiple projects

### 3. Task Updates Write Back to Files

When you update a task status:
```bash
steroids tasks update "Fix login bug" --status completed
```
It directly modifies TODO.md:
```diff
- - [ ] Fix login bug
+ - [x] Fix login bug
```

---

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Node.js 20 LTS | Execution environment |
| Language | TypeScript 5.x | Type safety |
| CLI Framework | Commander.js | Command parsing |
| Output | Chalk + cli-table3 | Colored, formatted output |
| Config | Cosmiconfig | Configuration loading |
| HTTP | Undici | API client (if needed) |

---

## Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLI Layer                               │
│  Commands, Arguments, Output Formatting                          │
├─────────────────────────────────────────────────────────────────┤
│                        Application Layer                         │
│  Use Cases, Orchestration, Services                              │
├─────────────────────────────────────────────────────────────────┤
│                          Domain Layer                            │
│  Entities, Business Logic, Repositories                          │
├─────────────────────────────────────────────────────────────────┤
│                       Infrastructure Layer                       │
│  File System, Git, HTTP Client, Configuration                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
CLI/
├── src/
│   ├── domain/
│   │   ├── entities/
│   │   │   ├── Project.ts
│   │   │   ├── Task.ts
│   │   │   ├── Config.ts
│   │   │   └── index.ts
│   │   ├── value-objects/
│   │   │   ├── ProjectPath.ts
│   │   │   ├── TaskStatus.ts
│   │   │   └── index.ts
│   │   ├── repositories/
│   │   │   ├── IProjectRepository.ts
│   │   │   ├── IConfigRepository.ts
│   │   │   └── index.ts
│   │   └── services/
│   │       ├── ProjectDiscoveryService.ts
│   │       ├── TaskParsingService.ts
│   │       └── index.ts
│   │
│   ├── application/
│   │   ├── use-cases/
│   │   │   ├── ScanProjectsUseCase.ts
│   │   │   ├── ListTasksUseCase.ts
│   │   │   ├── UpdateTaskUseCase.ts
│   │   │   ├── CheckHealthUseCase.ts
│   │   │   ├── InitConfigUseCase.ts
│   │   │   └── index.ts
│   │   └── services/
│   │       ├── OutputFormatterService.ts
│   │       ├── InteractivePromptService.ts
│   │       └── index.ts
│   │
│   ├── infrastructure/
│   │   ├── filesystem/
│   │   │   ├── FileSystemProjectRepository.ts
│   │   │   ├── FileSystemConfigRepository.ts
│   │   │   ├── TodoFileParser.ts
│   │   │   ├── AgentsFileParser.ts
│   │   │   └── index.ts
│   │   ├── git/
│   │   │   ├── GitClient.ts
│   │   │   ├── GitStatusChecker.ts
│   │   │   ├── PrerequisitesChecker.ts
│   │   │   ├── GitSetupService.ts
│   │   │   └── index.ts
│   │   ├── http/
│   │   │   ├── ApiClient.ts
│   │   │   └── index.ts
│   │   └── config/
│   │       ├── ConfigLoader.ts
│   │       ├── ConfigValidator.ts
│   │       └── index.ts
│   │
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── init.ts
│   │   │   ├── scan.ts
│   │   │   ├── tasks.ts
│   │   │   ├── health.ts
│   │   │   ├── config.ts
│   │   │   ├── serve.ts
│   │   │   └── index.ts
│   │   ├── arguments/
│   │   │   ├── globalOptions.ts
│   │   │   ├── projectOptions.ts
│   │   │   └── index.ts
│   │   ├── output/
│   │   │   ├── TableFormatter.ts
│   │   │   ├── JsonFormatter.ts
│   │   │   ├── ColoredOutput.ts
│   │   │   └── index.ts
│   │   └── program.ts
│   │
│   ├── container/
│   │   ├── Container.ts
│   │   ├── bindings.ts
│   │   └── index.ts
│   │
│   └── main.ts
│
├── tests/
│   ├── unit/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── integration/
│   └── fixtures/
│
├── package.json
├── tsconfig.json
└── README.md
```

---

## Non-Interactive Mode

**Every command MUST support full non-interactive operation via explicit flags/options.**

This enables:
- Scripting and automation
- CI/CD pipelines
- LLM agents (Claude, GPT, etc.) to operate without prompts

### Design Principles

1. **All prompts must have flag equivalents** - If a command asks a question interactively, there must be a flag to answer it
2. **Sensible defaults** - Commands should work with minimal flags when possible
3. **Explicit is better than implicit** - Non-interactive mode should never guess user intent
4. **JSON output for parsing** - All commands support `--json` for machine-readable output
5. **Exit codes are semantic** - Scripts can check exit codes without parsing output

### Non-Interactive Detection

```typescript
// cli/utils/interactive.ts
export function isInteractive(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
}

export function requireInteractive(message: string): void {
  if (!isInteractive()) {
    console.error(`Error: ${message}`);
    console.error('This operation requires interactive mode or explicit flags.');
    process.exit(2);
  }
}
```

---

## LLM-Friendly Help Documentation

**Help text must be comprehensive enough for any LLM to use the CLI correctly without external documentation.**

### Help Standards

1. **Every command has detailed `--help`** with examples
2. **Every option has a clear description** including valid values
3. **Examples show common use cases** with exact syntax
4. **Related commands are cross-referenced**
5. **Error messages suggest the correct flag/syntax**

### Help Template

```typescript
// cli/commands/template.ts
new Command('example')
  .description('Short one-line description of what this command does')
  .addHelpText('after', `
Examples:
  $ steroids example                    # Basic usage with defaults
  $ steroids example --flag value       # With specific option
  $ steroids example --json             # Machine-readable output
  $ steroids example --yes              # Non-interactive, accept defaults

Options Reference:
  --flag <value>    Description of what flag does (default: "default")
  --yes, -y         Skip all confirmations, use defaults
  --json, -j        Output as JSON for scripting/LLM parsing
  --quiet, -q       Suppress non-essential output
  --verbose, -v     Show detailed output for debugging

Related Commands:
  steroids other-cmd    Does something related
  steroids another      Also relevant

Exit Codes:
  0  Success
  1  General error (see message)
  2  Invalid arguments
`)
```

---

## Commands

| Command | Description |
|---------|-------------|
| `steroids init` | Initialize Steroids in current directory |
| `steroids scan [path]` | Scan directory for projects |
| `steroids tasks [--project]` | List tasks across projects |
| `steroids tasks update <id>` | Update task status |
| `steroids health` | Check system health |
| `steroids config init` | Initialize configuration |
| `steroids config show` | Show current configuration |
| `steroids serve` | Launch WebUI server |

> **Full Command Reference:** See [COMMANDS.md](./COMMANDS.md) for complete options and examples.

---

## Prerequisites & Setup Flow

Steroids requires Git. The `steroids init` command handles all setup with interactive prompts.

### Setup Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     steroids init                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ Is Git installed?│
                    └─────────────────┘
                              │
                 ┌────────────┴────────────┐
                 │ NO                      │ YES
                 ▼                         ▼
        ┌─────────────────┐      ┌─────────────────┐
        │ Error: Git      │      │ Is this a Git   │
        │ required.       │      │ repository?     │
        │ Install Git     │      └─────────────────┘
        │ and try again.  │               │
        └─────────────────┘    ┌──────────┴──────────┐
                               │ NO                  │ YES
                               ▼                     ▼
                    ┌──────────────────┐   ┌─────────────────┐
                    │ Ask: Initialize  │   │ Has remote      │
                    │ new Git repo?    │   │ origin?         │
                    └──────────────────┘   └─────────────────┘
                               │                     │
                    ┌──────────┴──────┐    ┌────────┴────────┐
                    │ NO         YES  │    │ NO         YES  │
                    ▼              ▼       ▼              ▼
              ┌──────────┐  ┌──────────┐ ┌──────────┐  ┌──────────┐
              │ Exit     │  │ git init │ │ Check    │  │ Ready!   │
              └──────────┘  └──────────┘ │ auth     │  └──────────┘
                                   │     └──────────┘
                                   ▼            │
                          ┌─────────────────┐   │
                          │ Check Git auth  │◄──┘
                          └─────────────────┘
                                   │
                        ┌──────────┴──────────┐
                        │ NO                  │ YES
                        ▼                     ▼
               ┌─────────────────┐  ┌─────────────────┐
               │ Warn: Not       │  │ Ask: Create     │
               │ authenticated.  │  │ remote repo?    │
               │ Continue local. │  └─────────────────┘
               └─────────────────┘           │
                                  ┌──────────┴──────────┐
                                  │ NO              YES │
                                  ▼                  ▼
                           ┌──────────┐    ┌─────────────────┐
                           │ Continue │    │ Ask: Provider?  │
                           │ local    │    │ (GitHub/GitLab) │
                           └──────────┘    └─────────────────┘
                                                    │
                                                    ▼
                                          ┌─────────────────┐
                                          │ Ask: Repo name? │
                                          └─────────────────┘
                                                    │
                                                    ▼
                                          ┌─────────────────┐
                                          │ Create repo via │
                                          │ gh/glab CLI     │
                                          └─────────────────┘
                                                    │
                                                    ▼
                                          ┌─────────────────┐
                                          │ git remote add  │
                                          │ origin <url>    │
                                          └─────────────────┘
                                                    │
                                                    ▼
                                          ┌─────────────────┐
                                          │ git push -u     │
                                          │ origin main     │
                                          └─────────────────┘
                                                    │
                                                    ▼
                                             ┌──────────┐
                                             │ Ready!   │
                                             └──────────┘
```

### Key Components

| Component | Purpose |
|-----------|---------|
| `PrerequisitesChecker` | Checks Git installation, repo status, authentication |
| `GitSetupService` | Initializes repos, creates remotes on GitHub/GitLab |
| `TodoFileParser` | Parses TODO.md checkbox syntax |
| `AgentsFileParser` | Extracts metadata from AGENTS.md files |
| `GitClient` | Git operations (commits, status, etc.) |
| `ConfigLoader` | Loads and merges configuration |
| `HookRunner` | Executes webhooks/scripts on events |
| `TableFormatter` | Formats output as CLI tables |
| `JsonFormatter` | Formats output as JSON |

> **Implementation Details:** See [IMPLEMENTATION.md](./IMPLEMENTATION.md) for full code examples.

---

## Hooks & Webhooks System

Hooks trigger scripts or HTTP webhooks when events occur.

> **Full Guide:** See [HOOKS.md](./HOOKS.md) for complete configuration reference.

### Hook Events

| Event | Trigger |
|-------|---------|
| `task.completed` | Task marked complete |
| `task.created` | New task added |
| `section.completed` | All tasks in section done |
| `project.completed` | All tasks in project done |
| `health.changed` | Health score changes |
| `health.critical` | Health drops below threshold |

### Quick Example

```yaml
# .steroids/hooks.yaml
hooks:
  - name: notify-slack
    event: task.completed
    type: script
    command: ./scripts/notify.sh
    args: ["{{task.title}}"]

  - name: deploy-webhook
    event: project.completed
    type: webhook
    url: https://api.example.com/deploy
    method: POST
    body:
      project: "{{project.name}}"
```

### CLI Commands

```bash
steroids hooks list              # List all hooks
steroids hooks test <event>      # Test without running
steroids hooks validate          # Check configuration
```

### Error Messages

| Scenario | Message |
|----------|---------|
| Git not installed | `Git is not installed. Install Git: https://git-scm.com/downloads` |
| gh CLI not installed | `GitHub CLI (gh) is not installed. Install it: https://cli.github.com/` |
| glab CLI not installed | `GitLab CLI (glab) is not installed. Install it: https://gitlab.com/gitlab-org/cli` |
| Auth failed | `Git authentication failed. Run 'gh auth login' or configure SSH keys.` |
| Repo creation failed | `Failed to create repository. Check your permissions and try again.` |

---

## Configuration

### Config File Location

```
~/.steroids/config.yaml
```

### Config Schema

```yaml
projects:
  basePath: ~/Projects
  scanInterval: 5m
  ignored: [node_modules, .git, dist, build]

output:
  format: table  # table | json
  colors: true
  verbose: false

webui:
  port: 3000
  host: localhost
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Invalid arguments |
| 3 | Configuration error |
| 4 | Project not found |
| 5 | Permission denied |

> **JSON Schemas & Error Codes:** See [API.md](./API.md) for complete JSON output schemas, error codes, and environment variables.
