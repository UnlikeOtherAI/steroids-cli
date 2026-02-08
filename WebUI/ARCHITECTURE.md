# WebUI Architecture

> [!NOTE]
> **Multi-Project Support Added** - The WebUI now supports multi-project monitoring via the Global Runner Registry.
>
> Key features:
> - Project selector dropdown to switch between registered projects
> - `/api/projects` endpoints for project management
> - Global database (`~/.steroids/steroids.db`) access for cross-project state
> - Per-project deep-dive while maintaining cross-project awareness
>
> For lightweight Mac menu bar monitoring, see [Monitor](../Monitor/ARCHITECTURE.md).

---

> For global coding rules (500-line limit, testability, patterns), see [CLAUDE.md](../CLAUDE.md)

## Overview

The Steroids WebUI is a developer dashboard built with React and Vite (CSR), with a separate Fastify API backend. It provides full administrative control over projects, tasks, runners, disputes, and system configuration.

**Key Principle: The WebUI must allow complete administration of everything in the Steroids system.**

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Frontend | React 19 + Vite | CSR UI framework |
| Styling | Tailwind CSS 4.x | Utility-first CSS with theming |
| State | React Context + TanStack Query | Local + server state |
| Backend | Fastify | REST API server |
| Real-time | WebSocket | Live updates |
| Container | Docker | Deployment |
| Package Manager | pnpm | Monorepo support |

---

## Directory Structure

```
/WebUI                           # React Frontend (CSR)
├── src/
│   ├── components/              # Reusable UI components
│   │   ├── atoms/               # Basic elements (Button, Input)
│   │   ├── molecules/           # Combinations (StatusBadge, MetricCard)
│   │   ├── organisms/           # Complex sections (TaskList, RunnerCard)
│   │   └── layouts/             # Page layouts (MainLayout, DetailLayout)
│   ├── pages/                   # One page per route
│   ├── hooks/                   # Custom React hooks
│   ├── services/                # API clients
│   ├── stores/                  # State management
│   ├── types/                   # TypeScript types
│   └── main.tsx                 # Entry point
├── public/
├── Dockerfile
├── vite.config.ts
└── package.json

/API                             # Fastify Backend
├── src/
│   ├── routes/                  # API endpoints
│   │   ├── tasks/
│   │   ├── sections/
│   │   ├── runners/
│   │   ├── disputes/
│   │   ├── config/
│   │   ├── locks/
│   │   ├── health/
│   │   ├── logs/
│   │   └── system/
│   ├── services/                # Business logic
│   ├── middleware/              # Auth, logging, CORS
│   ├── websocket/               # Real-time events
│   └── main.ts                  # Entry point
├── Dockerfile
└── package.json

/docker-compose.yml              # Orchestrates web + api
/Makefile                        # Development commands
```

---

## UI Design Principles (CRITICAL)

### 1. Single Responsibility Pages

**Each page does ONE thing.** No pages with mixed functionalities.

```
BAD:  /tasks - Lists tasks AND allows editing AND shows details
GOOD: /tasks - Lists tasks only
      /tasks/:id - Shows task details only
      /tasks/:id/edit - Edits task only
```

### 2. Click to Navigate

**Lists are navigation, not inline editing.**

```tsx
// BAD: Inline editing in list
<TaskList>
  {tasks.map(task => (
    <TaskRow>
      <EditableTitle />
      <StatusDropdown />
      <DeleteButton />
    </TaskRow>
  ))}
</TaskList>

// GOOD: Click to navigate to detail page
<TaskList>
  {tasks.map(task => (
    <TaskRow onClick={() => navigate(`/tasks/${task.id}`)}>
      <TaskTitle />
      <TaskStatus />
    </TaskRow>
  ))}
</TaskList>
```

### 3. Reusable Components

**Split components for maximum reuse.**

