# Live Task Monitoring & Activity Timeline

## Problem Statement

Currently, task monitoring has critical visibility gaps:

1. **No invocation start events** - Timeline only shows when invocations complete, not when they start
2. **No live logs** - Can't see what coder/reviewer is doing in real-time
3. **Silent execution** - If you look at a task in `in_progress`, you can't tell if it's working or stuck
4. **Poor debugging** - When tasks fail, you can't see what happened leading up to failure

**Example Gap:**
```
Task marked in_progress at 12:48:46
... 35 minutes of silence ...
Still showing 0 invocations

User question: "Is it working or stuck?"
Answer: Unknown until it completes or times out
```

## Solution Overview

Implement **live task monitoring** with three components:

1. **Invocation lifecycle tracking** - Record start AND completion separately
2. **Activity stream** - Real-time log streaming via Server-Sent Events (SSE)
3. **Timeline visualization** - Show all events (start, progress, completion) in WebUI

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ INVOCATION LIFECYCLE                                        │
├─────────────────────────────────────────────────────────────┤
│ 1. Invocation starts                                        │
│    → Create invocation record (started_at, status=running)  │
│    → Emit event: invocation.started                         │
│                                                              │
│ 2. Tool executions happen                                   │
│    → Update last_activity_at                                │
│    → Append to activity log                                 │
│    → Emit event: invocation.activity                        │
│                                                              │
│ 3. Invocation completes                                     │
│    → Update invocation (completed_at, status, response)     │
│    → Emit event: invocation.completed                       │
└─────────────────────────────────────────────────────────────┘
```

## Database Schema Changes

### Migration 010: Add invocation lifecycle tracking

```sql
-- Add lifecycle timestamps to task_invocations
ALTER TABLE task_invocations ADD COLUMN started_at TEXT;
ALTER TABLE task_invocations ADD COLUMN completed_at TEXT;
ALTER TABLE task_invocations ADD COLUMN last_activity_at TEXT;
ALTER TABLE task_invocations ADD COLUMN status TEXT DEFAULT 'completed';
  -- 'running' | 'completed' | 'failed' | 'timeout'

-- Activity log for streaming (separate table for performance)
CREATE TABLE invocation_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id INTEGER NOT NULL REFERENCES task_invocations(id),
  activity_type TEXT NOT NULL,  -- 'tool_exec' | 'output' | 'error' | 'progress'
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invocation_activity_invocation ON invocation_activity(invocation_id);
CREATE INDEX idx_invocation_activity_created ON invocation_activity(created_at DESC);

-- Update created_at to be nullable (set when record is created, which is at start now)
-- Completed_at is set when invocation finishes
```

**Key Changes:**
- `started_at` - When invocation begins (record created immediately)
- `completed_at` - When invocation finishes (was `created_at` before)
- `last_activity_at` - Last tool execution or output (for hang detection)
- `status` - Current state (running/completed/failed/timeout)
- `invocation_activity` - Separate table for streaming logs (performance)

## Invocation Logging Flow

### Current Flow (Broken)
```typescript
// src/providers/invocation-logger.ts
export async function logInvocation(...) {
  // ... invoke AI provider ...
  const response = await provider.invoke(prompt);

  // Only log AFTER completion
  db.prepare(`
    INSERT INTO task_invocations (task_id, role, provider, prompt, response, ...)
    VALUES (?, ?, ?, ?, ?, ...)
  `).run(...);
}
```

**Problem:** No record exists during execution, can't track progress.

### New Flow (Fixed)
```typescript
// src/providers/invocation-logger.ts
export async function logInvocation(...) {
  // 1. Create invocation record BEFORE starting
  const invocationId = db.prepare(`
    INSERT INTO task_invocations (
      task_id, role, provider, model, prompt,
      started_at, status, last_activity_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'), 'running', datetime('now'))
  `).run(...).lastInsertRowid;

  // 2. Emit start event (for SSE streaming)
  emitInvocationEvent({
    type: 'invocation.started',
    invocationId,
    taskId,
    role,
    provider,
    model,
    timestamp: new Date(),
  });

  try {
    // 3. Invoke AI provider with activity callback
    const response = await provider.invoke(prompt, {
      onActivity: (activity) => {
        // Log each tool execution in real-time
        db.prepare(`
          INSERT INTO invocation_activity (invocation_id, activity_type, message)
          VALUES (?, ?, ?)
        `).run(invocationId, activity.type, activity.message);

        // Update last activity timestamp
        db.prepare(`
          UPDATE task_invocations
          SET last_activity_at = datetime('now')
          WHERE id = ?
        `).run(invocationId);

        // Emit activity event (for live streaming)
        emitInvocationEvent({
          type: 'invocation.activity',
          invocationId,
          activity,
          timestamp: new Date(),
        });
      }
    });

    // 4. Update invocation on completion
    db.prepare(`
      UPDATE task_invocations
      SET completed_at = datetime('now'),
          status = 'completed',
          response = ?,
          exit_code = ?,
          duration_ms = ?,
          success = 1
      WHERE id = ?
    `).run(response, exitCode, duration, invocationId);

    // 5. Emit completion event
    emitInvocationEvent({
      type: 'invocation.completed',
      invocationId,
      success: true,
      duration,
      timestamp: new Date(),
    });

  } catch (error) {
    // Update invocation on failure
    db.prepare(`
      UPDATE task_invocations
      SET completed_at = datetime('now'),
          status = 'failed',
          error = ?,
          success = 0
      WHERE id = ?
    `).run(error.message, invocationId);

    emitInvocationEvent({
      type: 'invocation.failed',
      invocationId,
      error: error.message,
      timestamp: new Date(),
    });

    throw error;
  }
}
```

## Activity Callback Integration

Providers need to support activity callbacks to stream tool executions:

```typescript
// src/providers/interface.ts
export interface InvokeOptions {
  timeout?: number;
  model?: string;
  onActivity?: (activity: InvocationActivity) => void;  // NEW
}

