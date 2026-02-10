# Codex Review: Live Task Monitoring Design

## Critical Issues (must fix before implementation)

### 1. Timestamp Storage Inconsistent
**Problem:** Schema uses TEXT with `datetime('now')` (second resolution), but API/UI expect ISO-8601 with milliseconds.
**Fix:** Store as INTEGER epoch millis or strict ISO-8601 UTC everywhere; order by monotonic `id` not `created_at`.

### 2. SSE Event Filtering Broken  
**Problem:** `onActivity` emits events without `taskId`, but SSE filters on `event.taskId === taskId`. Activity events will never stream.
**Fix:** Enforce consistent event shape - always include `taskId`, `invocationId`, `timestamp`, `eventId`.

### 3. SSE Memory Leaks
**Problem:** Per-connection listeners + unbounded `res.write` without backpressure = memory accumulation and crashes.
**Fix:**
- Handle `res.write()` return value and `drain` events
- Add heartbeat pings and idle timeout
- Disable proxy buffering (`X-Accel-Buffering: no`)
- Enforce `maxConcurrentStreams` in code

### 4. Database Write Amplification
**Problem:** Each activity = 2 synchronous writes (INSERT + UPDATE). Will block event loop.
**Fix:** Batch activity inserts (queue + flush), update `last_activity_at` every 1-5s or derive from latest activity row.

### 5. Migration Details Missing
**Problem:** "Update created_at to nullable" but SQLite can't `ALTER COLUMN` directly. Backfill plan unclear.
**Fix:** Write explicit table-rebuild migration + backfill: `started_at = created_at`, `completed_at = created_at`, `status = 'completed'` for historical data.

## High Priority (should address)

1. **Orphaned invocation states** - If DB operations fail, invocations may remain `running` forever. Add reconciler.
2. **Concurrent invocations** - SSE only loads latest invocation. Support multiple or enforce single active.
3. **Wrong indexes** - Create index DESC but query ASC. Use `(invocation_id, id)` composite index.
4. **No retention implementation** - Activity logs will explode. Implement scheduled purge.
5. **Security risk** - Activities may contain secrets. Add redaction/scrubbing + access control.
6. **EventEmitter single-process** - Breaks with multiple instances. Use Redis/NATS pub/sub.

## Medium Priority

1. **WebUI performance** - Unbounded array growth + frequent renders. Use ring buffer + virtualization.
2. **No reconnection handling** - Need `Last-Event-ID` support for gap-free streaming.
3. **Fragile parsing** - Chunk boundaries can split lines. Use line-buffered parser.
4. **Loose constraints** - Add CHECK constraints on status/activity_type + foreign key cascades.

## Questions

1. Can multiple invocations run simultaneously per task?
2. Source of truth for hang detection: column or latest row?
3. Expected activity rates and payload sizes?
4. Durability guarantees needed or best-effort acceptable?
5. AuthZ model for streaming? Redaction requirements?
6. Current `task_invocations` schema dependencies?
