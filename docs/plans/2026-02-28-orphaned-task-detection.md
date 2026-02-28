# Orphaned Task Detection & Reset Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Surface "orphaned in_progress" tasks as a named issue on the project detail page and enable the reset button to reset them to pending and trigger a wakeup.

**Architecture:** Frontend derives orphaned count from existing `project.runner` and `project.stats.in_progress` (no new API needed for detection). The API reset endpoint gains new logic after the existing `execSync` call: a server-side runner guard, a writable SQL UPDATE for orphaned tasks, and a call to the existing `wakeup()` function.

**Tech Stack:** TypeScript, React, better-sqlite3, Express, existing `wakeup()` from `src/runners/wakeup.ts`

---

### Task 1: Extend the API reset endpoint

**Files:**
- Modify: `API/src/routes/projects.ts`

**Step 1: Add missing imports**

Open `API/src/routes/projects.ts`. At the top, add two new imports:

After line 8 (`import { existsSync, ... } from 'node:fs';`), add:
```ts
import Database from 'better-sqlite3';
```

After line 19 (`import { openGlobalDatabase } from '../../../dist/runners/global-db.js';`), add:
```ts
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

**Step 3: Add orphaned-task reset after the existing CLI call**

Find this block (lines 390-393):
```ts
    // Run the CLI reset command
    const cliBin = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
    execSync(`node "${cliBin}" tasks reset --all`, { cwd: validation.path, stdio: 'pipe' });
```

Immediately after that block (before `res.json(...)`), insert:

```ts
    // Reset orphaned in_progress tasks if no runner is currently active for this project
    const { db: globalDb, close: closeGlobal } = openGlobalDatabase();
    try {
      const activeRunner = globalDb
        .prepare(`SELECT id FROM runners WHERE project_path = ? AND status = 'running' LIMIT 1`)
        .get(validation.path!) as { id: string } | undefined;

      if (!activeRunner) {
        const dbPath = join(validation.path!, '.steroids', 'steroids.db');
        if (existsSync(dbPath)) {
          const projectDb = new Database(dbPath, { fileMustExist: true });
          try {
            projectDb
              .prepare(`UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'in_progress'`)
              .run();
          } finally {
            projectDb.close();
          }
        }
      }
    } finally {
      closeGlobal();
    }

    // Trigger wakeup so a runner picks up the newly-pending tasks
    await wakeup({ quiet: true });
```

**Step 4: Build and verify no TypeScript errors**

```bash
cd /System/Volumes/Data/.internal/projects/Projects/steroids-cli
npm run build 2>&1 | grep -E "^.*error TS" | grep -v "node_modules"
```

Expected: no lines printed.

**Step 5: Commit**

```bash
git add API/src/routes/projects.ts
git commit -m "feat: reset orphaned in_progress tasks and trigger wakeup on project reset"
```

---

### Task 2: Add orphaned issue to the project detail UI

**Files:**
- Modify: `WebUI/src/pages/ProjectDetailPage.tsx`

**Step 1: Add `orphanedCount` derivation**

Find line 584 (just before `const canResetProject = Boolean(`). Insert immediately before it:

```ts
const orphanedCount = !project?.runner && (project?.stats?.in_progress ?? 0) > 0
  ? (project?.stats?.in_progress ?? 0)
  : 0;
```

**Step 2: Update `canResetProject`**

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
    orphanedCount > 0
);
```

**Step 3: Add orphaned row to `issueRows`**

Find the `issueRows` array (line 592). Add the orphaned entry as the **first element**, before `failed_retries`:

```ts
  {
    key: 'orphaned',
    label: 'Orphaned tasks',
    count: orphanedCount,
    singleTaskId: null,
    listPath: `/project/${encodeURIComponent(decodedPath)}/tasks?status=in_progress`,
    icon: 'fa-circle-pause',
    badgeClasses: 'bg-warning-soft text-warning',
  },
```

Leave all existing entries unchanged.

**Step 4: Update reset button description**

Find (line 847):
```tsx
<p className="text-xs text-text-muted text-center mt-1.5">Resets failed, disputed and stale tasks to pending</p>
```

Replace with:
```tsx
<p className="text-xs text-text-muted text-center mt-1.5">Resets failed, disputed, stale, and orphaned tasks to pending</p>
```

**Step 5: Build the web UI**

```bash
cd /System/Volumes/Data/.internal/projects/Projects/steroids-cli/WebUI
npm run build 2>&1 | grep -iE "error" | grep -v "node_modules"
```

Expected: no errors.

**Step 6: Verify visually**

1. Ensure `steroids web` is running
2. Navigate to a project that has `in_progress` tasks and no active runner (e.g., flatu)
3. Check the issues section shows "Orphaned tasks" with the correct count
4. Confirm the Reset button is enabled
5. Click Reset — tasks should flip to `pending` and a runner should start

**Step 7: Commit**

```bash
git add WebUI/src/pages/ProjectDetailPage.tsx
git commit -m "feat: show orphaned tasks as project issue and enable reset button"
```

---

### Task 3: Release

Follow the release runbook in AGENTS.md:

```bash
npm version patch
git push && git push --tags
npm publish
npm i -g steroids-cli@latest
steroids web stop && steroids web
```

Create the GitHub release with notes covering:
- Orphaned task detection in project issues
- Reset button now handles orphaned tasks
- Wakeup triggered after reset