export interface InvocationActivity {
  type: 'tool_exec' | 'output' | 'error' | 'progress';
  message: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}
```

### Example: Claude Provider with Activity Streaming

```typescript
// src/providers/claude.ts
async invoke(prompt: string, options?: InvokeOptions): Promise<string> {
  const process = spawn('claude', args);

  process.stdout.on('data', (data) => {
    const output = data.toString();

    // Parse tool executions from Claude output
    const toolMatch = output.match(/^exec\n(.+)/);
    if (toolMatch && options?.onActivity) {
      options.onActivity({
        type: 'tool_exec',
        message: toolMatch[1],
        timestamp: new Date(),
      });
    }

    // Stream general output
    if (options?.onActivity) {
      options.onActivity({
        type: 'output',
        message: output,
        timestamp: new Date(),
      });
    }

    fullOutput += output;
  });

  // ... wait for completion ...
}
```

## API Endpoints

### 1. Get Task Timeline (Enhanced)

```typescript
// GET /api/tasks/:id/timeline?project=<path>
{
  "success": true,
  "timeline": [
    {
      "timestamp": "2026-02-10T12:48:46Z",
      "type": "task.started",
      "actor": "orchestrator",
      "message": "Task marked in_progress"
    },
    {
      "timestamp": "2026-02-10T12:49:00Z",
      "type": "invocation.started",
      "invocationId": 123,
      "role": "coder",
      "provider": "codex",
      "model": "gpt-4o"
    },
    {
      "timestamp": "2026-02-10T12:49:05Z",
      "type": "invocation.activity",
      "invocationId": 123,
      "activity": "exec: rg -n 'verified email' src/"
    },
    {
      "timestamp": "2026-02-10T12:49:10Z",
      "type": "invocation.activity",
      "invocationId": 123,
      "activity": "exec: cat API/src/services/social/google.service.ts"
    },
    {
      "timestamp": "2026-02-10T12:52:30Z",
      "type": "invocation.completed",
      "invocationId": 123,
      "success": true,
      "duration": 210000
    },
    {
      "timestamp": "2026-02-10T12:52:31Z",
      "type": "task.review",
      "actor": "orchestrator",
      "message": "Task moved to review phase"
    }
  ]
}
```

### 2. Stream Live Activity (SSE)

```typescript
// GET /api/tasks/:id/stream?project=<path>
// Server-Sent Events endpoint

