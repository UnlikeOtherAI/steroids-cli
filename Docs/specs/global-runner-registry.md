# Global Runner Registry

> Fix the runner wakeup system to properly track and restart runners across all registered projects.

## Review Status

- **Codex Review:** APPROVED with recommendations (incorporated below)
- **Gemini Review:** APPROVED with recommendations (incorporated below)

## Problem Statement

The current runner system has critical bugs:

1. **`loop` command ignores `--project` flag** - It's not implemented, so wakeup starts runners in the wrong directory
2. **Cron wakeup uses `process.cwd()`** - When cron runs, cwd is `/` or `$HOME`, so it can't find projects
3. **No global project registry** - The system doesn't know which projects exist or need runners

**Result:** Runners die and are never restarted. The cron wakeup is ineffective.

## Solution Overview

1. **Global project registry** at `~/.steroids/projects.json`
2. **Automatic registration** when `steroids init` is run
3. **`loop --project` support** to run in a specific project directory
4. **Wakeup checks all registered projects** instead of relying on cwd

## Database Schema

### Global Database (`~/.steroids/steroids.db`)

Add a `projects` table:

```sql
CREATE TABLE IF NOT EXISTS projects (
    path TEXT PRIMARY KEY,
    name TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    enabled INTEGER NOT NULL DEFAULT 1
);
```

Update runners table to ensure project tracking:

```sql
-- Existing columns (already correct)
CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle',
    pid INTEGER,
    project_path TEXT,           -- Links to projects.path
    current_task_id TEXT,
    started_at TEXT,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Schema Version

Bump `GLOBAL_SCHEMA_VERSION` from `'1'` to `'2'` in `src/runners/global-db.ts`.

## CLI Changes

### `steroids init` - Auto-register project

When initializing a project, register it globally:

```typescript
// In init command, after creating .steroids/
registerProject(process.cwd(), projectName);
```

### `steroids loop --project <path>`

Add `--project` flag to loop command:

```
Usage: steroids loop [options]

Options:
  --project <path>    Run loop for specific project directory
  --once              Run one iteration only
  --dry-run           Show what would be done
  -h, --help          Show help
```

**Behavior:**
1. If `--project` provided, `chdir` to that directory before starting
2. Validate project exists and has `.steroids/steroids.db`
3. Run loop in that project context

### `steroids projects` - New command

Manage the global project registry:

```
Usage: steroids projects <subcommand> [options]

Subcommands:
  list                List registered projects
  add <path>          Register a project manually
  remove <path>       Unregister a project
  enable <path>       Enable a project for wakeup
  disable <path>      Disable a project (skip in wakeup)
  prune               Remove projects that no longer exist

Examples:
  steroids projects list
  steroids projects add ~/code/my-app
  steroids projects remove ~/old-project
  steroids projects disable ~/code/on-hold
  steroids projects prune
```

### `steroids runners wakeup` - Check all projects

Update wakeup to iterate over ALL registered projects:

```typescript
function wakeup(): WakeupResult[] {
  const projects = getRegisteredProjects();
  const results: WakeupResult[] = [];

  for (const project of projects) {
    if (!project.enabled) continue;
    if (!existsSync(project.path)) continue;

    if (projectHasPendingWork(project.path)) {
      if (!hasActiveRunner(project.path)) {
        startRunner(project.path);
        results.push({ project: project.path, action: 'started' });
      }
    }
  }

  return results;
}
```

## Implementation Details

### Project Registration

```typescript
// src/runners/projects.ts

export interface RegisteredProject {
  path: string;
  name: string | null;
  registered_at: string;
  last_seen_at: string;
  enabled: boolean;
}

export function registerProject(path: string, name?: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(`
      INSERT INTO projects (path, name, registered_at, last_seen_at, enabled)
      VALUES (?, ?, datetime('now'), datetime('now'), 1)
      ON CONFLICT(path) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        last_seen_at = datetime('now')
    `).run(path, name ?? null);
  } finally {
    close();
  }
}

export function getRegisteredProjects(): RegisteredProject[] {
  const { db, close } = openGlobalDatabase();
  try {
    return db.prepare('SELECT * FROM projects WHERE enabled = 1').all();
  } finally {
    close();
  }
}

export function unregisterProject(path: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare('DELETE FROM projects WHERE path = ?').run(path);
  } finally {
    close();
  }
}

export function disableProject(path: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare('UPDATE projects SET enabled = 0 WHERE path = ?').run(path);
  } finally {
    close();
  }
}

export function enableProject(path: string): void {
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare('UPDATE projects SET enabled = 1 WHERE path = ?').run(path);
  } finally {
    close();
  }
}

export function pruneProjects(): number {
  const { db, close } = openGlobalDatabase();
  try {
    const projects = db.prepare('SELECT path FROM projects').all();
    let removed = 0;
    for (const p of projects) {
      if (!existsSync(p.path) || !existsSync(join(p.path, '.steroids'))) {
        db.prepare('DELETE FROM projects WHERE path = ?').run(p.path);
        removed++;
      }
    }
    return removed;
  } finally {
    close();
  }
}
```

### Loop Command Changes

```typescript
// src/commands/loop.ts