```
atoms/           → Button, Input, Badge, Skeleton, Icon
molecules/       → StatusBadge, MetricCard, SearchInput, Pagination
organisms/       → TaskCard, RunnerCard, DisputeCard, LogViewer
layouts/         → MainLayout, DetailLayout, FormLayout
pages/           → Composed of layouts + organisms
```

### 4. Component File Structure

```
TaskCard/
├── TaskCard.tsx        # Component implementation
├── TaskCard.test.tsx   # Unit tests
├── TaskCard.types.ts   # TypeScript interfaces
└── index.ts            # Public export
```

---

## Page Structure

### Dashboard
- `/` - Overview with key metrics (task counts, runner status, health)
- **Project Selector** - Dropdown in header to switch between registered projects
- `/projects` - Project management (list, add, remove, enable/disable)

### Tasks
- `/tasks` - Task list with filters (status, section)
- `/tasks/new` - Create new task
- `/tasks/:id` - Task detail view (info, audit trail, logs)
- `/tasks/:id/edit` - Edit task (status, priority, notes)

### Sections
- `/sections` - Section list
- `/sections/new` - Create new section
- `/sections/:id` - Section detail (tasks in section)
- `/sections/:id/edit` - Edit section

### Runners
- `/runners` - Runner list with status
- `/runners/:id` - Runner detail (logs, current task)
- `/runners/:id/logs` - Full log viewer

### Disputes
- `/disputes` - Dispute list (open, resolved)
- `/disputes/:id` - Dispute detail (positions, resolution)
- `/disputes/:id/resolve` - Resolution form

### Configuration
- `/config` - Config overview
- `/config/edit` - Edit configuration
- `/config/providers` - AI provider settings

### Locks
- `/locks` - Active locks overview (task and section locks)
- `/locks/tasks` - Task lock details
- `/locks/sections` - Section lock details

### Logs
- `/logs` - Log browser with filters
- `/logs/:id` - Individual log detail
- `/logs/tail` - Live log tailing (real-time stream)

### Health
- `/health` - Health overview
- `/health/:check` - Individual health check detail

### System
- `/system` - System status (version, uptime)
- `/system/backup` - Backup management
- `/system/restore` - Restore from backup
- `/system/migrations` - Migration status
- `/system/gc` - Garbage collection management
- `/system/purge` - Data purge management
- `/system/hooks` - Hook configuration
- `/system/cron` - Scheduled task management (wakeup, auto-restart)

---

## API Endpoints

### Tasks
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks` | List tasks (filterable, paginated) |
| POST | `/api/tasks` | Create new task |
| GET | `/api/tasks/:id` | Get task detail |
| PATCH | `/api/tasks/:id` | Update task |
| POST | `/api/tasks/:id/approve` | Approve task |
| POST | `/api/tasks/:id/reject` | Reject task |
| DELETE | `/api/tasks/:id` | Delete task |
| GET | `/api/tasks/:id/audit` | Get task audit trail |

### Sections
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sections` | List sections |
| GET | `/api/sections/:id` | Get section detail |
| POST | `/api/sections` | Create section |
| PATCH | `/api/sections/:id` | Update section |
| DELETE | `/api/sections/:id` | Delete section |

### Runners
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/runners` | List runners |
| GET | `/api/runners/:id` | Get runner detail |
| POST | `/api/runners/start` | Start runner |
| POST | `/api/runners/:id/stop` | Stop runner |
| POST | `/api/runners/:id/restart` | Restart runner |
| GET | `/api/runners/:id/logs` | Get runner logs |
| GET | `/api/runners/:id/logs/tail` | Stream logs in real-time (SSE) |

### Disputes
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/disputes` | List disputes |
| GET | `/api/disputes/:id` | Get dispute detail |
| POST | `/api/disputes` | Create dispute |
| POST | `/api/disputes/:id/resolve` | Resolve dispute |

### Configuration
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Get configuration |
| PATCH | `/api/config` | Update configuration |
| GET | `/api/config/schema` | Get config schema |
| GET | `/api/config/providers` | List AI provider settings |
| PATCH | `/api/config/providers` | Update AI provider settings |

