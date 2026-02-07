# WebUI Architecture

> For global coding rules (500-line limit, testability, patterns), see [CLAUDE.md](../CLAUDE.md)

## Overview

The Steroids WebUI is a developer dashboard built with React, Vite, and Fastify, using SSR for performance. It provides visibility into projects, tasks, and system health.

---

## Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| Frontend | React 19 + Vite | UI framework with SSR support |
| Styling | Tailwind CSS 4.x | Utility-first CSS with theming |
| State | React Context + TanStack Query | Local + server state |
| Backend | Fastify | API server with file-based storage |
| Real-time | WebSocket | Live updates |
| Package Manager | pnpm | Monorepo support |

---

## Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Presentation Layer                        │
│  Components, Pages, Layouts, Hooks                               │
├─────────────────────────────────────────────────────────────────┤
│                        Application Layer                         │
│  Services, State Management, API Clients                         │
├─────────────────────────────────────────────────────────────────┤
│                          Domain Layer                            │
│  Entities, Value Objects, Domain Services, Repositories         │
├─────────────────────────────────────────────────────────────────┤
│                       Infrastructure Layer                       │
│  Database, External APIs, File System, WebSocket                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
WebUI/
├── packages/
│   ├── api/                          # Backend (Fastify)
│   │   ├── src/
│   │   │   ├── domain/               # Domain Layer
│   │   │   │   ├── entities/
│   │   │   │   │   ├── Project.ts
│   │   │   │   │   ├── Task.ts
│   │   │   │   │   ├── HealthCheck.ts
│   │   │   │   │   └── index.ts
│   │   │   │   ├── value-objects/
│   │   │   │   │   ├── ProjectStatus.ts
│   │   │   │   │   ├── TaskPriority.ts
│   │   │   │   │   ├── HealthScore.ts
│   │   │   │   │   └── index.ts
│   │   │   │   ├── repositories/
│   │   │   │   │   ├── IProjectRepository.ts
│   │   │   │   │   ├── ITaskRepository.ts
│   │   │   │   │   ├── IHealthRepository.ts
│   │   │   │   │   └── index.ts
│   │   │   │   └── services/
│   │   │   │       ├── ProjectDomainService.ts
│   │   │   │       ├── TaskDomainService.ts
│   │   │   │       ├── HealthDomainService.ts
│   │   │   │       └── index.ts
│   │   │   │
│   │   │   ├── application/          # Application Layer
│   │   │   │   ├── use-cases/
│   │   │   │   │   ├── projects/
│   │   │   │   │   │   ├── ListProjectsUseCase.ts
│   │   │   │   │   │   ├── GetProjectUseCase.ts
│   │   │   │   │   │   ├── SyncProjectUseCase.ts
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   ├── tasks/
│   │   │   │   │   │   ├── ListTasksUseCase.ts
│   │   │   │   │   │   ├── UpdateTaskUseCase.ts
│   │   │   │   │   │   ├── SyncTasksUseCase.ts
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   └── health/
│   │   │   │   │       ├── GetHealthOverviewUseCase.ts
│   │   │   │   │       ├── RunHealthCheckUseCase.ts
│   │   │   │   │       └── index.ts
│   │   │   │   ├── dto/
│   │   │   │   │   ├── ProjectDTO.ts
│   │   │   │   │   ├── TaskDTO.ts
│   │   │   │   │   ├── HealthDTO.ts
│   │   │   │   │   └── index.ts
│   │   │   │   └── mappers/
│   │   │   │       ├── ProjectMapper.ts
│   │   │   │       ├── TaskMapper.ts
│   │   │   │       └── index.ts
│   │   │   │
│   │   │   ├── infrastructure/       # Infrastructure Layer
│   │   │   │   ├── persistence/
│   │   │   │   │   ├── file/
│   │   │   │   │   │   ├── FileProjectRepository.ts
│   │   │   │   │   │   ├── FileTaskRepository.ts
│   │   │   │   │   │   ├── FileHealthRepository.ts
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   └── in-memory/
│   │   │   │   │       ├── InMemoryProjectRepository.ts
│   │   │   │   │       ├── InMemoryTaskRepository.ts
│   │   │   │   │       └── index.ts
│   │   │   │   ├── filesystem/
│   │   │   │   │   ├── ProjectScanner.ts
│   │   │   │   │   ├── TodoParser.ts
│   │   │   │   │   ├── AgentsParser.ts
│   │   │   │   │   └── index.ts
│   │   │   │   ├── git/
│   │   │   │   │   ├── GitClient.ts
│   │   │   │   │   ├── GitActivityService.ts
│   │   │   │   │   └── index.ts
│   │   │   │   └── websocket/
│   │   │   │       ├── WebSocketServer.ts
│   │   │   │       ├── EventBroadcaster.ts
│   │   │   │       └── index.ts
│   │   │   │
│   │   │   ├── presentation/         # Presentation Layer (API)
│   │   │   │   ├── routes/
│   │   │   │   │   ├── projects/
│   │   │   │   │   │   ├── listProjects.ts
│   │   │   │   │   │   ├── getProject.ts
│   │   │   │   │   │   ├── syncProject.ts
│   │   │   │   │   │   ├── schemas.ts
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   ├── tasks/
│   │   │   │   │   │   ├── listTasks.ts
│   │   │   │   │   │   ├── updateTask.ts
│   │   │   │   │   │   ├── schemas.ts
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   └── health/
│   │   │   │   │       ├── getHealth.ts
│   │   │   │   │       ├── schemas.ts
│   │   │   │   │       └── index.ts
│   │   │   │   ├── middleware/
│   │   │   │   │   ├── errorHandler.ts
│   │   │   │   │   ├── requestLogger.ts
│   │   │   │   │   ├── cors.ts
│   │   │   │   │   └── index.ts
│   │   │   │   └── plugins/
│   │   │   │       ├── storagePlugin.ts
│   │   │   │       ├── websocketPlugin.ts
│   │   │   │       └── index.ts
│   │   │   │
│   │   │   ├── config/
│   │   │   │   ├── storage.ts
│   │   │   │   ├── server.ts
│   │   │   │   ├── environment.ts
│   │   │   │   └── index.ts
│   │   │   │
│   │   │   ├── container/            # Dependency Injection
│   │   │   │   ├── Container.ts
│   │   │   │   ├── bindings.ts
│   │   │   │   └── index.ts
│   │   │   │
│   │   │   └── main.ts               # Entry point
│   │   │
│   │   └── tests/
│   │       ├── unit/
│   │       ├── integration/
│   │       └── fixtures/
│   │
│   ├── web/                          # Frontend (React)
│   │   ├── src/
│   │   │   ├── domain/               # Domain Layer
│   │   │   │   ├── entities/
│   │   │   │   │   ├── Project.ts
│   │   │   │   │   ├── Task.ts
│   │   │   │   │   └── index.ts
│   │   │   │   └── value-objects/
│   │   │   │       ├── ProjectStatus.ts
│   │   │   │       └── index.ts
│   │   │   │
│   │   │   ├── application/          # Application Layer
│   │   │   │   ├── services/
│   │   │   │   │   ├── ProjectService.ts
│   │   │   │   │   ├── TaskService.ts
│   │   │   │   │   ├── HealthService.ts
│   │   │   │   │   └── index.ts
│   │   │   │   ├── stores/
│   │   │   │   │   ├── projectStore.ts
│   │   │   │   │   ├── taskStore.ts
│   │   │   │   │   ├── themeStore.ts
│   │   │   │   │   └── index.ts
│   │   │   │   └── hooks/
│   │   │   │       ├── useProjects.ts
│   │   │   │       ├── useTasks.ts
│   │   │   │       ├── useHealth.ts
│   │   │   │       ├── useTheme.ts
│   │   │   │       ├── useWebSocket.ts
│   │   │   │       └── index.ts
│   │   │   │
│   │   │   ├── infrastructure/       # Infrastructure Layer
│   │   │   │   ├── api/
│   │   │   │   │   ├── ApiClient.ts
│   │   │   │   │   ├── ProjectApi.ts
│   │   │   │   │   ├── TaskApi.ts
│   │   │   │   │   ├── HealthApi.ts
│   │   │   │   │   └── index.ts
│   │   │   │   ├── websocket/
│   │   │   │   │   ├── WebSocketClient.ts
│   │   │   │   │   ├── EventHandler.ts
│   │   │   │   │   └── index.ts
│   │   │   │   └── storage/
│   │   │   │       ├── LocalStorage.ts
│   │   │   │       ├── ThemeStorage.ts
│   │   │   │       └── index.ts
│   │   │   │
│   │   │   ├── presentation/         # Presentation Layer
│   │   │   │   ├── components/
│   │   │   │   │   ├── atoms/
│   │   │   │   │   │   ├── Button/
│   │   │   │   │   │   │   ├── Button.tsx
│   │   │   │   │   │   │   ├── Button.test.tsx
│   │   │   │   │   │   │   ├── Button.styles.ts
│   │   │   │   │   │   │   └── index.ts
│   │   │   │   │   │   ├── Badge/
│   │   │   │   │   │   ├── Input/
│   │   │   │   │   │   ├── Checkbox/
│   │   │   │   │   │   ├── Skeleton/
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   ├── molecules/
│   │   │   │   │   │   ├── StatusBadge/
│   │   │   │   │   │   ├── ProgressRing/
│   │   │   │   │   │   ├── MetricCard/
│   │   │   │   │   │   ├── SearchInput/
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   ├── organisms/
│   │   │   │   │   │   ├── ProjectCard/
│   │   │   │   │   │   ├── TaskList/
│   │   │   │   │   │   ├── TaskItem/
│   │   │   │   │   │   ├── HealthMatrix/
│   │   │   │   │   │   ├── ActivityFeed/
│   │   │   │   │   │   ├── CommandPalette/
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   ├── templates/
│   │   │   │   │   │   ├── DashboardLayout/
│   │   │   │   │   │   ├── ProjectLayout/
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   └── index.ts
│   │   │   │   │
│   │   │   │   ├── pages/
│   │   │   │   │   ├── Dashboard/
│   │   │   │   │   │   ├── Dashboard.tsx
│   │   │   │   │   │   ├── DashboardWidgets.tsx
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   ├── Projects/
│   │   │   │   │   │   ├── ProjectList.tsx
│   │   │   │   │   │   ├── ProjectDetail.tsx
│   │   │   │   │   │   ├── ProjectTasks.tsx
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   ├── Tasks/
│   │   │   │   │   │   ├── TasksPage.tsx
│   │   │   │   │   │   ├── TaskFilters.tsx
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   ├── Health/
│   │   │   │   │   │   ├── HealthPage.tsx
│   │   │   │   │   │   └── index.ts
│   │   │   │   │   └── Settings/
│   │   │   │   │       ├── SettingsPage.tsx
│   │   │   │   │       └── index.ts
│   │   │   │   │
│   │   │   │   ├── contexts/
│   │   │   │   │   ├── ThemeContext.tsx
│   │   │   │   │   ├── FilterContext.tsx
│   │   │   │   │   ├── WebSocketContext.tsx
│   │   │   │   │   └── index.ts
│   │   │   │   │
│   │   │   │   └── providers/
│   │   │   │       ├── AppProviders.tsx
│   │   │   │       └── index.ts
│   │   │   │
│   │   │   ├── config/
│   │   │   │   ├── routes.ts
│   │   │   │   ├── theme.ts
│   │   │   │   ├── constants.ts
│   │   │   │   └── index.ts
│   │   │   │
│   │   │   └── main.tsx
│   │   │
│   │   ├── server/                   # SSR Server
│   │   │   ├── entry-server.tsx
│   │   │   ├── entry-client.tsx
│   │   │   ├── dev-server.ts
│   │   │   ├── prod-server.ts
│   │   │   └── render.ts
│   │   │
│   │   └── tests/
│   │       ├── unit/
│   │       ├── integration/
│   │       └── e2e/
│   │
│   └── shared/                       # Shared Package
│       ├── src/
│       │   ├── types/
│       │   │   ├── project.ts
│       │   │   ├── task.ts
│       │   │   ├── health.ts
│       │   │   ├── api.ts
│       │   │   └── index.ts
│       │   ├── enums/
│       │   │   ├── ProjectCategory.ts
│       │   │   ├── ProjectStatus.ts
│       │   │   ├── TaskStatus.ts
│       │   │   ├── TaskPriority.ts
│       │   │   ├── HealthStatus.ts
│       │   │   └── index.ts
│       │   ├── utils/
│       │   │   ├── validation.ts
│       │   │   ├── formatting.ts
│       │   │   ├── dates.ts
│       │   │   └── index.ts
│       │   └── constants/
│       │       ├── api.ts
│       │       ├── limits.ts
│       │       └── index.ts
│       └── tests/
```

---

## Component Design (Atomic)

### Hierarchy

```
atoms/        → Basic UI elements (Button, Input, Badge)
molecules/    → Combinations of atoms (StatusBadge, MetricCard)
organisms/    → Complex UI sections (ProjectCard, TaskList)
templates/    → Page layouts (DashboardLayout)
pages/        → Full pages composed of templates + organisms
```

### Component Structure

Each component folder contains:
```
Button/
├── Button.tsx        # Component implementation
├── Button.test.tsx   # Unit tests
├── Button.styles.ts  # Tailwind variants (if complex)
└── index.ts          # Public export
```

---

## SSR Implementation

### Entry Points

```typescript
// server/entry-server.tsx
export function render(url: string, initialData: AppData): string {
  return renderToString(
    <StaticRouter location={url}>
      <App initialData={initialData} />
    </StaticRouter>
  );
}