export async function loopCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      once: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      project: { type: 'string' },  // NEW
    },
    allowPositionals: false,
  });

  // NEW: Change to project directory if specified
  if (values.project) {
    const projectPath = resolve(values.project);
    if (!existsSync(join(projectPath, '.steroids', 'steroids.db'))) {
      console.error(`Not a steroids project: ${projectPath}`);
      process.exit(1);
    }
    process.chdir(projectPath);
  }

  // ... rest of loop logic
}
```

### Wakeup Changes

```typescript
// src/runners/wakeup.ts

export function wakeup(options: WakeupOptions = {}): WakeupResult[] {
  const results: WakeupResult[] = [];

  // Get all registered projects
  const projects = getRegisteredProjects();

  for (const project of projects) {
    // Skip disabled projects
    if (!project.enabled) continue;

    // Skip if project directory doesn't exist
    if (!existsSync(project.path)) {
      results.push({
        project: project.path,
        action: 'skipped',
        reason: 'Directory not found',
      });
      continue;
    }

    // Check for pending work
    if (!projectHasPendingWork(project.path)) {
      continue;
    }

    // Check if runner already active for this project
    if (hasActiveRunnerForProject(project.path)) {
      continue;
    }

    // Start runner
    if (!options.dryRun) {
      const result = startRunner(project.path);
      results.push({
        project: project.path,
        action: 'started',
        pid: result?.pid,
      });
    } else {
      results.push({
        project: project.path,
        action: 'would_start',
      });
    }
  }

  return results;
}
```

## Migration Path

For existing projects that haven't been registered:

1. **On first wakeup after upgrade:** Scan common directories (`~/Projects`, `~/code`, etc.) for `.steroids` folders
2. **Auto-register found projects** with `enabled = true`
3. **Log discovered projects** so user knows what was found

Or simpler: require manual registration via `steroids projects add <path>`.

## Implementation Tasks

1. **Schema update**: Add `projects` table to global database, bump version
2. **Project registry module**: Create `src/runners/projects.ts` with CRUD functions
3. **Init integration**: Register project globally when `steroids init` runs
4. **Loop --project flag**: Add flag and chdir logic to loop command
5. **Projects command**: New command for managing project registry
6. **Wakeup overhaul**: Iterate over all registered projects, not cwd
7. **Runner tracking**: Ensure one runner per project, track by project_path
8. **Prune command**: Remove stale projects that no longer exist

## Testing

- Register a project, verify it appears in `steroids projects list`
- Run `steroids runners wakeup` from any directory, verify it finds registered projects
- Start loop with `--project /path/to/project`, verify it runs in correct directory
- Disable a project, verify wakeup skips it
- Delete a project directory, run prune, verify it's removed from registry

## Edge Cases

- **Project moved**: Path in registry is stale → prune removes it
- **Multiple runners same project**: Only one allowed, wakeup checks first
- **Project on external drive**: Works when mounted, skipped when not
- **Symlinks**: Resolve to canonical path before storing

## Success Criteria

After implementation:
1. `steroids init` registers projects globally
2. `steroids runners cron install` + time passing = runners auto-restart
3. `steroids projects list` shows all tracked projects
4. `steroids runners wakeup` from any directory works correctly

---

## Review Feedback (Codex + Gemini)

### Must Fix (Incorporated into Tasks)

1. **Schema Upgrade Logic**: Task 1 must implement upgrade logic from version 1→2, not just initial creation. Check existing version and run `ALTER TABLE` or `CREATE TABLE IF NOT EXISTS` for the new `projects` table.

2. **Missing `enableProject()` Function**: Task 2 must include `enableProject(path)` in addition to `disableProject()`.

3. **Path Normalization**: Task 2 must normalize paths before storing:
   ```typescript
   function normalizePath(p: string): string {
     const resolved = resolve(p);
     const realPath = realpathSync(resolved); // Resolves symlinks
     return realPath.replace(/\/+$/, '');     // Remove trailing slashes
   }
   ```

4. **Loop + Daemon Integration**: Task 4 must ensure `loop --project` passes `projectPath` to daemon registration so `runners` table has correct `project_path`.

5. **Wakeup Return Type**: Task 6 changes return type from `WakeupResult` to `WakeupResult[]`.

6. **Global DB Permissions**: Set `0600` permissions on `~/.steroids/steroids.db`:
   ```typescript
   chmodSync(dbPath, 0o600);
   ```

### Should Fix (During Implementation)

7. **Projects List Output**: Include runner status and last-seen time:
   ```
   PATH                        STATUS    RUNNER    LAST SEEN
   ~/code/project-a            enabled   active    2 min ago
   ~/code/project-b            enabled   -         1 hour ago
   ```

8. **Confirmation for Destructive Actions**: Add `--yes` flag for `steroids projects remove`.

### Future Considerations (Not Blocking)

9. **UUID Primary Key**: Consider adding stable `id` column for future path changes.

10. **Per-Project Parallel Runners**: Current design is single-runner globally. Document this limitation.
