# Orphaned Task Detection & Reset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface "orphaned in_progress" tasks as a named issue on the project detail page and enable the reset button to reset them to pending and trigger a wakeup.

**Architecture:** Detection is server-side (single source of truth) — the API project response gains an `orphaned_in_progress` count computed using existing `hasActiveRunnerForProject` + `hasActiveParallelSessionForProject` helpers. The UI reads this field. The reset endpoint uses the same helpers as the guard, clears task locks in a transaction, then triggers wakeup.

**Tech Stack:** TypeScript, React, better-sqlite3, Express, `hasActiveRunnerForProject` + `hasActiveParallelSessionForProject` from `src/runners/wakeup-checks.ts`, existing `wakeup()` from `src/runners/wakeup.ts`

---

### Task 1: Add `orphaned_in_progress` to the API project response

**Files:**
- Modify: `API/src/routes/projects.ts`

**Context:** `getProjectStats()` (around line 43) returns stats per project. The project response type (around line 117) needs a new optional field. Both `GET /api/projects` (line 146) and `GET /api/projects/status` (line 479) return project objects.

`hasActiveRunnerForProject` and `hasActiveParallelSessionForProject` are available in `src/runners/wakeup-checks.ts` — import them from `'../../../dist/runners/wakeup-checks.js'`.

**Step 1: Add import for active-runner helpers**

At the top of `API/src/routes/projects.ts`, after the existing `openGlobalDatabase` import (line 19), add:

```ts
import { hasActiveRunnerForProject, hasActiveParallelSessionForProject } from '../../../dist/runners/wakeup-checks.js';
```

**Step 2: Add `orphaned_in_progress` to the project response type**

Find the `ProjectResponse` interface (around line 117, the one with `runner?: { ... } | null`). Add the field:

```ts
orphaned_in_progress: number;
```

**Step 3: Compute orphaned count when building the project list**

In `GET /api/projects` (line 146), where each project is assembled into the response object (look for where `runner: runnerInfo` is set, around line 185-195), add:

```ts
const hasActiveRunner = hasActiveRunnerForProject(project.path) || hasActiveParallelSessionForProject(project.path);
const orphanedInProgress = hasActiveRunner ? 0 : (projectStats.stats.in_progress ?? 0);
```

Then include in the response object:
```ts
orphaned_in_progress: orphanedInProgress,
```

**Step 4: Do the same in `GET /api/projects/status`**

Find the equivalent spot in the `/projects/status` handler (around line 479-540). Apply the same pattern — compute `orphanedInProgress` using the same two helpers and include it in the response.

**Step 5: Build and verify**

```bash
cd /System/Volumes/Data/.internal/projects/Projects/steroids-cli
npm run build 2>&1 | grep -E "^.*error TS" | grep -v "node_modules"
```

Expected: no errors.

**Step 6: Smoke-test the endpoint**

```bash
curl -s "http://localhost:3500/api/projects" | python3 -c "
import json, sys
projects = json.load(sys.stdin)['projects']
for p in projects[:3]:
    print(p.get('name') or p['path'].split('/')[-1], '→ orphaned_in_progress:', p.get('orphaned_in_progress', 'MISSING'))
"
```

Expected: field present on all projects (0 for active ones).

**Step 7: Commit**

```bash
git add API/src/routes/projects.ts
git commit -m "feat: add orphaned_in_progress count to project API response"
```

---

### Task 2: Update the Project TypeScript type in the WebUI

**Files:**
- Modify: `WebUI/src/types/index.ts`

**Step 1: Add the field to the Project interface**

Find the `Project` interface in `WebUI/src/types/index.ts` (around line 9). Add:

```ts
orphaned_in_progress?: number;
```

**Step 2: Build and verify**

```bash
cd /System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI
npm run build 2>&1 | grep -iE "^.*error" | grep -v "node_modules"
```

Expected: no errors.

**Step 3: Commit**

```bash
git add WebUI/src/types/index.ts
git commit -m "feat: add orphaned_in_progress to Project type"
```