app.get('/api/tasks/:id/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const taskId = req.params.id;
  const projectPath = req.query.project;

  // Send initial state
  const currentInvocation = db.prepare(`
    SELECT id, role, provider, status, started_at, last_activity_at
    FROM task_invocations
    WHERE task_id = ? AND status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `).get(taskId);

  if (currentInvocation) {
    res.write(`data: ${JSON.stringify({
      type: 'invocation.current',
      ...currentInvocation,
    })}\n\n`);

    // Stream recent activity
    const activities = db.prepare(`
      SELECT * FROM invocation_activity
      WHERE invocation_id = ?
      ORDER BY created_at ASC
    `).all(currentInvocation.id);

    activities.forEach(activity => {
      res.write(`data: ${JSON.stringify({
        type: 'invocation.activity',
        ...activity,
      })}\n\n`);
    });
  }

  // Subscribe to new events
  const listener = (event: InvocationEvent) => {
    if (event.taskId === taskId) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  eventEmitter.on('invocation.*', listener);

  // Cleanup on disconnect
  req.on('close', () => {
    eventEmitter.off('invocation.*', listener);
  });
});
```

### 3. Get Invocation Details

```typescript
// GET /api/invocations/:id?project=<path>
{
  "success": true,
  "invocation": {
    "id": 123,
    "taskId": "9cefe1b1-677f-4816-b47a-23b17e65f531",
    "role": "coder",
    "provider": "codex",
    "model": "gpt-4o",
    "status": "completed",
    "startedAt": "2026-02-10T12:49:00Z",
    "completedAt": "2026-02-10T12:52:30Z",
    "lastActivityAt": "2026-02-10T12:52:28Z",
    "duration": 210000,
    "success": true,
    "prompt": "...",
    "response": "...",
    "activities": [
      {
        "timestamp": "2026-02-10T12:49:05Z",
        "type": "tool_exec",
        "message": "exec: rg -n 'verified email' src/"
      },
      {
        "timestamp": "2026-02-10T12:49:10Z",
        "type": "tool_exec",
        "message": "exec: cat API/src/services/social/google.service.ts"
      }
    ]
  }
}
```

## WebUI Changes

### Task Page Enhancements

```tsx
// WebUI/src/pages/TaskPage.tsx

function TaskPage() {
  const { taskId } = useParams();
  const [timeline, setTimeline] = useState([]);
  const [liveActivity, setLiveActivity] = useState([]);

  // Fetch initial timeline
  useEffect(() => {
    fetch(`/api/tasks/${taskId}/timeline?project=${projectPath}`)
      .then(res => res.json())
      .then(data => setTimeline(data.timeline));
  }, [taskId]);

  // Connect to live stream if task is active
  useEffect(() => {
    if (taskStatus !== 'in_progress' && taskStatus !== 'review') {
      return;
    }

    const eventSource = new EventSource(
      `/api/tasks/${taskId}/stream?project=${projectPath}`
    );

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Append to live activity
      setLiveActivity(prev => [...prev, data]);

      // Also update timeline if it's a major event
      if (data.type.startsWith('invocation.')) {
        setTimeline(prev => [...prev, data]);
      }
    };

    return () => eventSource.close();
  }, [taskId, taskStatus]);

  return (
    <div>
      {/* Timeline */}
      <TimelineView events={timeline} />

      {/* Live Activity (only shown if task is active) */}
      {(taskStatus === 'in_progress' || taskStatus === 'review') && (
        <LiveActivityPanel
          activity={liveActivity}
          autoScroll={true}
        />
      )}
    </div>
  );
}
```

### Timeline Component

```tsx
function TimelineView({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="timeline">
      {events.map((event, i) => (
        <TimelineEvent key={i} event={event} />
      ))}
    </div>
  );
}

