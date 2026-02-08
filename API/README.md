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
