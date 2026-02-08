# Steroids Coding Standards

## Language & Project Agnostic (CRITICAL)

**Steroids must work with ANY programming language and project type.**

When writing prompts, scripts, or CLI features:
- Do NOT hardcode `npm`, `cargo`, `go`, or any specific build tool
- Use generic terms like "the project's build command" or "the project's test command"
- Provide examples across languages (e.g., "npm test / pytest / cargo test") rather than assuming one
- Configuration and hooks should support arbitrary shell commands
- Never assume the project structure (package.json, Cargo.toml, etc.)

Steroids manages tasks and runs coders/reviewers. It doesn't care what language the target project uses.

## Workflow (CRITICAL)

**Commit and push after each turn.** Every time you complete a unit of work (a task, a fix, a feature), you MUST:

1. `git add` the relevant files
2. `git commit` with a descriptive message
3. `git push` to the remote

Do NOT accumulate changes across multiple turns. Small, frequent commits are better than large batches.

### Release Versioning

Follow semantic versioning strictly:

- **Patch release (0.1.x)** - After each completed task
  ```bash
  npm version patch
  git push --tags
  ```

- **Minor release (0.x.0)** - After each completed section
  ```bash
  npm version minor
  git push --tags
  ```

- **Major release (x.0.0)** - Breaking changes or major milestones only

This ensures every task completion is a deployable artifact and sections mark feature milestones.

### GitHub Releases

**When creating a version, also create a GitHub release using `gh` CLI if available.**

After `npm version` and `git push --tags`:

```bash
# Get the version just created
VERSION=$(npm pkg get version | tr -d '"')

# Create GitHub release with release notes
gh release create "v${VERSION}" \
  --title "v${VERSION}" \
  --notes "## Changes in v${VERSION}

- <Brief description of what was added/fixed>
- <List key changes from commits since last release>

See commit history for full details."
```

**For minor/major releases**, include more detailed notes:
```bash
gh release create "v${VERSION}" \
  --title "v${VERSION} - <Feature Name>" \
  --notes "## What's New in v${VERSION}

### Features
- <New feature 1>
- <New feature 2>

### Fixes
- <Bug fix 1>

### Breaking Changes (if any)
- <Description of breaking change>

Full changelog: https://github.com/UnlikeOtherAI/steroids-cli/compare/v<prev>...v${VERSION}"
```

**Tip:** Use `gh release list` to see previous releases and `git log --oneline v<prev>..HEAD` to see changes since last release.

### Dependency Management (CRITICAL)

**Always use the latest stable versions of dependencies.** Before adding or updating packages:

1. **Check for latest versions** before installing any package:
   ```bash
   # Check latest version of a package
   npm view <package-name> version

   # Or use npm-check-updates to see all outdated deps
   npx npm-check-updates
   ```

2. **Use exact or up-to-date ranges** when adding new dependencies:
   ```bash
   # Good: Install latest version
   npm install package-name@latest

   # Good: Check and update all deps
   npx npm-check-updates -u && npm install
   ```

3. **Periodically audit dependencies**:
   ```bash
   npm audit
   npm outdated
   ```

**Why latest versions matter:**
- Security patches and bug fixes
- Performance improvements
- Better compatibility with modern tooling
- Reduced technical debt

**When adding WebUI/API dependencies**, always verify you're installing the current stable release, not an older version from cached package-lock.json or outdated tutorials.

### Use Compiled CLI, Not Node (CRITICAL)

**NEVER run `node dist/index.js` directly.** Always use the installed `steroids` command.

```bash
# BAD - Don't do this
node dist/index.js tasks list
node dist/index.js loop

# GOOD - Use the compiled CLI
steroids tasks list
steroids loop
```

**Why?**
- Tests the actual user experience
- Uses the properly linked binary
- Ensures PATH and permissions work correctly
- Catches installation/linking issues

**When you need to update the CLI:**
1. Stop any running processes: `steroids runners stop --all`
2. Rebuild: `npm run build`
3. Relink: `npm link`
4. Restart: `steroids runners start --detach`

The Makefile does steps 2-3: `make build`

### Testing in Temp Directories (CRITICAL)