### Locks
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/locks` | List all active locks |
| GET | `/api/locks/tasks` | List task locks |
| GET | `/api/locks/sections` | List section locks |
| DELETE | `/api/locks/tasks/:id` | Force release task lock |
| DELETE | `/api/locks/sections/:id` | Force release section lock |
| DELETE | `/api/locks/stale` | Clean up stale locks |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Get health status |
| POST | `/api/health/check` | Run health check |

### Logs
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/logs` | List logs (filterable) |
| GET | `/api/logs/:id` | Get log content |
| DELETE | `/api/logs` | Purge old logs |

### Projects (Multi-Project Support)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all registered projects with stats |
| POST | `/api/projects` | Register a new project (body: {path, name?}) |
| POST | `/api/projects/remove` | Remove a project (body: {path}) |
| POST | `/api/projects/enable` | Enable a project (body: {path}) |
| POST | `/api/projects/disable` | Disable a project (body: {path}) |
| POST | `/api/projects/prune` | Remove projects with missing directories |
| GET | `/api/projects/status` | Get single project status (query: ?path=...) |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/system/status` | Get system status |
| POST | `/api/system/backup` | Create backup |
| GET | `/api/system/backups` | List backups |
| POST | `/api/system/restore` | Restore backup |
| GET | `/api/system/migrations` | Migration status |
| POST | `/api/system/migrate` | Run migrations |
| GET | `/api/system/gc` | Get GC status and stats |
| POST | `/api/system/gc` | Run garbage collection |
| GET | `/api/system/purge` | Get purge status |
| POST | `/api/system/purge` | Run data purge |
| GET | `/api/system/hooks` | List configured hooks |
| PUT | `/api/system/hooks` | Update hook configuration |
| GET | `/api/system/cron` | Get cron/wakeup settings |
| PUT | `/api/system/cron` | Update cron/wakeup settings |
| POST | `/api/system/wakeup` | Trigger manual wakeup |

### WebSocket
| Event | Direction | Payload |
|-------|-----------|---------|
| `task:created` | Server → Client | `{ id, title, status, sectionId }` |
| `task:updated` | Server → Client | `{ id, status, ... }` |
| `task:deleted` | Server → Client | `{ id }` |
| `section:created` | Server → Client | `{ id, name, position }` |
| `section:updated` | Server → Client | `{ id, name, position }` |
| `section:deleted` | Server → Client | `{ id }` |
| `runner:started` | Server → Client | `{ id, pid, projectPath }` |
| `runner:updated` | Server → Client | `{ id, status, task }` |
| `runner:stopped` | Server → Client | `{ id, exitCode }` |
| `dispute:created` | Server → Client | `{ id, taskId, type }` |
| `dispute:resolved` | Server → Client | `{ id, resolution, winner }` |
| `config:updated` | Server → Client | `{ key, value }` |
| `health:changed` | Server → Client | `{ score, checks }` |
| `log:appended` | Server → Client | `{ runnerId, line }` |
| `gc:started` | Server → Client | `{ timestamp }` |
| `gc:completed` | Server → Client | `{ removed, duration }` |
| `purge:started` | Server → Client | `{ timestamp }` |
| `purge:completed` | Server → Client | `{ removed, duration }` |
| `backup:created` | Server → Client | `{ id, path, size }` |

---

## Docker Configuration

### Ports
- **3500** - Web UI (React frontend)
- **3501** - API (Fastify backend)

### Docker Hub
- **Organization**: `unlikeotherai` (primary)
- **Fallback**: `rafiki270` (if org unavailable)
- **Images**:
  - `unlikeotherai/steroids-web:latest`
  - `unlikeotherai/steroids-api:latest`

### docker-compose.yml

```yaml
version: '3.8'
services:
  api:
    image: unlikeotherai/steroids-api:latest
    container_name: steroids-api
    ports:
      - "3501:3501"
    volumes:
      # Global database for cross-project state (runners, projects registry)
      - ~/.steroids:/root/.steroids:ro
      # Current project database (tasks, sections, audit)
      - ./.steroids:/app/.steroids
    environment:
      - PORT=3501
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3501/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"]
      interval: 30s
      timeout: 3s
      start_period: 5s
      retries: 3

  web:
    image: unlikeotherai/steroids-web:latest
    container_name: steroids-web
    ports:
      - "3500:3500"
    environment:
      - VITE_API_URL=http://localhost:3501
    restart: unless-stopped
    depends_on:
      - api