// server/entry-client.tsx
const initialData = window.__INITIAL_DATA__;
delete window.__INITIAL_DATA__;

hydrateRoot(
  document.getElementById('root')!,
  <BrowserRouter>
    <App initialData={initialData} />
  </BrowserRouter>
);
```

### Data Hydration

```typescript
// server/prod-server.ts
app.get('*', async (req, res) => {
  const initialData = await loadRouteData(req.path);
  const html = render(req.url, initialData);

  const finalHtml = template
    .replace('<!--app-html-->', html)
    .replace(
      '<!--app-data-->',
      `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)}</script>`
    );

  res.send(finalHtml);
});
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

### Theme Context

```typescript
// contexts/ThemeContext.tsx
type Theme = 'light' | 'dark' | 'system';

export function ThemeProvider({ children }: PropsWithChildren) {
  const [theme, setTheme] = useState<Theme>(() =>
    localStorage.getItem('theme') as Theme ?? 'system'
  );

  const resolved = theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme, resolved]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
```

---

## API Design

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects (paginated, filterable) |
| GET | `/api/projects/:slug` | Get single project |
| POST | `/api/projects/:slug/sync` | Sync project from filesystem |
| GET | `/api/tasks` | List all tasks |
| GET | `/api/projects/:slug/tasks` | List project tasks |
| PATCH | `/api/tasks/:id` | Update task status |
| GET | `/api/health` | System health overview |
| WS | `/ws` | Real-time updates |

### Response Format

```typescript
interface ApiResponse<T> {
  data: T;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    pages: number;
  };
}
```

---

## WebSocket Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `project:updated` | Server → Client | `{ id, status, healthScore }` |
| `task:updated` | Server → Client | `{ id, status }` |
| `health:changed` | Server → Client | `{ projectId, status }` |
| `subscribe` | Client → Server | `{ channels: string[] }` |

---

## Testing Strategy

### Unit Tests (Vitest)
- Test components in isolation
- Mock API calls with MSW
- Target: 80% coverage

### Integration Tests
- Test API routes with test database
- Test repository implementations

### E2E Tests (Playwright)
- Critical user flows
- Theme switching
- Task management

---

## Performance Targets

| Metric | Target |
|--------|--------|
| First Contentful Paint | < 1.0s |
| Time to Interactive | < 2.5s |
| Largest Contentful Paint | < 2.0s |
| Bundle Size (gzipped) | < 150KB |
