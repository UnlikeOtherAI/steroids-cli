# Update Runners List to Show Section Info

## Problem
The `steroids runners list` command should clearly show which section each runner is working on, and warn about potential conflicts.

## Files to Modify
- `src/commands/runners.ts` - Enhance list display

## Implementation

### Update runList() in runners.ts

```typescript
async function runList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      project: { type: 'string', short: 'p' },  // Filter by project
    },
    allowPositionals: false,
  });

  // ... help handling ...

  const runners = listRunners();

  // Filter by project if specified
  const filteredRunners = values.project
    ? runners.filter(r => r.project_path === values.project || r.project_path?.includes(values.project as string))
    : runners;

  if (values.json) {
    // Enrich with section names
    const enrichedRunners = await enrichRunnersWithSectionNames(filteredRunners);
    console.log(JSON.stringify({ runners: enrichedRunners }, null, 2));
    return;
  }

  if (filteredRunners.length === 0) {
    console.log('No runners registered');
    return;
  }

  // Group by project for clearer display
  const byProject = new Map<string, Runner[]>();
  for (const runner of filteredRunners) {
    const project = runner.project_path || 'unknown';
    if (!byProject.has(project)) {
      byProject.set(project, []);
    }
    byProject.get(project)!.push(runner);
  }

  console.log('RUNNERS');
  console.log('═'.repeat(100));

  for (const [project, projectRunners] of byProject) {
    // Show project path
    console.log(`\n📁 ${project}`);
    console.log('─'.repeat(100));
    console.log('ID        STATUS      PID       SECTION                           TASK              HEARTBEAT');
    console.log('─'.repeat(100));

    for (const runner of projectRunners) {
      const shortId = runner.id.substring(0, 8);
      const status = runner.status.padEnd(10);
      const pid = (runner.pid?.toString() ?? '-').padEnd(9);

      // Get section name
      let sectionDisplay = '-';
      if (runner.section_id && runner.project_path) {
        try {
          const { db, close } = openDatabase(runner.project_path);
          try {
            const section = getSection(db, runner.section_id);
            if (section) {
              sectionDisplay = section.name.substring(0, 30);
            }
          } finally {
            close();
          }
        } catch {
          sectionDisplay = runner.section_id.substring(0, 8);
        }
      }
      const section = sectionDisplay.padEnd(33);

      // Get current task
      let taskDisplay = '-';
      if (runner.current_task_id && runner.project_path) {
        try {
          const { db, close } = openDatabase(runner.project_path);
          try {
            const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(runner.current_task_id) as { title: string } | undefined;
            if (task) {
              taskDisplay = task.title.substring(0, 15);
            }
          } finally {
            close();
          }
        } catch {
          taskDisplay = runner.current_task_id.substring(0, 8);
        }
      }
      const taskCol = taskDisplay.padEnd(17);

      const heartbeat = runner.heartbeat_at.substring(11, 19);
      const alive = runner.pid && isProcessAlive(runner.pid) ? '' : ' (DEAD)';

      console.log(`${shortId}  ${status}  ${pid}  ${section}  ${taskCol}  ${heartbeat}${alive}`);
    }
  }

  // Show summary
  const totalRunners = filteredRunners.length;
  const aliveRunners = filteredRunners.filter(r => r.pid && isProcessAlive(r.pid)).length;
  const deadRunners = totalRunners - aliveRunners;

  console.log('');
  console.log(`Total: ${totalRunners} runner(s)`);
  if (deadRunners > 0) {
    console.log(`  ⚠️  ${deadRunners} dead runner(s) - run 'steroids runners wakeup' to clean up`);
  }

  // Check for potential conflicts (same section, different runners)
  const sectionRunners = new Map<string, Runner[]>();
  for (const runner of filteredRunners) {
    if (runner.section_id) {
      const key = `${runner.project_path}:${runner.section_id}`;
      if (!sectionRunners.has(key)) {
        sectionRunners.set(key, []);
      }
      sectionRunners.get(key)!.push(runner);
    }
  }

  for (const [key, runners] of sectionRunners) {
    if (runners.length > 1) {
      console.log(`  ⚠️  CONFLICT: Multiple runners on same section (${key})`);
    }
  }
}
```

### Example Output

```
RUNNERS
════════════════════════════════════════════════════════════════════════════════════════════════════

📁 /Users/dev/projects/my-monorepo
────────────────────────────────────────────────────────────────────────────────────────────────────
ID        STATUS      PID       SECTION                           TASK              HEARTBEAT
────────────────────────────────────────────────────────────────────────────────────────────────────
abc12345  running     12345     API                               Add auth endpo... 17:30:45
def67890  running     12346     Mobile                            Login screen...   17:30:50

📁 /Users/dev/projects/other-project
────────────────────────────────────────────────────────────────────────────────────────────────────
ID        STATUS      PID       SECTION                           TASK              HEARTBEAT
────────────────────────────────────────────────────────────────────────────────────────────────────
ghi11111  running     12347     -                                 Fix bug #123...   17:29:30 (DEAD)

Total: 3 runner(s)
  ⚠️  1 dead runner(s) - run 'steroids runners wakeup' to clean up
```

## JSON Output

```json
{
  "runners": [
    {
      "id": "abc12345-...",
      "status": "running",
      "pid": 12345,
      "project_path": "/Users/dev/projects/my-monorepo",
      "section_id": "section-uuid",
      "section_name": "API",
      "current_task_id": "task-uuid",
      "current_task_title": "Add auth endpoint",
      "started_at": "2024-01-15T17:00:00.000Z",
      "heartbeat_at": "2024-01-15T17:30:45.000Z",
      "alive": true
    }
  ]
}
```

## Testing

```bash
# Start multiple runners
steroids runners start --section "API" --detach
steroids runners start --section "Mobile" --detach

# List should show both with sections
steroids runners list

# JSON output
steroids runners list --json | jq '.runners[].section_name'
```
