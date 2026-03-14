# Task Dependencies, Description Field, and Project Reset

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add task-level dependencies, expose the existing task description column in CLI/WebUI, add a project reset command, and document task authoring best practices in the LLM reference.

**Architecture:** Task dependencies mirror the existing section dependency pattern (new join table, circular-dependency check, pending-dependency query). The description field already exists in the DB schema — just needs CLI plumbing and WebUI display. Project reset is a new CLI command that resets all tasks to pending and clears audit/invocation history.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Node.js parseArgs, React (WebUI)

---

### Task 1: Migration — task_dependencies table

**Files:**
- Create: `migrations/027_add_task_dependencies.sql`
- Modify: `migrations/manifest.json`

**Step 1: Create migration file**

```sql
-- UP
CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(task_id, depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies(depends_on_task_id);

-- DOWN
DROP TABLE IF EXISTS task_dependencies;
```

**Step 2: Update manifest.json**

Add entry with id 27 and the filename. Bump `latestDbVersion` to 27.

**Step 3: Build and test migration**

Run: `npm run build && node dist/index.js health`
Expected: Migration 27 applied, health check passes.

**Step 4: Commit**

```bash
git add migrations/027_add_task_dependencies.sql migrations/manifest.json
git commit -m "feat: add task_dependencies migration (027)"
```

---

### Task 2: DB query functions for task dependencies

**Files:**
- Modify: `src/database/queries.ts` — add CRUD + dependency check functions

**Step 1: Add `addTaskDependency()` function**

Pattern: mirror `addSectionDependency()` (queries.ts:403-425).
- Accept `db, taskId, dependsOnTaskId`
- Check self-dependency (`taskId === dependsOnTaskId`)
- Check circular dependency (walk the task dependency graph)
- INSERT into `task_dependencies`
- Return the created row

**Step 2: Add `removeTaskDependency()` function**

DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?

**Step 3: Add `getTaskDependencies()` function**

SELECT the depends_on tasks for a given task_id. Return `Task[]`.

**Step 4: Add `hasTaskDependenciesMet()` function**

Query: for a given task_id, check if ALL depends_on tasks are in terminal status (`completed, disputed, skipped, partial`). Return boolean.

Note: `blocked_error` and `blocked_conflict` are NOT considered "met" — a blocked dependency means the dependent task cannot proceed.

```sql
SELECT COUNT(*) as unmet FROM task_dependencies td
JOIN tasks t ON td.depends_on_task_id = t.id
WHERE td.task_id = ?
AND t.status NOT IN ('completed', 'disputed', 'skipped', 'partial')
```

If unmet > 0, return false.

**Step 5: Add `wouldCreateCircularTaskDependency()` function**

BFS/DFS walk from `dependsOnTaskId` through task_dependencies to check if `taskId` is reachable (which would create a cycle).

**Step 6: Build**

Run: `npm run build`
Expected: Clean compile.

**Step 7: Commit**

```bash
git add src/database/queries.ts
git commit -m "feat: task dependency query functions"
```

---

### Task 3: Integrate task dependencies into task selector

**Files:**
- Modify: `src/orchestrator/task-selector.ts` — update `canSelectTask()` at line 346

**Step 1: Import `hasTaskDependenciesMet` from queries**

**Step 2: Update `canSelectTask()`**

Current (line 346-353):
```typescript
function canSelectTask(db, task): boolean {
  return hasDependenciesMet(db, task.section_id);
}
```

New:
```typescript
function canSelectTask(db, task): boolean {
  if (!hasDependenciesMet(db, task.section_id)) return false;
  if (!hasTaskDependenciesMet(db, task.id)) return false;
  return true;
}
```

**Step 3: Build and verify**

Run: `npm run build`

**Step 4: Commit**

```bash
git add src/orchestrator/task-selector.ts
git commit -m "feat: task selector respects task-level dependencies"
```

---

### Task 4: CLI commands for task dependencies

**Files:**
- Modify: `src/commands/tasks.ts` — add `depends-on` and `no-depends-on` subcommands
- Modify: `src/commands/tasks.ts` — add `--depends-on` flag to `tasks add`

**Step 1: Add `tasks depends-on <taskA> <taskB>` subcommand**

Pattern: mirror `sections-commands.ts:addDependency()` (lines 208-276).
- Parse two positional args (task ID prefixes)
- Resolve both tasks via `getTask()` or prefix match
- Call `addTaskDependency(db, taskA.id, taskB.id)`
- Print confirmation

