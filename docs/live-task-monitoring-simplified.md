# Live Task Monitoring (Simplified - File-Based Logs)

## Problem Statement

Tasks show 0 invocations while actively running. Need to:
1. Track when invocations **start** (not just complete)
2. Stream live activity logs
3. Show timeline of all events

## Solution: File-Based Activity Logs

**Key Insight:** Use text files for activity, not database tables. Much simpler!

```
.steroids/
├── steroids.db                    # Task metadata only
└── invocations/                   # Activity logs (NEW)
    ├── 123.log                    # Invocation 123 activity
    ├── 124.log                    # Invocation 124 activity
    └── ...
```

## Benefits

✅ **No database write amplification** - just append to file
✅ **Simple purge** - delete old `.log` files (no DB queries)
✅ **Standard logging** - familiar text file approach
✅ **Easy debugging** - can `cat` or `tail -f` the log
✅ **SSE streams file** - tail the file, no DB polling
✅ **Minimal migration** - only add 2 timestamp columns

## Database Schema (Minimal Changes)

### Migration 010: Add invocation timestamps only

```sql
-- Migration 010: Add lifecycle timestamps
BEGIN TRANSACTION;

-- Add start/complete timestamps to track invocation lifecycle
ALTER TABLE task_invocations ADD COLUMN started_at_ms INTEGER;
ALTER TABLE task_invocations ADD COLUMN completed_at_ms INTEGER;
ALTER TABLE task_invocations ADD COLUMN status TEXT DEFAULT 'completed'
  CHECK(status IN ('running', 'completed', 'failed', 'timeout'));

-- Backfill existing rows (all are completed)
UPDATE task_invocations
SET started_at_ms = (julianday(created_at) - 2440587.5) * 86400000,
    completed_at_ms = (julianday(created_at) - 2440587.5) * 86400000,
    status = 'completed'
WHERE started_at_ms IS NULL;

-- Make started_at_ms required after backfill
-- (SQLite doesn't support ALTER COLUMN, but new rows will have it via app logic)

-- Index for finding running invocations
CREATE INDEX idx_task_invocations_task_status
  ON task_invocations(task_id, status, started_at_ms DESC);

COMMIT;
```

**That's it!** No `invocation_activity` table needed.

## File-Based Activity Logging

### Directory Structure

```
.steroids/invocations/
├── 123.log          # All activity for invocation 123
├── 124.log          # All activity for invocation 124
└── README.txt       # "Activity logs for invocations"
```

### Log Format (Simple JSONL)

Each line is a JSON event with timestamp:

```jsonl
{"ts":1707567540123,"type":"start","role":"coder","provider":"codex","model":"gpt-4o"}
{"ts":1707567545678,"type":"tool","cmd":"rg -n 'verified email' src/"}
{"ts":1707567550234,"type":"tool","cmd":"cat API/src/services/google.service.ts"}
{"ts":1707567555890,"type":"output","msg":"Found 15 matches"}
{"ts":1707567560456,"type":"complete","success":true,"duration":20333}
```

**Why JSONL?**
- Easy to append (just write a line)
- Easy to parse (JSON.parse per line)
- Easy to stream (tail -f works)
- Easy to search (grep works)

## Invocation Logger Implementation

```typescript
// src/providers/invocation-logger.ts
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export async function logInvocation(
  db: Database,
  taskId: string,
  role: string,
  provider: string,
  model: string,
  prompt: string,
  invoke: () => Promise<string>
): Promise<string> {
  const startedMs = Date.now();

  // 1. Create invocation record
  const invocationId = db.prepare(`
    INSERT INTO task_invocations (
      task_id, role, provider, model, prompt,
      started_at_ms, status
    ) VALUES (?, ?, ?, ?, ?, ?, 'running')
  `).run(taskId, role, provider, model, prompt, startedMs).lastInsertRowid;

  // 2. Create log file
  const logDir = join(getProjectRoot(), '.steroids', 'invocations');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${invocationId}.log`);

  // Helper to append log entry
  const log = (entry: any) => {
    appendFileSync(logFile, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');

    // Emit SSE event
    emitInvocationEvent({
      eventId: `${invocationId}-${Date.now()}`,
      type: 'invocation.activity',
      taskId,
      invocationId,
      ...entry,
    });
  };

  // 3. Log start
  log({ type: 'start', role, provider, model });

  try {
    // 4. Invoke with activity callback
    const response = await invoke({
      onActivity: (activity) => {
        log({ type: activity.type, ...activity });
      }
    });

    const completedMs = Date.now();
    const duration = completedMs - startedMs;

    // 5. Log completion
    log({ type: 'complete', success: true, duration });

    // 6. Update DB record
    db.prepare(`
      UPDATE task_invocations
      SET completed_at_ms = ?,
          status = 'completed',
          response = ?,
          duration_ms = ?,
          success = 1
      WHERE id = ?
    `).run(completedMs, response, duration, invocationId);

    return response;

  } catch (error) {
    const failedMs = Date.now();

    // Log failure
    log({ type: 'error', error: error.message });

    // Update DB
    db.prepare(`
      UPDATE task_invocations
      SET completed_at_ms = ?,
          status = 'failed',
          error = ?,
          success = 0
      WHERE id = ?
    `).run(failedMs, error.message, invocationId);

    throw error;
  }
}
```

**Key Points:**
- ✅ Simple append (no batching needed)
- ✅ No event loop blocking (sync append is fast)
- ✅ Each log line is independent (no transactions)
- ✅ SSE events emitted immediately (not waiting for DB)

## SSE Endpoint (Stream Log File)

```typescript
// GET /api/tasks/:id/stream?project=<path>

