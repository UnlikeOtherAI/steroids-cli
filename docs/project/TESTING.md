# Testing Guide

> For global coding rules, see [CLAUDE.md](../../CLAUDE.md)

## Overview

Steroids uses a layered testing approach:

| Layer | Tool | Purpose |
|-------|------|---------|
| Unit | Vitest | Domain logic, pure functions |
| Integration | Vitest | API routes, repositories |
| E2E | Playwright | User flows, WebUI |
| CLI | Vitest + execa | Command execution |

---

## Test Structure

```
tests/
├── unit/
│   ├── domain/
│   │   ├── entities/
│   │   │   ├── Project.test.ts
│   │   │   └── Task.test.ts
│   │   └── value-objects/
│   │       └── TaskStatus.test.ts
│   └── application/
│       └── use-cases/
│           ├── ListProjectsUseCase.test.ts
│           └── UpdateTaskUseCase.test.ts
├── integration/
│   ├── api/
│   │   ├── projects.test.ts
│   │   └── tasks.test.ts
│   └── repositories/
│       ├── FileProjectRepository.test.ts
│       └── FileTaskRepository.test.ts
├── e2e/
│   ├── dashboard.spec.ts
│   ├── projects.spec.ts
│   └── tasks.spec.ts
└── fixtures/
    ├── projects.ts
    ├── tasks.ts
    └── factory.ts
```

---

## Running Tests

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run specific test file
pnpm test src/domain/entities/Project.test.ts

# Run tests in watch mode
pnpm test:watch

# Run E2E tests
pnpm test:e2e

# Run E2E with UI
pnpm test:e2e --ui
```

---

## Unit Tests

### Naming Convention

```typescript
// File: <Name>.test.ts
// Pattern: describe('<ClassName>', () => { describe('<methodName>', () => { it('<behavior>') }) })

describe('Project', () => {
  describe('isHealthy', () => {
    it('returns true when healthScore >= 80', () => {
      // ...
    });

    it('returns false when healthScore < 80', () => {
      // ...
    });

    it('returns false when healthScore is null', () => {
      // ...
    });
  });
});
```

### Entity Tests

```typescript
// tests/unit/domain/entities/Project.test.ts
import { describe, it, expect } from 'vitest';
import { Project } from '@/domain/entities/Project';
import { ProjectCategory, ProjectStatus } from '@/shared/enums';

describe('Project', () => {
  const validProps = {
    name: 'Test Project',
    slug: 'test-project',
    path: '/projects/test',
    category: ProjectCategory.TOOL,
    status: ProjectStatus.ACTIVE,
    healthScore: 85,
    lastActivity: new Date(),
  };

  describe('create', () => {
    it('creates a project with a generated id', () => {
      const project = Project.create(validProps);

      expect(project.id).toBeDefined();
      expect(project.id).toHaveLength(36); // UUID
      expect(project.name).toBe('Test Project');
    });

    it('validates name is not empty', () => {
      expect(() => Project.create({ ...validProps, name: '' }))
        .toThrow('Name is required');
    });
  });

  describe('isHealthy', () => {
    it('returns true when healthScore >= 80', () => {
      const project = Project.create({ ...validProps, healthScore: 80 });
      expect(project.isHealthy()).toBe(true);
    });

    it('returns false when healthScore < 80', () => {
      const project = Project.create({ ...validProps, healthScore: 79 });
      expect(project.isHealthy()).toBe(false);
    });

    it('returns false when healthScore is null', () => {
      const project = Project.create({ ...validProps, healthScore: null });
      expect(project.isHealthy()).toBe(false);
    });
  });

  describe('updateHealthScore', () => {
    it('returns a new project with updated score', () => {
      const original = Project.create({ ...validProps, healthScore: 50 });
      const updated = original.updateHealthScore(90);

      expect(updated.healthScore).toBe(90);
      expect(original.healthScore).toBe(50); // Immutable
    });

    it('clamps score to 0-100 range', () => {
      const project = Project.create(validProps);

      expect(project.updateHealthScore(150).healthScore).toBe(100);
      expect(project.updateHealthScore(-10).healthScore).toBe(0);
    });
  });
});
```

### Value Object Tests

```typescript
// tests/unit/domain/value-objects/TaskStatus.test.ts
import { describe, it, expect } from 'vitest';
import { TaskStatus } from '@/domain/value-objects/TaskStatus';