**Step 2: Add `tasks no-depends-on <taskA> <taskB>` subcommand**

- Parse two positional args
- Call `removeTaskDependency(db, taskA.id, taskB.id)`
- Print confirmation

**Step 3: Add `--depends-on <taskId>` flag to `tasks add`**

In `addTask()` options, add:
```typescript
'depends-on': { type: 'string' },
```

After task creation, if `--depends-on` is provided, call `addTaskDependency(db, newTask.id, resolvedDepId)`.

**Step 4: Show dependencies in `tasks audit <id>`**

After displaying task details, query and display task dependencies:
```
Dependencies:
  - [abc123] Initialize monorepo (completed)
```

**Step 5: Build and test**

Run: `npm run build`
Test: `node dist/index.js tasks depends-on --help`

**Step 6: Commit**

```bash
git add src/commands/tasks.ts
git commit -m "feat: CLI commands for task-level dependencies"
```

---

### Task 5: Expose description field in CLI

**Files:**
- Modify: `src/commands/tasks.ts` — add `--description` flag to `tasks add` and `tasks update`
- Modify: `src/database/queries.ts` — pass description to INSERT in `createTask()`

**Step 1: Add `description` to `createTask()` options**

In queries.ts `createTask()` (line 496), add `description?: string` to the options type. Include in INSERT statement.

**Step 2: Add `--description` flag to `tasks add`**

In tasks.ts `addTask()`, add to parseArgs options:
```typescript
description: { type: 'string', short: 'd' },
```

Pass to `createTask(db, title, { ..., description })`.

**Step 3: Add `--description` flag to `tasks update`**

Allow updating description on existing tasks:
```sql
UPDATE tasks SET description = ?, updated_at = datetime('now') WHERE id = ?
```

**Step 4: Show description in `tasks audit <id>`**

Display description field in the audit output if present.

**Step 5: Build**

Run: `npm run build`

**Step 6: Commit**

```bash
git add src/commands/tasks.ts src/database/queries.ts
git commit -m "feat: expose task description in CLI (add/update/audit)"
```

---

### Task 6: Project reset command

**Files:**
- Create: `src/commands/project-reset.ts`
- Modify: `src/commands/index.ts` — register `reset-project` command

**Step 1: Implement `resetProject()` function**

```typescript
export async function resetProject(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
    },
  });

  // 1. Confirm unless --yes
  if (!values.yes) {
    // Interactive confirmation prompt
  }

  // 2. Stop all runners for this project
  // 3. In a transaction:
  //    a. DELETE FROM task_invocations
  //    b. DELETE FROM audit
  //    c. DELETE FROM disputes
  //    d. UPDATE tasks SET status='pending', rejection_count=0, failure_count=0, merge_failure_count=0, start_commit_sha=NULL
  //    e. DELETE FROM task_dependencies (optional — maybe keep)
  //    f. Clean up workspace pool slots (reset dirty flag)
  // 4. Print summary
}
```

Key decisions:
- Keep tasks, sections, section dependencies, task dependencies intact
- Only clear execution state (audit, invocations, disputes, task status)
- Stop runners first to prevent races
- Require `-y` for non-interactive use

**Step 2: Register in command router**

In `src/commands/index.ts`, add `'reset-project'` to the command map pointing to `resetProject`.

**Step 3: Build and test**

Run: `npm run build`
Test: `node dist/index.js reset-project --help`

**Step 4: Commit**

```bash
git add src/commands/project-reset.ts src/commands/index.ts
git commit -m "feat: reset-project command to clear execution state"
```

---

### Task 7: Update LLM reference with all new features

**Files:**
- Modify: `src/commands/llm-content.ts`

**Step 1: Add task dependencies to STATE MACHINE section**

After the section dependencies explanation, add:

```
## TASK DEPENDENCIES

Tasks can declare dependencies on other tasks within or across sections:
  steroids tasks depends-on <A> <B>     → Task A depends on Task B

Effect: Task B must reach a terminal status (completed, disputed, skipped, partial)
before the runner will pick up Task A. Unlike section dependencies which block entire
sections, task dependencies provide fine-grained ordering within sections.

Commands:
  steroids tasks depends-on <A> <B>          # add dependency
  steroids tasks no-depends-on <A> <B>       # remove dependency
  steroids tasks audit <id>                   # shows dependencies in output
```

**Step 2: Add task description to KEY COMMANDS section**