```

> **Note:** The API reads from the global database (`~/.steroids/steroids.db`) for project registry and runner state, while project-specific data comes from the mounted `.steroids` directory.

---

## Makefile

```makefile
.PHONY: help launch build push

# Default target - show help
help:
	@echo "Steroids WebUI Development"
	@echo ""
	@echo "Usage:"
	@echo "  make launch    - Launch web and API in development mode"
	@echo "  make build     - Build Docker images"
	@echo "  make push      - Push images to Docker Hub"
	@echo "  make clean     - Clean build artifacts"
	@echo ""

# Launch development environment
launch:
	@echo "Starting Steroids WebUI..."
	docker-compose up --build

# Build production images
build:
	docker build -t unlikeotherai/steroids-web:latest ./WebUI
	docker build -t unlikeotherai/steroids-api:latest ./API

# Push to Docker Hub
push: build
	docker push unlikeotherai/steroids-web:latest
	docker push unlikeotherai/steroids-api:latest

# Clean up
clean:
	docker-compose down -v
	rm -rf WebUI/dist API/dist
```

---

## CLI Integration

### `steroids ui launch`

Launches the WebUI in a Docker container.

```bash
steroids ui launch [options]

Options:
  --detach              Run in background
  --port <port>         Web UI port (default: 3500)
  --api-port <port>     API port (default: 3501)
  --no-pull             Skip pulling latest image
  -h, --help            Show help

Examples:
  steroids ui launch                    # Launch with latest image
  steroids ui launch --detach           # Run in background
  steroids ui launch --port 8080        # Custom port
```

**Behavior:**
1. Check for latest image: `docker pull unlikeotherai/steroids-web:latest`
2. Start containers via docker-compose
3. Open browser to `http://localhost:3500`
4. Stream logs (unless `--detach`)

### `steroids ui stop`

Stops the WebUI containers.

```bash
steroids ui stop
```

### `steroids ui status`

Shows WebUI container status.

```bash
steroids ui status

Output:
  Web UI: Running (http://localhost:3500)
  API:    Running (http://localhost:3501)
  Uptime: 2h 15m
```

---

## Theming (Light/Dark)

### CSS Variables

```css
:root {
  --background: 0 0% 100%;
  --surface: 0 0% 98%;
  --text-primary: 0 0% 9%;
  --text-muted: 0 0% 45%;
  --accent: 217 91% 60%;
  --success: 142 71% 45%;
  --warning: 38 92% 50%;
  --danger: 0 72% 51%;
}

.dark {
  --background: 0 0% 9%;
  --surface: 0 0% 12%;
  --text-primary: 0 0% 98%;
  --text-muted: 0 0% 55%;
}
```

---

## Testing Strategy

### Unit Tests (Vitest)
- Test components in isolation
- Mock API calls with MSW
- Target: 80% coverage

### Integration Tests
- Test API routes with test database
- Test WebSocket events

### E2E Tests (Playwright)
- Critical user flows
- Navigation patterns
- Theme switching

---

## Performance Targets

| Metric | Target |
|--------|--------|
| First Contentful Paint | < 1.5s |
| Time to Interactive | < 3.0s |
| Largest Contentful Paint | < 2.5s |
| Bundle Size (gzipped) | < 200KB |

---

## Related Documentation

- [CLAUDE.md](../CLAUDE.md) - Coding standards and release workflow
- [CLI/COMMANDS.md](../CLI/COMMANDS.md) - CLI reference
- [API/README.md](../API/README.md) - API documentation