describe('TaskStatus', () => {
  describe('fromCheckbox', () => {
    it('parses space as pending', () => {
      expect(TaskStatus.fromCheckbox(' ')).toEqual(TaskStatus.pending());
    });

    it('parses x as completed', () => {
      expect(TaskStatus.fromCheckbox('x')).toEqual(TaskStatus.completed());
    });

    it('parses X as completed (case insensitive)', () => {
      expect(TaskStatus.fromCheckbox('X')).toEqual(TaskStatus.completed());
    });

    it('parses - as in_progress', () => {
      expect(TaskStatus.fromCheckbox('-')).toEqual(TaskStatus.inProgress());
    });
  });

  describe('toCheckbox', () => {
    it('converts pending to space', () => {
      expect(TaskStatus.pending().toCheckbox()).toBe(' ');
    });

    it('converts completed to x', () => {
      expect(TaskStatus.completed().toCheckbox()).toBe('x');
    });
  });

  describe('equals', () => {
    it('returns true for same status', () => {
      expect(TaskStatus.pending().equals(TaskStatus.pending())).toBe(true);
    });

    it('returns false for different status', () => {
      expect(TaskStatus.pending().equals(TaskStatus.completed())).toBe(false);
    });
  });
});
```

### Use Case Tests

```typescript
// tests/unit/application/use-cases/ListProjectsUseCase.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListProjectsUseCase } from '@/application/use-cases/projects';
import { InMemoryProjectRepository } from '@/infrastructure/persistence/in-memory';
import { ProjectMapper } from '@/application/mappers';

describe('ListProjectsUseCase', () => {
  let useCase: ListProjectsUseCase;
  let repository: InMemoryProjectRepository;
  let mapper: ProjectMapper;

  beforeEach(() => {
    repository = new InMemoryProjectRepository();
    mapper = new ProjectMapper();
    useCase = new ListProjectsUseCase(repository, mapper);
  });

  it('returns empty list when no projects exist', async () => {
    const result = await useCase.execute({});

    expect(result.projects).toHaveLength(0);
    expect(result.pagination.total).toBe(0);
  });

  it('returns paginated projects', async () => {
    // Seed 25 projects
    for (let i = 0; i < 25; i++) {
      await repository.save(createTestProject({ name: `Project ${i}` }));
    }

    const result = await useCase.execute({
      pagination: { page: 1, pageSize: 10 }
    });

    expect(result.projects).toHaveLength(10);
    expect(result.pagination.total).toBe(25);
    expect(result.pagination.pages).toBe(3);
  });

  it('filters by category', async () => {
    await repository.save(createTestProject({ category: ProjectCategory.TOOL }));
    await repository.save(createTestProject({ category: ProjectCategory.SAAS }));

    const result = await useCase.execute({
      filters: { category: ProjectCategory.TOOL }
    });

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].category).toBe(ProjectCategory.TOOL);
  });
});
```

---

## Integration Tests

### API Route Tests

```typescript
// tests/integration/api/projects.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp } from '../helpers/app';
import { seedTestData, clearTestData } from '../helpers/fixtures';

