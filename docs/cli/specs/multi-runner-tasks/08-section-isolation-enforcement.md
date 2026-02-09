# Enforce Section-Based Runner Isolation

## Problem
Need to enforce that only one runner can be active per section, while allowing different sections to run in parallel.

## Files to Modify
- `src/runners/daemon.ts` - Add section isolation check in `startDaemon()`
- `src/commands/runners.ts` - Update CLI messages and validation

## Implementation

### Step 1: Update startDaemon() in daemon.ts

```typescript
import { getRunnerForSection, getActiveRunnersForProject } from './wakeup.js';
import { acquireSectionLock, releaseSectionLock } from '../locking/section-lock.js';

export async function startDaemon(options: DaemonOptions): Promise<void> {
  const { projectPath, sectionId } = options;
  const runnerId = randomUUID();

  // === MULTI-RUNNER ISOLATION CHECK ===

  if (sectionId) {
    // Section-specific runner: check if this section already has a runner
    const existingRunner = getRunnerForSection(projectPath, sectionId);
    if (existingRunner) {
      console.error(`Section already has an active runner:`);
      console.error(`  Runner ID: ${existingRunner.id.slice(0, 8)}`);
      console.error(`  PID: ${existingRunner.pid}`);
      console.error(`  Started: ${existingRunner.started_at}`);
      console.error('');
      console.error(`To stop it: steroids runners stop --id ${existingRunner.id.slice(0, 8)}`);
      process.exit(6);
    }

    // Acquire section lock (prevents race between check and start)
    const { db, close } = openDatabase(projectPath);
    try {
      const lockResult = acquireSectionLock(db, sectionId, runnerId);
      if (!lockResult.acquired) {
        console.error(`Failed to acquire section lock: ${lockResult.reason}`);
        process.exit(6);
      }
    } finally {
      close();
    }

    console.log(`Starting runner for section: ${sectionId}`);
  } else {
    // No section specified: default single-runner mode
    const existingRunners = getActiveRunnersForProject(projectPath);

    if (existingRunners.length > 0) {
      console.error('Project already has active runner(s):');
      for (const runner of existingRunners) {
        const section = runner.section_id ? ` (section: ${runner.section_id.slice(0, 8)})` : '';
        console.error(`  - PID ${runner.pid}${section}`);
      }
      console.error('');
      console.error('Options:');
      console.error('  1. Stop existing runners: steroids runners stop --all');
      console.error('  2. Use --section to run on a specific section in parallel');
      process.exit(6);
    }

    console.log('Starting runner (single-runner mode, no section)');
  }

  // === REGISTER RUNNER ===
  registerRunner({
    id: runnerId,
    pid: process.pid,
    projectPath,
    sectionId,
    status: 'running',
  });

  // === CLEANUP ON EXIT ===
  const cleanup = () => {
    unregisterRunner(runnerId);
    if (sectionId) {
      const { db, close } = openDatabase(projectPath);
      try {
        releaseSectionLock(db, sectionId, runnerId);
      } finally {
        close();
      }
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // === START ORCHESTRATOR LOOP ===
  await runOrchestratorLoop(options);
}
```

### Step 2: Update canStartDaemon() for pre-flight check

```typescript
export interface CanStartResult {
  canStart: boolean;
  reason?: string;
  existingPid?: number;
  existingRunners?: Runner[];
}

export function canStartDaemon(projectPath: string, sectionId?: string): CanStartResult {
  if (sectionId) {
    // Check section-specific runner
    const existingRunner = getRunnerForSection(projectPath, sectionId);
    if (existingRunner) {
      return {
        canStart: false,
        reason: `Section already has active runner`,
        existingPid: existingRunner.pid,
      };
    }
    return { canStart: true };
  } else {
    // No section: check for ANY runner on this project
    const existingRunners = getActiveRunnersForProject(projectPath);
    if (existingRunners.length > 0) {
      return {
        canStart: false,
        reason: 'Project has active runners. Use --section for parallel execution.',
        existingRunners,
      };
    }
    return { canStart: true };
  }
}
```

### Step 3: Update CLI in runners.ts

```typescript
// In runStart():

async function runStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      // ... existing options ...
      force: { type: 'boolean', default: false }, // New: bypass checks
    },
  });

  // Pre-flight check
  const projectPath = values.project ?? process.cwd();
  const check = canStartDaemon(projectPath, values.section as string | undefined);

  if (!check.canStart && !values.force) {
    if (values.json) {
      console.log(JSON.stringify({
        success: false,
        error: check.reason,
        existingPid: check.existingPid,
        existingRunners: check.existingRunners,
      }));
    } else {
      console.error(`Cannot start runner: ${check.reason}`);

      // Show helpful suggestions
      if (check.existingRunners && check.existingRunners.length > 0) {
        console.error('');
        console.error('Active runners:');
        for (const r of check.existingRunners) {
          const section = r.section_id ? ` [${r.section_id.slice(0, 8)}]` : ' [no section]';
          console.error(`  PID ${r.pid}${section}`);
        }
        console.error('');
        console.error('Suggestions:');
        console.error('  steroids runners stop --all       # Stop all runners');
        console.error('  steroids runners start --section "Section Name"  # Run specific section');
      }
    }
    process.exit(6);
  }

  // Continue with start...
}
```

## User Experience

### Starting parallel runners:
```bash
$ steroids runners start --section "API" --detach
Runner started in background (PID: 12345)
  Section: API

$ steroids runners start --section "Mobile" --detach
Runner started in background (PID: 12346)
  Section: Mobile

$ steroids runners list
RUNNERS
─────────────────────────────────────────────────────
ID        STATUS    PID     SECTION      HEARTBEAT
─────────────────────────────────────────────────────
abc123    running   12345   API          17:30:45
def456    running   12346   Mobile       17:30:50
```

### Blocked by existing runner:
```bash
$ steroids runners start --section "API" --detach
Cannot start runner: Section already has active runner

Active runners:
  PID 12345 [abc123] (section: API)

Suggestions:
  steroids runners stop --id abc123    # Stop this runner
  steroids runners stop --all          # Stop all runners
```

## Testing

```bash
# Test 1: Different sections can run in parallel
steroids runners start --section "API" --detach
steroids runners start --section "Mobile" --detach
steroids runners list  # Should show 2

# Test 2: Same section is blocked
steroids runners start --section "API" --detach  # Should fail

# Test 3: No section = exclusive
steroids runners stop --all
steroids runners start --detach
steroids runners start --detach  # Should fail
steroids runners start --section "API" --detach  # Should also fail (exclusive mode)
```