---

### Task 3: Add orphaned issue to the project detail UI

**Files:**
- Modify: `WebUI/src/pages/ProjectDetailPage.tsx`

**Step 1: Update `canResetProject`**

Find (lines 585-590):
```ts
const canResetProject = Boolean(
  project?.isBlocked ||
    (project?.stats?.failed ?? 0) > 0 ||
    (project?.stats?.disputed ?? 0) > 0 ||
    (project?.stats?.skipped ?? 0) > 0
);
```

Replace with:
```ts
const canResetProject = Boolean(
  project?.isBlocked ||
    (project?.stats?.failed ?? 0) > 0 ||
    (project?.stats?.disputed ?? 0) > 0 ||
    (project?.stats?.skipped ?? 0) > 0 ||
    (project?.orphaned_in_progress ?? 0) > 0
);
```

**Step 2: Add orphaned row to `issueRows`**

Find the `issueRows` array (line 592). Add the orphaned entry as the **first element**:

```ts
  {
    key: 'orphaned',
    label: 'Orphaned tasks',
    count: project?.orphaned_in_progress ?? 0,
    singleTaskId: null,
    listPath: `/project/${encodeURIComponent(decodedPath)}/tasks?status=in_progress`,
    icon: 'fa-circle-pause',
    badgeClasses: 'bg-warning-soft text-warning',
  },
```

**Step 3: Update reset button description**

Find (line ~847):
```tsx
<p className="text-xs text-text-muted text-center mt-1.5">Resets failed, disputed and stale tasks to pending</p>
```

Replace with:
```tsx
<p className="text-xs text-text-muted text-center mt-1.5">Resets failed, disputed, stale, and orphaned tasks to pending</p>
```

**Step 4: Build the web UI**

```bash
cd /System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI
npm run build 2>&1 | grep -iE "^.*error" | grep -v "node_modules"
```

Expected: no errors.

**Step 5: Commit**

```bash
git add WebUI/src/pages/ProjectDetailPage.tsx
git commit -m "feat: show orphaned tasks as project issue and enable reset button"
```

---

### Task 4: Extend the reset endpoint with lock cleanup and wakeup

**Files:**
- Modify: `API/src/routes/projects.ts`

**Step 1: Add remaining imports**

Add these imports (not yet present after Task 1):

```ts
import Database from 'better-sqlite3';
import { wakeup } from '../../../dist/runners/wakeup.js';
```

**Step 2: Make reset handler async**

Find line 366:
```ts
router.post('/projects/reset', (req: Request, res: Response) => {
```

Change to:
```ts
router.post('/projects/reset', async (req: Request, res: Response) => {
```

**Step 3: Add orphaned task reset after the existing CLI call**

Find the block ending with:
```ts
    execSync(`node "${cliBin}" tasks reset --all`, { cwd: validation.path, stdio: 'pipe' });
```

Immediately after it (before `res.json(...)`), insert:

```ts
    // Extract validated path once to avoid repeated non-null assertions
    const projectPath = validation.path as string;

    // Reset orphaned in_progress tasks only when no active runner or parallel session exists
    const hasActiveRunner = hasActiveRunnerForProject(projectPath) || hasActiveParallelSessionForProject(projectPath);
    if (!hasActiveRunner) {
      const dbPath = join(projectPath, '.steroids', 'steroids.db');
      if (existsSync(dbPath)) {
        const projectDb = new Database(dbPath, { fileMustExist: true });
        try {
          projectDb.transaction(() => {
            // Clear locks first — 60-min TTL would block new runner pickup otherwise
            projectDb
              .prepare(`DELETE FROM task_locks WHERE task_id IN (SELECT id FROM tasks WHERE status = 'in_progress')`)
              .run();
            projectDb
              .prepare(`UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'in_progress'`)
              .run();
          })();
        } finally {
          projectDb.close();
        }
      }
    }

    // Attempt wakeup so a runner picks up newly-pending tasks (no-op if daemon is paused)
    await wakeup({ quiet: true });
```

