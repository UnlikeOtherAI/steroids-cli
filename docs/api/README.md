# Steroids API

REST API for multi-project monitoring and management in the Steroids task automation system.

## Overview

The API provides HTTP endpoints to:
- List all registered Steroids projects
- Register/unregister projects
- Enable/disable projects for runner wakeup
- Prune stale projects
- Monitor project stats and runner status

## Installation

```bash
cd API
npm install
```

## Development

```bash
# Start development server with hot reload
npm run dev

# Build TypeScript
npm run build

# Start production server
npm start
```

## Configuration

Environment variables:
- `PORT` - Server port (default: 3501)

## API Endpoints

### GET /health
Health check endpoint

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-08T...",
  "version": "0.2.5"
}
```

### GET /api/health
Stuck-task health status summary for a single project.

**Query Parameters:**
- `project` - Project path (required)
- `includeSignals` - Include raw signal arrays (default: false)

**Response:**
```json
{
  "success": true,
  "project": "/Users/john/code/myapp",
  "health": {
    "status": "healthy",
    "lastCheck": "2026-02-10T12:00:00.000Z",
    "checks": [
      { "type": "orphaned_tasks", "healthy": true, "found": 0 },
      { "type": "hanging_invocations", "healthy": true, "found": 0 },
      { "type": "zombie_runners", "healthy": true, "found": 0 },
      { "type": "dead_runners", "healthy": true, "found": 0 }
    ],
    "activeIncidents": 0,
    "recentIncidents": 0
  }
}
```

### GET /api/incidents
Incident history for a single project.

**Query Parameters:**
- `project` - Project path (required)
- `limit` - Max rows to return (default: 50, max: 200)
- `task` - Filter by task ID prefix (optional)
- `unresolved` - `true` => only unresolved, `false` => only resolved (optional)

**Response:**
```json
{
  "success": true,
  "project": "/Users/john/code/myapp",
  "total": 2,
  "incidents": [
    {
      "id": "i1",
      "task_id": "t1",
      "runner_id": null,
      "failure_mode": "orphaned_task",
      "detected_at": "2026-02-10 12:00:00",
      "resolved_at": null,
      "resolution": null,
      "details": null,
      "created_at": "2026-02-10 12:00:00",
      "task_title": "Orphaned task"
    }
  ]
}
```

### GET /api/projects
List all registered projects with stats and runner info

**Query Parameters:**
- `include_disabled` - Include disabled projects (default: false)

**Response:**
```json
{
  "success": true,
  "projects": [
    {
      "path": "/Users/john/code/myapp",
      "name": "My App",
      "enabled": true,
      "registered_at": "2026-02-08T10:00:00Z",
      "last_seen_at": "2026-02-08T12:30:00Z",
      "stats": {
        "pending": 10,
        "in_progress": 1,
        "review": 2,
        "completed": 45
      },
      "runner": {
        "id": "abc123",
        "status": "active",
        "pid": 12345,
        "current_task_id": "task-456"
      }
    }
  ],
  "count": 1
}
```

### GET /api/projects/status
Get status for a single project

**Query Parameters:**
- `path` - Project path (required)

**Response:**
```json
{
  "success": true,
  "project": {
    "path": "/Users/john/code/myapp",
    "name": "My App",
    "enabled": true,
    "registered_at": "2026-02-08T10:00:00Z",
    "last_seen_at": "2026-02-08T12:30:00Z",
    "runner": null
  }
}
```

### POST /api/projects
Register a new project

**Request Body:**
```json
{
  "path": "/Users/john/code/myapp",
  "name": "My App"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Project registered successfully",
  "project": {
    "path": "/Users/john/code/myapp",
    "name": "My App",
    "enabled": true,
    "registered_at": "2026-02-08T12:00:00Z",
    "last_seen_at": "2026-02-08T12:00:00Z"
  }
}
```

### POST /api/projects/remove
Unregister a project

**Request Body:**
```json
{
  "path": "/Users/john/code/myapp"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Project unregistered successfully"
}
```

### POST /api/projects/enable
Enable a project for runner wakeup

**Request Body:**
```json
{
  "path": "/Users/john/code/myapp"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Project enabled successfully"
}
```

### POST /api/projects/disable
Disable a project (skip in wakeup)

**Request Body:**
```json
{
  "path": "/Users/john/code/myapp"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Project disabled successfully"
}
```

### POST /api/projects/prune
Remove stale projects (directories that no longer exist)

**Response:**
```json
{
  "success": true,
  "message": "Pruned 2 stale project(s)",
  "removed_count": 2
}
```

### GET /api/tasks/:taskId/stream
Stream live invocation activity for the currently running invocation using Server-Sent Events (SSE).

**Query Parameters:**
- `project` - Project path (required)

**Responses:**
- `200 text/event-stream` - SSE stream where each `data:` block is a JSON object
- `400 application/json` - Missing `project`
- `429 application/json` - Too many active streams

**Error behavior (SSE):**
- If the project database cannot be opened (for example, the project has no `.steroids/steroids.db`), the server still responds with `200 text/event-stream`, emits a single `data:` event like `{ "type": "error", "error": "Project database not found", "project": "<path>" }`, and then closes the connection.

**Event payloads (examples):**
```json
{ "type": "start", "ts": 1707567540123, "role": "coder", "provider": "codex", "model": "codex" }
{ "type": "tool", "ts": 1707567545678, "cmd": "rg -n 'verified email' src/" }
{ "type": "output", "ts": 1707567545890, "stream": "stdout", "msg": "Found 15 matches\n" }
{ "type": "complete", "ts": 1707567560456, "success": true, "duration": 20333 }
```

**Non-activity status events (examples):**
```json
{ "type": "no_active_invocation", "taskId": "task-123" }
{ "type": "waiting_for_log", "taskId": "task-123", "invocationId": 456 }
{ "type": "log_not_found", "taskId": "task-123", "invocationId": 456 }
{ "type": "error", "error": "Failed to stream invocation log", "message": "..." }
```

**Usage:**
```bash
curl -N "http://127.0.0.1:3501/api/tasks/<taskId>/stream?project=$(python -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$PWD")"
```

Notes:
- The stream follows the JSONL file at `.steroids/invocations/<invocationId>.log`.
- The server periodically sends SSE comments as a heartbeat (lines starting with `:`).

### GET /api/tasks/:taskId/timeline
Parse invocation JSONL activity logs on demand and return a sampled timeline.

**Query Parameters:**
- `project` - Project path (required)

**Response:**
```json
{
  "success": true,
  "timeline": [
    {
      "ts": 1707567540123,
      "type": "invocation.started",
      "invocationId": 456,
      "role": "coder",
      "provider": "codex",
      "model": "codex"
    },
    {
      "ts": 1707567545678,
      "type": "tool",
      "cmd": "rg -n 'verified email' src/",
      "invocationId": 456
    },
    {
      "ts": 1707567560456,
      "type": "invocation.completed",
      "invocationId": 456,
      "success": true,
      "duration": 20333
    }
  ]
}
```

Notes:
- The timeline includes DB-derived lifecycle events (`invocation.started`, `invocation.completed`) plus sampled JSONL activity entries.
- Sampling is best-effort and intended to keep payload sizes reasonable.

## Error Responses

All endpoints return errors in this format:
```json
{
  "success": false,
  "error": "Error description",
  "message": "Detailed error message"
}
```

HTTP status codes:
- `400` - Bad request (invalid input)
- `404` - Not found (project doesn't exist)
- `500` - Internal server error

## Security

- Path validation ensures only valid Steroids projects can be registered
- System directories (e.g., `/etc`, `/usr`) are blocked
- Projects must contain `.steroids/steroids.db` to be registered
- All paths are resolved to canonical form (symlinks resolved)

## Running Locally

```bash
# From the API directory
npm install
npm run build
npm start

# API available at http://localhost:3501
```

Or use the Makefile from the project root:
```bash
make launch
```

## Architecture

The API is a thin wrapper around the core `src/runners/projects.ts` module. It:
- Uses the global database at `~/.steroids/steroids.db`
- Does not require access to individual project databases
- Reads cached stats from the global database (updated by runners)
- Provides a stateless, read-mostly interface for monitoring tools

## Integration

The API is designed to be consumed by:
- WebUI dashboard (multi-project monitoring)
- CLI tools (alternative to direct database access)
- External monitoring systems (Prometheus, Grafana, etc.)
- CI/CD pipelines (project registration automation)