describe('GET /api/projects', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createTestApp();
    await seedTestData();
  });

  afterAll(async () => {
    await clearTestData();
    await app.close();
  });

  it('returns paginated project list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(body.pagination).toMatchObject({
      page: 1,
      pageSize: expect.any(Number),
      total: expect.any(Number),
      pages: expect.any(Number),
    });
  });

  it('filters by status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects?status=active',
    });

    const body = response.json();
    expect(body.data.every((p: any) => p.status === 'active')).toBe(true);
  });

  it('returns 400 for invalid status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects?status=invalid',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('PATCH /api/tasks/:id', () => {
  it('updates task status', async () => {
    const taskId = 'test-task-id';

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      payload: { status: 'completed' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('completed');
  });

  it('returns 404 for non-existent task', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/tasks/non-existent',
      payload: { status: 'completed' },
    });

    expect(response.statusCode).toBe(404);
  });
});
```

### Repository Tests

```typescript
// tests/integration/repositories/FileProjectRepository.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileProjectRepository } from '@/infrastructure/persistence/file';

describe('FileProjectRepository', () => {
  let testDir: string;
  let repository: FileProjectRepository;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'steroids-test-'));
    repository = new FileProjectRepository(testDir);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true });
  });

  beforeEach(async () => {
    await repository.clear();
  });

  describe('save', () => {
    it('persists a new project', async () => {
      const project = Project.create({
        name: 'Test',
        slug: 'test',
        path: '/test',
        category: ProjectCategory.TOOL,
        status: ProjectStatus.ACTIVE,
        healthScore: null,
        lastActivity: null,
      });

      await repository.save(project);

      const found = await repository.findById(project.id);

      expect(found).not.toBeNull();
      expect(found?.name).toBe('Test');
    });
  });

  describe('findBySlug', () => {
    it('returns project by slug', async () => {
      const project = Project.create({
        name: 'Test',
        slug: 'my-slug',
        path: '/test',
        category: ProjectCategory.TOOL,
        status: ProjectStatus.ACTIVE,
      });

      await repository.save(project);

      const found = await repository.findBySlug('my-slug');

      expect(found).not.toBeNull();
      expect(found?.slug).toBe('my-slug');
    });

    it('returns null for non-existent slug', async () => {
      const project = await repository.findBySlug('non-existent');
      expect(project).toBeNull();
    });
  });
});
```

---

## E2E Tests

### Playwright Setup

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],

  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

### E2E Test Examples

```typescript
// tests/e2e/dashboard.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test('loads and displays project grid', async ({ page }) => {
    await page.goto('/');

    // Quick stats visible
    await expect(page.getByTestId('quick-stats')).toBeVisible();

    // Project grid loads
    await expect(page.getByTestId('project-grid')).toBeVisible();
  });

  test('navigates to project detail', async ({ page }) => {
    await page.goto('/');

    // Click first project card
    await page.getByTestId('project-card').first().click();

    // Should navigate to project detail
    await expect(page).toHaveURL(/\/projects\/[\w-]+/);
  });
});

// tests/e2e/tasks.spec.ts
test.describe('Tasks', () => {
  test('can toggle task status', async ({ page }) => {
    await page.goto('/tasks');

    const firstTask = page.getByTestId('task-item').first();
    const checkbox = firstTask.getByRole('checkbox');

    // Toggle task
    await checkbox.click();

    // Should be checked (optimistic update)
    await expect(checkbox).toBeChecked();
  });

  test('filters tasks by status', async ({ page }) => {
    await page.goto('/tasks');

    // Select "Completed" filter
    await page.getByRole('combobox', { name: 'Status' }).selectOption('completed');

    // All visible tasks should be completed
    const tasks = page.getByTestId('task-item');
    for (const task of await tasks.all()) {
      await expect(task.getByRole('checkbox')).toBeChecked();
    }
  });
});