import { createReadStream } from 'fs';
import { join } from 'path';
import { Tail } from 'tail';

app.get('/api/tasks/:id/stream', async (req, res) => {
  const taskId = req.params.id;

  // Setup SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Find running invocation for this task
  const invocation = db.prepare(`
    SELECT id, started_at_ms, status
    FROM task_invocations
    WHERE task_id = ? AND status = 'running'
    ORDER BY started_at_ms DESC
    LIMIT 1
  `).get(taskId);

  if (!invocation) {
    res.write(`data: ${JSON.stringify({ type: 'no_active_invocation' })}\n\n`);
    res.end();
    return;
  }

  const logFile = join(getProjectRoot(), '.steroids', 'invocations', `${invocation.id}.log`);

  try {
    // 1. Send existing log entries
    const stream = createReadStream(logFile, { encoding: 'utf8' });
    for await (const chunk of stream) {
      const lines = chunk.split('\n').filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line);
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    }

    // 2. Tail for new entries (if still running)
    if (invocation.status === 'running') {
      const tail = new Tail(logFile, { follow: true, useWatchFile: true });

      tail.on('line', (line) => {
        try {
          const entry = JSON.parse(line);
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        } catch {}
      });

      // Cleanup on disconnect
      req.on('close', () => {
        tail.unwatch();
      });

      // Heartbeat
      const heartbeat = setInterval(() => {
        res.write(': heartbeat\n\n');
      }, 30000);

      req.on('close', () => {
        clearInterval(heartbeat);
      });
    } else {
      // Completed, close stream
      res.end();
    }

  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});