function TimelineEvent({ event }: { event: TimelineEvent }) {
  const getIcon = () => {
    switch (event.type) {
      case 'task.started': return <PlayIcon />;
      case 'invocation.started': return <SpinnerIcon className="animate-spin" />;
      case 'invocation.activity': return <ActivityIcon />;
      case 'invocation.completed': return <CheckIcon />;
      case 'invocation.failed': return <XIcon />;
      default: return <DotIcon />;
    }
  };

  return (
    <div className="timeline-event">
      <div className="timeline-icon">{getIcon()}</div>
      <div className="timeline-content">
        <div className="timeline-timestamp">
          {formatTimestamp(event.timestamp)}
        </div>
        <div className="timeline-message">
          {formatMessage(event)}
        </div>
        {event.type === 'invocation.started' && (
          <InvocationBadge
            role={event.role}
            provider={event.provider}
            model={event.model}
          />
        )}
      </div>
    </div>
  );
}
```

### Live Activity Panel

```tsx
function LiveActivityPanel({ activity, autoScroll }: LiveActivityPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new activity
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [activity, autoScroll]);

  return (
    <div className="live-activity-panel">
      <div className="live-activity-header">
        <SpinnerIcon className="animate-spin" />
        <span>Live Activity</span>
        <span className="live-indicator">●</span>
      </div>
      <div className="live-activity-content" ref={containerRef}>
        {activity.map((item, i) => (
          <div key={i} className="activity-line">
            <span className="activity-timestamp">
              {formatTime(item.timestamp)}
            </span>
            <span className="activity-message">
              {item.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

## Event Emitter (Server-Side)

```typescript
// src/events/invocation-events.ts
import { EventEmitter } from 'events';

export interface InvocationEvent {
  type: 'invocation.started' | 'invocation.activity' | 'invocation.completed' | 'invocation.failed';
  invocationId: number;
  taskId: string;
  timestamp: Date;
  [key: string]: unknown;
}

class InvocationEventEmitter extends EventEmitter {}

export const invocationEvents = new InvocationEventEmitter();

export function emitInvocationEvent(event: InvocationEvent): void {
  invocationEvents.emit('invocation.*', event);
  invocationEvents.emit(event.type, event);
}
```

## Configuration

```yaml
monitoring:
  enableLiveStreaming: true         # Enable SSE streaming
  activityLogRetention: 7           # Days to keep activity logs
  streamHeartbeatInterval: 30       # Seconds between keepalive pings
  maxConcurrentStreams: 100         # Limit concurrent SSE connections
```

## Implementation Checklist

### Phase 1: Database & Core Logic (3-4 hours)
- [ ] Create migration 010 (invocation lifecycle fields + activity table)
- [ ] Update `task_invocations` schema
- [ ] Create `invocation_activity` table
- [ ] Update invocation logger to create record on start
- [ ] Implement activity callback in provider interface
- [ ] Add event emitter for real-time events
- [ ] Test invocation lifecycle tracking

### Phase 2: Provider Integration (2-3 hours)
- [ ] Add activity callback support to Claude provider
- [ ] Add activity callback support to Codex provider
- [ ] Add activity callback support to Gemini provider
- [ ] Test activity streaming with each provider
- [ ] Handle tool execution parsing for each provider

### Phase 3: API Endpoints (2-3 hours)
- [ ] Implement `/api/tasks/:id/timeline` (enhanced with start events)
- [ ] Implement `/api/tasks/:id/stream` (SSE endpoint)
- [ ] Implement `/api/invocations/:id` (invocation details)
- [ ] Add SSE keepalive pings
- [ ] Test concurrent streams
- [ ] Add rate limiting

### Phase 4: WebUI Components (3-4 hours)
- [ ] Update TaskPage to fetch timeline
- [ ] Implement TimelineView component
- [ ] Implement LiveActivityPanel component
- [ ] Connect SSE stream
- [ ] Add auto-scroll and pause controls
- [ ] Style timeline events with icons
- [ ] Test with live tasks

### Phase 5: Testing (2-3 hours)
- [ ] Unit tests for invocation logger
- [ ] Integration tests for SSE streaming
- [ ] Test timeline with multiple invocations
- [ ] Test reconnection after disconnect
- [ ] Test with stuck tasks (verify last_activity_at updates)
- [ ] Performance test with high activity volume

### Phase 6: Documentation (1 hour)
- [ ] Update API documentation
- [ ] Document SSE endpoint usage
- [ ] Add WebUI usage guide
- [ ] Update troubleshooting guide

**Total Estimated Time: 13-18 hours**

## Benefits

1. **Real-time visibility** - See exactly what's happening during task execution
2. **Better debugging** - Full activity log when tasks fail or hang
3. **User confidence** - Know the system is working, not stuck
4. **Improved stuck detection** - `last_activity_at` provides precise hang detection
5. **Audit trail** - Complete record of all tool executions per invocation

## Example Timeline Display

```
Task: Verify social login only accepts provider-verified emails
Status: in_progress

Timeline:
─────────────────────────────────────────────────────────────
12:48:46  ▶  Task started by orchestrator
12:49:00  ⟳  Coder started (codex, gpt-4o)
12:49:05  ⚡ exec: rg -n 'verified email' src/
12:49:10  ⚡ exec: cat API/src/services/social/google.service.ts
12:49:25  ⚡ exec: cat API/src/services/social/github.service.ts
12:52:30  ✓  Coder completed (3m 30s)
12:52:31  ⟳  Reviewer started (claude, sonnet-4)
12:52:45  ⚡ exec: git diff HEAD~1
12:53:00  ✓  Reviewer approved (29s)
12:53:01  ✓  Task completed
─────────────────────────────────────────────────────────────

Live Activity (streaming...):
  12:53:15  Reading test file: API/tests/unit/google.service.test.ts
  12:53:18  Analyzing test coverage...
  12:53:21  Checking for edge cases...
```