// tests/e2e/theme.spec.ts
test.describe('Theme', () => {
  test('persists theme preference', async ({ page }) => {
    await page.goto('/');

    // Toggle to dark mode
    await page.getByRole('button', { name: /toggle theme/i }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Reload page
    await page.reload();

    // Should still be dark
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});
```

---

## CLI Tests

```typescript
// tests/integration/cli/scan.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('steroids scan', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'steroids-test-'));

    // Create test project structure
    await mkdir(join(testDir, 'my-project'));
    await writeFile(
      join(testDir, 'my-project', 'package.json'),
      JSON.stringify({ name: 'my-project' })
    );
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true });
  });

  it('discovers projects with package.json', async () => {
    const { stdout } = await execa('steroids', ['scan', testDir]);

    expect(stdout).toContain('my-project');
  });

  it('outputs JSON with --json flag', async () => {
    const { stdout } = await execa('steroids', ['scan', testDir, '--json']);

    const result = JSON.parse(stdout);
    expect(result.projects).toBeInstanceOf(Array);
    expect(result.projects[0].name).toBe('my-project');
  });

  it('respects ignored patterns', async () => {
    await mkdir(join(testDir, 'node_modules', 'hidden'));
    await writeFile(
      join(testDir, 'node_modules', 'hidden', 'package.json'),
      '{}'
    );

    const { stdout } = await execa('steroids', ['scan', testDir, '--json']);
    const result = JSON.parse(stdout);

    expect(result.projects.every((p: any) => !p.path.includes('node_modules'))).toBe(true);
  });
});
```

---

## Test Fixtures

```typescript
// tests/fixtures/factory.ts
import { Project } from '@/domain/entities/Project';
import { Task } from '@/domain/entities/Task';
import { ProjectCategory, ProjectStatus, TaskStatus, TaskPriority } from '@/shared/enums';

let projectCounter = 0;
let taskCounter = 0;

export function createTestProject(overrides: Partial<ProjectProps> = {}): Project {
  projectCounter++;
  return Project.create({
    name: `Test Project ${projectCounter}`,
    slug: `test-project-${projectCounter}`,
    path: `/test/projects/${projectCounter}`,
    category: ProjectCategory.TOOL,
    status: ProjectStatus.ACTIVE,
    healthScore: 85,
    lastActivity: new Date(),
    ...overrides,
  });
}

export function createTestTask(overrides: Partial<TaskProps> = {}): Task {
  taskCounter++;
  return Task.create({
    projectId: 'test-project-id',
    title: `Test Task ${taskCounter}`,
    status: TaskStatus.PENDING,
    priority: TaskPriority.MEDIUM,
    ...overrides,
  });
}

// Reset counters between tests
export function resetFactories(): void {
  projectCounter = 0;
  taskCounter = 0;
}
```

---

## Coverage Requirements

| Component | Minimum Coverage |
|-----------|-----------------|
| Domain entities | 90% |
| Value objects | 95% |
| Use cases | 85% |
| Repositories | 80% |
| API routes | 80% |
| React components | 70% |
| CLI commands | 75% |

### Coverage Configuration

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/types/**',
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
```

---

## Mocking

### API Mocking with MSW

```typescript
// tests/mocks/handlers.ts
import { http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/projects', () => {
    return HttpResponse.json({
      data: [
        { id: '1', name: 'Project 1', status: 'active' },
        { id: '2', name: 'Project 2', status: 'active' },
      ],
      pagination: { page: 1, pageSize: 20, total: 2, pages: 1 },
    });
  }),

  http.patch('/api/tasks/:id', async ({ params, request }) => {
    const body = await request.json();
    return HttpResponse.json({
      id: params.id,
      ...body,
    });
  }),
];

// tests/mocks/server.ts
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);

// tests/setup.ts
import { beforeAll, afterAll, afterEach } from 'vitest';
import { server } from './mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());
```

### Repository Mocking

```typescript
// Use in-memory repositories for unit tests
import { InMemoryProjectRepository } from '@/infrastructure/persistence/in-memory';

const repository = new InMemoryProjectRepository();

// Or mock with vi.mock
vi.mock('@/infrastructure/persistence/file', () => ({
  FileProjectRepository: vi.fn().mockImplementation(() => ({
    findAll: vi.fn().mockResolvedValue({ data: [], pagination: {} }),
    save: vi.fn().mockResolvedValue(undefined),
  })),
}));
```

---

## CI Configuration

```yaml
# .github/workflows/test.yml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v2
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Run tests
        run: pnpm test:coverage

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```