```

**Benefits:**
- ✅ Streams existing log immediately
- ✅ Tails for new entries if still running
- ✅ No database polling
- ✅ Simple cleanup (just stop tailing)

## Activity Callback (Provider Integration)

Providers just call the callback for each activity:

```typescript
// src/providers/codex.ts
async invoke(prompt: string, options?: InvokeOptions): Promise<string> {
  const proc = spawn('codex', ['exec', '--full-auto', '-'], {
    cwd: process.cwd(),
  });

  proc.stdin.write(prompt);
  proc.stdin.end();

  let output = '';

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;

    // Parse and emit activities
    if (options?.onActivity) {
      // Tool execution
      if (text.startsWith('exec\n')) {
        const cmd = text.split('\n')[1];
        options.onActivity({ type: 'tool', cmd });
      }
      // General output
      else {
        options.onActivity({ type: 'output', msg: text });
      }
    }
  });

  return new Promise((resolve, reject) => {
    proc.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Exit code ${code}`));
    });
  });
}
```

## Timeline API (Parse Logs on Demand)

```typescript
// GET /api/tasks/:id/timeline?project=<path>

app.get('/api/tasks/:id/timeline', async (req, res) => {
  const taskId = req.params.id;

  // 1. Get all invocations for this task
  const invocations = db.prepare(`
    SELECT id, role, provider, started_at_ms, completed_at_ms, status
    FROM task_invocations
    WHERE task_id = ?
    ORDER BY started_at_ms ASC
  `).all(taskId);

  const timeline = [];

  // 2. Parse each invocation's log file
  for (const inv of invocations) {
    const logFile = join(getProjectRoot(), '.steroids', 'invocations', `${inv.id}.log`);

    // Add invocation start event
    timeline.push({
      ts: inv.started_at_ms,
      type: 'invocation.started',
      invocationId: inv.id,
      role: inv.role,
      provider: inv.provider,
    });

    // Read log entries
    try {
      const log = readFileSync(logFile, 'utf8');
      const entries = log.split('\n').filter(Boolean).map(line => JSON.parse(line));

      // Add activity entries (sample - not all)
      const sampledEntries = entries.filter((e, i) =>
        e.type === 'tool' || i % 10 === 0 // Keep all tools, sample others
      );

      timeline.push(...sampledEntries.map(e => ({
        ...e,
        invocationId: inv.id,
      })));
    } catch {}

    // Add completion event
    if (inv.completed_at_ms) {
      timeline.push({
        ts: inv.completed_at_ms,
        type: 'invocation.completed',
        invocationId: inv.id,
        success: inv.status === 'completed',
        duration: inv.completed_at_ms - inv.started_at_ms,
      });
    }
  }

  res.json({ success: true, timeline });
});
```

## Retention & Cleanup

**Simple file deletion:**

```typescript
// src/cleanup/invocation-logs.ts

export async function cleanupInvocationLogs(
  projectPath: string,
  retentionDays = 7
): Promise<number> {
  const logsDir = join(projectPath, '.steroids', 'invocations');
  const cutoffMs = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

  const files = readdirSync(logsDir).filter(f => f.endsWith('.log'));
  let deleted = 0;

  for (const file of files) {
    const filePath = join(logsDir, file);
    const stat = statSync(filePath);

    // Delete if older than retention period
    if (stat.mtimeMs < cutoffMs) {
      unlinkSync(filePath);
      deleted++;
    }
  }

  return deleted;
}
```

**Automatic cleanup:**
- Run cleanup during wakeup (like stuck task recovery)
- Or add `steroids cleanup logs` command
- Or scheduled cron job

## Comparison: Database vs Files

| Aspect | Database Approach | File Approach |
|--------|------------------|---------------|
| **Schema** | New table + migration | Just 2 columns |
| **Write** | Batch + transaction | Simple append |
| **Query** | SQL indexes | Parse on demand |
| **Stream** | Poll DB | Tail file |
| **Retention** | DELETE query | rm old files |
| **Debugging** | SQL client | cat/tail/grep |
| **Complexity** | High | Low |
| **Performance** | Good (with batching) | Excellent |

**Winner:** Files! ✅

## Implementation Checklist

### Phase 1: Database Changes (1 hour)
- [ ] Create migration 010 (add started_at_ms, completed_at_ms, status)
- [ ] Test migration with backfill
- [ ] Add index for running invocations

### Phase 2: File-Based Logger (2-3 hours)
- [ ] Create `invocations/` directory structure
- [ ] Update invocation logger to create log files
- [ ] Implement JSONL append helper
- [ ] Add activity callback to logger
- [ ] Test log file creation and appending

### Phase 3: Provider Integration (2-3 hours)
- [ ] Add onActivity callback to Claude provider
- [ ] Add onActivity callback to Codex provider
- [ ] Add onActivity callback to Gemini provider
- [ ] Parse tool executions for each provider
- [ ] Test activity streaming

### Phase 4: SSE Endpoint (2-3 hours)
- [ ] Implement SSE log streaming endpoint
- [ ] Use `tail` library for live following
- [ ] Add connection management (limits, cleanup)
- [ ] Test with multiple concurrent streams
- [ ] Handle log file not found gracefully

### Phase 5: Timeline API (1-2 hours)
- [ ] Implement timeline endpoint
- [ ] Parse log files on demand
- [ ] Sample activity entries (not all)
- [ ] Test with multiple invocations

### Phase 6: Cleanup & Retention (1 hour)
- [ ] Implement log cleanup function
- [ ] Integrate with wakeup system
- [ ] Add CLI command: `steroids cleanup logs`
- [ ] Test retention logic

### Phase 7: WebUI Updates (3-4 hours)
- [ ] Update TaskPage to use SSE stream
- [ ] Display live activity panel
- [ ] Show timeline from API
- [ ] Style activity entries
- [ ] Test with live tasks

### Phase 8: Testing & Docs (2 hours)
- [ ] Integration tests for log streaming
- [ ] Test with all providers
- [ ] Update API documentation
- [ ] Add troubleshooting guide

**Total Estimated Time: 14-18 hours**

## Migration Guide

```bash
# 1. Update CLI
npm install -g steroids-cli@latest

# 2. Migrate database (adds timestamps only)
cd /path/to/project
steroids migrate

# 3. Old invocations still work (backfilled)
# 4. New invocations create .steroids/invocations/*.log files
```

## Example Log File

`.steroids/invocations/123.log`:
```jsonl
{"ts":1707567540123,"type":"start","role":"coder","provider":"codex","model":"gpt-4o"}
{"ts":1707567545678,"type":"tool","cmd":"rg -n 'verified email' src/"}
{"ts":1707567546234,"type":"output","msg":"./API/src/services/social/google.service.ts:127:    emailVerified: parseBooleanish(obj.email_verified),"}
{"ts":1707567547890,"type":"tool","cmd":"cat API/src/services/social/google.service.ts"}
{"ts":1707567555456,"type":"output","msg":"export class GoogleService extends BaseSocialProvider {"}
{"ts":1707567560123,"type":"complete","success":true,"duration":20000}
```

Clean, simple, debuggable! 🎉