**Step 4: Write a failing unit test**

Create `tests/api-orphaned-task-reset.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test the lock cleanup + status reset logic in isolation
// (mirrors what the reset endpoint does)

function setupProjectDb(dir: string): Database.Database {
  const db = new Database(join(dir, 'steroids.db'));
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_locks (
      task_id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('orphaned task reset logic', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'steroids-test-'));
    db = setupProjectDb(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });

  it('resets in_progress tasks to pending and clears their locks', () => {
    db.prepare(`INSERT INTO tasks (id, status) VALUES ('t1', 'in_progress'), ('t2', 'pending'), ('t3', 'failed')`).run();
    db.prepare(`INSERT INTO task_locks (task_id, runner_id, expires_at) VALUES ('t1', 'r1', datetime('now', '+60 minutes'))`).run();

    // Simulate the reset transaction
    db.transaction(() => {
      db.prepare(`DELETE FROM task_locks WHERE task_id IN (SELECT id FROM tasks WHERE status = 'in_progress')`).run();
      db.prepare(`UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'in_progress'`).run();
    })();

    const t1 = db.prepare(`SELECT status FROM tasks WHERE id = 't1'`).get() as { status: string };
    const t2 = db.prepare(`SELECT status FROM tasks WHERE id = 't2'`).get() as { status: string };
    const t3 = db.prepare(`SELECT status FROM tasks WHERE id = 't3'`).get() as { status: string };
    const lock = db.prepare(`SELECT task_id FROM task_locks WHERE task_id = 't1'`).get();

    expect(t1.status).toBe('pending');      // was in_progress → reset
    expect(t2.status).toBe('pending');      // already pending → unchanged
    expect(t3.status).toBe('failed');       // failed → not touched
    expect(lock).toBeUndefined();           // lock cleared
  });

  it('does not touch tasks with other statuses', () => {
    db.prepare(`INSERT INTO tasks (id, status) VALUES ('t1', 'review'), ('t2', 'completed'), ('t3', 'disputed')`).run();

    db.transaction(() => {
      db.prepare(`DELETE FROM task_locks WHERE task_id IN (SELECT id FROM tasks WHERE status = 'in_progress')`).run();
      db.prepare(`UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'in_progress'`).run();
    })();

    const statuses = db.prepare(`SELECT id, status FROM tasks ORDER BY id`).all() as Array<{ id: string; status: string }>;
    expect(statuses.map(r => r.status)).toEqual(['review', 'completed', 'disputed']);
  });
});
```

**Step 5: Run the test to confirm it passes**

```bash
cd /System/Volumes/Data/.internal/projects/Projects/steroids-cli
npx jest tests/api-orphaned-task-reset.test.ts --no-coverage 2>&1 | tail -20
```

Expected: 2 tests pass.

**Step 6: Build and verify no TypeScript errors**

```bash
npm run build 2>&1 | grep -E "^.*error TS" | grep -v "node_modules"
```

Expected: no errors.

**Step 7: Verify visually**

1. Ensure `steroids web` is running
2. Navigate to the flatu project (which has orphaned tasks)
3. Confirm "Orphaned tasks" issue row appears with correct count
4. Confirm Reset button is enabled
5. Click Reset — tasks should flip to `pending` and a runner start

**Step 8: Commit**

```bash
git add API/src/routes/projects.ts tests/api-orphaned-task-reset.test.ts
git commit -m "feat: reset orphaned tasks with lock cleanup and wakeup on project reset"
```

---

### Task 5: Release

Follow the release runbook in AGENTS.md:

```bash
npm version patch
git push && git push --tags
npm publish
npm i -g steroids-cli@latest
steroids web stop && steroids web
```

Create the GitHub release with notes:
- Orphaned task detection in project issues (server-side, parallel-mode safe)
- Reset button enabled for orphaned tasks; clears locks before resetting
- Wakeup triggered after reset