**When testing `steroids init` in temp directories, ALWAYS use `--no-register`.**

```bash
# BAD - Pollutes global project registry
mkdir /tmp/test-project
cd /tmp/test-project
steroids init -y  # ❌ Registers in global DB

# GOOD - Keeps registry clean
mkdir /tmp/test-project
cd /tmp/test-project
steroids init -y --no-register  # ✓ No global registration
```

**Why?**
- `steroids init` auto-registers projects in the global database
- Test directories pollute the registry and show up in `steroids projects list`
- The wakeup cron may try to start runners for stale test directories
- Cleanup becomes a manual chore

**When writing integration test scripts:**
```bash
#!/bin/bash
# Integration test for CLI
cd /tmp && mkdir -p test-cli && cd test-cli
steroids init -y --no-register  # Always --no-register in temp dirs!
# ... run tests ...
rm -rf /tmp/test-cli
```

### Debug Stuck Runners (CRITICAL)

**When a runner appears stuck, ALWAYS investigate why.** Don't just restart - find the root cause.

**Debugging steps:**
```bash
# 1. Check runner status
steroids runners list

# 2. Check what task is active
steroids tasks --status active

# 3. Check if coder/reviewer process is running
ps aux | grep -E "claude|codex" | grep -v grep

# 4. Check task audit trail
steroids tasks audit <task-id>

# 5. If runner registered but no process running, check the daemon
ps aux | grep <runner-pid>

# 6. Run loop in foreground to see errors
steroids runners stop --all
steroids loop --once
```

**Common issues:**
- Daemon registered but not running loop (skeleton code)
- Coder/reviewer process crashed
- Task stuck in state that doesn't match any action
- Database locked

**Always document the root cause when found and create a fix.**

---

## Scope

These rules apply to **ALL** Steroids components without exception.

## Architecture Documentation

- [CLI Architecture](./CLI/ARCHITECTURE.md) - Main task management CLI
- [Monitor](./Monitor/ARCHITECTURE.md) - Mac menu bar app (multi-project)
- [Pump](./Pump/README.md) - Data gathering CLI (Google APIs, LLM grounding)
- [Iron](./Iron/README.md) - Documentation scaffolding CLI
- [WebUI Architecture](./WebUI/ARCHITECTURE.md) - Dashboard (ON HOLD)
- [Code Quality](./Docs/CODE_QUALITY.md) - The 50 rules in detail

### The Suite: Pump Iron + Steroids

| Component | Purpose | Status |
|-----------|---------|--------|
| **Steroids CLI** | Task management, runners, hooks | Designing |
| **Monitor** | Mac menu bar app for multi-project monitoring | Planned |
| **Pump** | Data gathering, LLM grounding (Google APIs) | Planned |
| **Iron** | Documentation scaffolding wizard | Planned |
| **WebUI** | Visual dashboard (single project) | On Hold |

All CLIs are independent and can be used standalone.

---

## Icon Library

**Use Font Awesome for all icons.** This applies to all components (CLI help text, WebUI, documentation).

---

## Test Directories (IMPORTANT)

**Projects are only registered globally if they are inside a git repository.**

This prevents test/temporary directories from polluting the global project registry. When running `steroids init`:

- **In a git repo** → Registered in `~/.steroids/steroids.db` (appears in Monitor, wakeup, etc.)
- **Not in a git repo** → Local `.steroids/` created but NOT registered globally
- **With `--no-register`** → Explicitly skip registration even in a git repo

This means AI agents can freely create test directories in `/tmp/` or elsewhere to test functionality without polluting the global registry. The test projects will work locally but won't appear in the Monitor app or interfere with real projects.

---

## Core Constraints (MANDATORY)

### 0. Understand the System First (CRITICAL)

**Before doing ANYTHING, run this command. It explains everything.**

```bash
steroids llm
```

### 0.1 Use Steroids to Build Steroids (CRITICAL)

**NEVER develop features directly in this project.** Use the Steroids CLI to manage all work.

**Before ANY development work:**
```bash
# 1. Build the latest version
npm run build

# 2. Verify CLI works
steroids --version
steroids tasks list

# 3. Launch the automated runner daemon
steroids runners start --detach
# Or run in foreground to see real-time output:
steroids loop
```