Update the `tasks add` entry:
```
steroids tasks add "Title" --section <id> --source <spec-file>
steroids tasks add "Title" --section <id> --source spec.md --description "Setup the monorepo..."
steroids tasks add "Title" --section <id> --source spec.md --file src/foo.ts --line 42
```

Add to options:
```
  --description <text>  Free-text description (max 4000 chars) shown to coder/reviewer
                        Use to provide context, file anchors with content hashes, or
                        pointers the agent needs to find the right code locations.
```

**Step 3: Add project reset to COMMON OPERATIONS**

```
### Reset project (start fresh)
steroids reset-project -y              # reset all tasks to pending, clear history
```

**Step 4: Add TASK AUTHORING BEST PRACTICES section**

```
## TASK AUTHORING BEST PRACTICES

### Specification Files
Write focused markdown specs in a `specs/` directory. Each spec should contain:
- Purpose and requirements
- Acceptance criteria
- Code examples or patterns to follow
- References to existing codebase patterns

### File Anchoring
Anchor tasks to specific files so the coder knows exactly where to work:
  steroids tasks add "Fix auth" --section <id> --source specs/auth.md --file src/auth.ts --line 42

The --file must be committed in git. Steroids captures the commit SHA and content
hash at creation time, so the coder/reviewer can detect if the file has drifted.

### Content Hashing for Precision
For large specs, include content hashes in the description to help agents locate
the exact section they need to work on:

  1. Generate a hash of the relevant code block:
     sha256sum <<< "function processPayment()"   → a1b2c3...

  2. Reference it in the task description:
     --description "Modify processPayment() [sha256:a1b2c3] in src/billing.ts to add retry logic"

  3. The agent can verify it found the right code by hashing and comparing.

### Description Field
Use --description for context that doesn't belong in the spec file:
- Which functions/classes to modify
- Content hashes of target code blocks
- Integration notes ("this task's output is consumed by task X")
- Constraints ("must not change the public API surface")

### Task Ordering with Dependencies
When tasks in the same section must run in sequence:
  steroids tasks depends-on <later-task> <earlier-task>

Example: "Set up Prisma" depends on "Initialize monorepo" — the monorepo
must exist before database tooling can be added.

### Sizing
Each task should be PR-sized (see TASK SIZING section above).
```

**Step 5: Build**

Run: `npm run build`

**Step 6: Commit**

```bash
git add src/commands/llm-content.ts
git commit -m "docs: add task dependencies, description, reset, and authoring tips to LLM reference"
```

---

### Task 8: WebUI — show description and task dependencies

**Files:**
- Modify: `WebUI/src/types/task.ts` — add `description` and `dependencies` to types
- Modify: `WebUI/src/pages/TaskDetailPage.tsx` — display description and dependencies
- Modify: `/Volumes/DevCache/.steroids/webui/API/src/routes/tasks.ts` — include description and dependencies in API response

**Step 1: Add `description` to API task detail query**

Add `t.description` to the SELECT in the task detail endpoint.

**Step 2: Add dependencies endpoint or inline query**

After fetching task details, query task_dependencies and join with tasks to get dependency info:
```sql
SELECT t.id, t.title, t.status FROM task_dependencies td
JOIN tasks t ON td.depends_on_task_id = t.id
WHERE td.task_id = ?
```

Include in response as `dependencies: Array<{id, title, status}>`.

**Step 3: Update WebUI types**

Add to `TaskDetails`:
```typescript
description: string | null;
dependencies: Array<{id: string; title: string; status: TaskStatus}>;
```

**Step 4: Display in TaskDetailPage**

After the metadata section and before stats cards, show:
- Description in a collapsible panel (if present)
- Dependencies as a list with status badges (if any)

**Step 5: Build WebUI**

Run: `cd WebUI && npm run build`

**Step 6: Commit**

```bash
git add WebUI/src/types/task.ts WebUI/src/pages/TaskDetailPage.tsx
git commit -m "feat: show task description and dependencies in WebUI"
```

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Circular task dependency | Reject with error, same as section deps |
| Self-dependency | Reject with error |
| Dependency on task in different project | Not possible — tasks scoped to project DB |
| Dependency on deleted task | CASCADE delete removes the dependency row |
| `reset-project` with active runners | Stop runners first, then reset |
| Description > 4000 chars | DB CHECK constraint rejects, CLI shows error |
| Task dependency + section dependency conflict | Both must be met — they're additive gates |

## Non-Goals

- Cross-project task dependencies
- Automatic dependency inference from spec files
- Dependency visualization (graph command) — follow-up task
- WebUI editing of dependencies — CLI only for now