**Why build first?**
- The CLI must be runnable to orchestrate work
- You can't use broken tools to build tools
- Watching the loop helps debug issues in real-time
- Compilation errors must be fixed before automation can run

**The development workflow:**
```bash
npm run build                            # Compile latest code
node dist/index.js about                 # Understand the system
node dist/index.js tasks list            # See pending tasks
node dist/index.js loop                  # Let automation handle it
# WATCH the output - debug issues as they arise
```

**Why use automation instead of manual coding?**
- Steroids is designed to orchestrate AI development work
- Using the tool tests the tool (dogfooding)
- Tasks have specifications that must be followed
- The coder/reviewer loop ensures quality
- Skipping the process bypasses review and quality gates

**The only direct work allowed:**
- Bug fixes blocking the CLI itself (can't run loop if CLI is broken)
- Documentation updates to CLAUDE.md
- Emergency patches (must be reviewed afterward)

### 0.2 Task Restart Behavior

**When manually restarting a task, the rejection count SHOULD be reset to 0.**

Rationale:
- Manual restart indicates human intervention and a fresh start
- Previous rejections may no longer be relevant after specification changes
- Prevents tasks from hitting the failure threshold (15 rejections) unfairly

```bash
# Restart a stuck task (this should reset rejection_count)
steroids tasks update <task-id> --status pending --actor human:cli
```

### 0.3 CLI-First Debugging (CRITICAL)

**NEVER use direct SQL/database access for debugging or inspection.** Always use CLI commands.

```bash
# BAD: Direct SQL access
sqlite3 .steroids/steroids.db "SELECT * FROM tasks"

# GOOD: Use CLI commands
steroids tasks list --status all
steroids sections list
steroids dispute list
steroids runners list
steroids logs list
```

**Why?**
- CLI commands provide consistent, formatted output
- CLI respects business logic and validation
- Direct SQL bypasses the application layer
- Debugging via CLI tests the actual user experience

The only exception is during migration development or emergency recovery documented in [MIGRATIONS.md](./CLI/MIGRATIONS.md).

### 1. File Size Limit

**Maximum 500 lines per file.** No exceptions.

If a file exceeds this limit, split it:
- **Entity** → Extract sub-entities or value objects
- **Use Case** → Break into smaller use cases
- **Component** → Extract sub-components
- **Repository** → Split by query complexity

### 2. Single Responsibility

Each module does **one thing well**. If you can't describe what a file does in one sentence, split it.

### 3. Dependency Injection

All dependencies must be injectable for testing:

```typescript
// GOOD: Injectable
class ListProjectsUseCase {
  constructor(private readonly repository: IProjectRepository) {}
}

// BAD: Hard-coded dependency
class ListProjectsUseCase {
  private repository = new FileProjectRepository();
}
```

### 4. Interface Segregation

Small, focused interfaces. Don't force implementations to depend on methods they don't use.

### 5. Pure Functions

Business logic should be in pure, testable functions whenever possible:

```typescript
// GOOD: Pure function
function calculateHealthScore(metrics: Metrics): number {
  return (metrics.testCoverage + metrics.buildStatus) / 2;
}

// BAD: Side effects mixed in
function calculateHealthScore(metrics: Metrics): number {
  console.log('Calculating...');  // Side effect
  db.logMetrics(metrics);         // Side effect
  return (metrics.testCoverage + metrics.buildStatus) / 2;
}
```

### 6. Everything Testable

If code can't be tested in isolation, refactor until it can. No excuses.

---

## File Size Guidelines

| Layer | Max Lines |
|-------|-----------|
| Entities | 150 |
| Value Objects | 100 |
| Use Cases | 200 |
| Repositories | 250 |
| Components | 200 |
| Routes/Commands | 100 |
| Tests | 300 |

---

## Key Patterns

### Entity Pattern

```typescript
export class Project {
  private constructor(private readonly props: ProjectProps) {}

  static create(props: Omit<ProjectProps, 'id'>): Project {
    return new Project({ id: crypto.randomUUID(), ...props });
  }

  static reconstitute(props: ProjectProps): Project {
    return new Project(props);
  }

  get id(): string { return this.props.id; }
  get name(): string { return this.props.name; }

  isHealthy(): boolean {
    return this.props.healthScore !== null && this.props.healthScore >= 80;
  }
}
```

### Value Object Pattern

```typescript
export class TaskStatus {
  private constructor(private readonly value: TaskStatusValue) {}

  static pending(): TaskStatus { return new TaskStatus(TaskStatusValue.PENDING); }
  static completed(): TaskStatus { return new TaskStatus(TaskStatusValue.COMPLETED); }

  equals(other: TaskStatus): boolean {
    return this.value === other.value;
  }
}
```

### Repository Interface

```typescript
export interface IProjectRepository {
  findById(id: string): Promise<Project | null>;
  findAll(filters?: ProjectFilters): Promise<PaginatedResult<Project>>;
  save(project: Project): Promise<void>;
  delete(id: string): Promise<void>;
}
```

### Use Case Pattern

```typescript
export class ListProjectsUseCase {
  constructor(
    private readonly repository: IProjectRepository,
    private readonly mapper: ProjectMapper
  ) {}

  async execute(input: ListProjectsInput): Promise<ListProjectsOutput> {
    const result = await this.repository.findAll(input.filters);
    return {
      projects: result.data.map(p => this.mapper.toDTO(p)),
      pagination: result.pagination,
    };
  }
}
```

---

## Shared Enums

```typescript
export enum ProjectCategory {
  SAAS_PLATFORM = 'saas_platform',
  TOOL = 'tool',
  LIBRARY = 'library',
  SERVICE = 'service',
}

export enum ProjectStatus {
  ACTIVE = 'active',
  MAINTENANCE = 'maintenance',
  ARCHIVED = 'archived',
}

export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
}

export enum TaskPriority {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

export enum HealthStatus {
  HEALTHY = 'healthy',
  WARNING = 'warning',
  CRITICAL = 'critical',
  UNKNOWN = 'unknown',
}
```

---

## Testing Requirements

### Unit Tests
- Test domain logic in isolation
- Mock all external dependencies
- Target: 80% coverage minimum

### Integration Tests
- Test repository implementations
- Test API routes with test database
- Test CLI commands with fixtures

### E2E Tests
- Critical user flows only
- Use Playwright for WebUI
- Use CLI test harness for commands

---

## The 50 Rules

See [CODE_QUALITY.md](./Docs/CODE_QUALITY.md) for the complete set of 50 coding rules covering:
- Architecture & Structure (1-10)
- Code Quality & Maintainability (11-20)
- Testing & Reliability (21-30)
- Data & State (31-40)
- Process & Team Practices (41-50)

---

## Database Migrations (CRITICAL)

**You MUST maintain the migration system when changing the database schema.**

### Migration Files Location

```
migrations/
├── manifest.json              # MUST be updated when adding migrations
├── 001_initial_schema.sql
├── 002_add_rejection_count.sql
├── 003_add_disputes_table.sql
└── ...
```

### When Changing Database Schema

1. **Create a new migration file** with the next sequential number
2. **Update `migrations/manifest.json`** with the new migration entry
3. **Include both UP and DOWN** sections in the migration
4. **Never modify existing migrations** - only add new ones
5. **Test the migration** with `./scripts/test-migration.sh`

### Manifest Format

```json
{
  "version": "X.Y.Z",
  "migrations": [
    {
      "id": 1,
      "name": "001_initial_schema",
      "file": "001_initial_schema.sql",
      "checksum": "sha256:...",
      "appliedIn": "0.1.0"
    }
  ]
}
```

**Individual projects fetch migrations from GitHub via raw URLs.** The manifest MUST be accurate or migrations will fail.

See [CLI/MIGRATIONS.md](./CLI/MIGRATIONS.md) for complete migration system documentation.

---

## Code Review Checklist

Before merging, verify:

- [ ] No file exceeds 500 lines
- [ ] All dependencies are injectable
- [ ] Business logic is in pure functions
- [ ] Tests exist and pass
- [ ] No hard-coded configuration values
- [ ] Proper error handling with typed errors
- [ ] If schema changed: migration file created and manifest updated
