# Steroids Coding Standards

## Scope

These rules apply to **ALL** Steroids components without exception.

## Architecture Documentation

- [CLI Architecture](./CLI/ARCHITECTURE.md) - Main task management CLI
- [Pump](./Pump/README.md) - Data gathering CLI (Google APIs, LLM grounding)
- [Iron](./Iron/README.md) - Documentation scaffolding CLI
- [WebUI Architecture](./WebUI/ARCHITECTURE.md) - Dashboard-specific architecture
- [Code Quality](./Docs/CODE_QUALITY.md) - The 50 rules in detail

### The Suite: Pump Iron + Steroids

| Component | Purpose | Status |
|-----------|---------|--------|
| **Steroids CLI** | Task management, runners, hooks | Designing |
| **Pump** | Data gathering, LLM grounding (Google APIs) | Planned |
| **Iron** | Documentation scaffolding wizard | Planned |
| **WebUI** | Visual dashboard | Planned |

All CLIs are independent and can be used standalone.

---

## Core Constraints (MANDATORY)

### 1. File Size Limit

**Maximum 500 lines per file.** No exceptions.

If a file exceeds this limit, split it:
- **Entity** → Extract sub-entities or value objects
- **Use Case** → Break into smaller use cases
- **Component** → Extract sub-components
- **Repository** → Split by query complexity

### 2. Single Responsibility

Each module does **one thing well**. If you can't describe what a file does in one sentence, split it.

### 3. Dependency Injection

All dependencies must be injectable for testing:

```typescript
// GOOD: Injectable
class ListProjectsUseCase {
  constructor(private readonly repository: IProjectRepository) {}
}

// BAD: Hard-coded dependency
class ListProjectsUseCase {
  private repository = new FileProjectRepository();
}
```

### 4. Interface Segregation

Small, focused interfaces. Don't force implementations to depend on methods they don't use.

### 5. Pure Functions

Business logic should be in pure, testable functions whenever possible:

```typescript
// GOOD: Pure function
function calculateHealthScore(metrics: Metrics): number {
  return (metrics.testCoverage + metrics.buildStatus) / 2;
}

// BAD: Side effects mixed in
function calculateHealthScore(metrics: Metrics): number {
  console.log('Calculating...');  // Side effect
  db.logMetrics(metrics);         // Side effect
  return (metrics.testCoverage + metrics.buildStatus) / 2;
}
```

### 6. Everything Testable

If code can't be tested in isolation, refactor until it can. No excuses.

---

## File Size Guidelines

| Layer | Max Lines |
|-------|-----------|
| Entities | 150 |
| Value Objects | 100 |
| Use Cases | 200 |
| Repositories | 250 |
| Components | 200 |
| Routes/Commands | 100 |
| Tests | 300 |

---

## Key Patterns

### Entity Pattern

```typescript
export class Project {
  private constructor(private readonly props: ProjectProps) {}

  static create(props: Omit<ProjectProps, 'id'>): Project {
    return new Project({ id: crypto.randomUUID(), ...props });
  }

  static reconstitute(props: ProjectProps): Project {
    return new Project(props);
  }

  get id(): string { return this.props.id; }
  get name(): string { return this.props.name; }

  isHealthy(): boolean {
    return this.props.healthScore !== null && this.props.healthScore >= 80;
  }
}
```

### Value Object Pattern

```typescript
export class TaskStatus {
  private constructor(private readonly value: TaskStatusValue) {}

  static pending(): TaskStatus { return new TaskStatus(TaskStatusValue.PENDING); }
  static completed(): TaskStatus { return new TaskStatus(TaskStatusValue.COMPLETED); }

  equals(other: TaskStatus): boolean {
    return this.value === other.value;
  }
}
```

### Repository Interface

```typescript
export interface IProjectRepository {
  findById(id: string): Promise<Project | null>;
  findAll(filters?: ProjectFilters): Promise<PaginatedResult<Project>>;
  save(project: Project): Promise<void>;
  delete(id: string): Promise<void>;
}
```

### Use Case Pattern

```typescript
export class ListProjectsUseCase {
  constructor(
    private readonly repository: IProjectRepository,
    private readonly mapper: ProjectMapper
  ) {}

  async execute(input: ListProjectsInput): Promise<ListProjectsOutput> {
    const result = await this.repository.findAll(input.filters);
    return {
      projects: result.data.map(p => this.mapper.toDTO(p)),
      pagination: result.pagination,
    };
  }
}
```

---

## Shared Enums

```typescript
export enum ProjectCategory {
  SAAS_PLATFORM = 'saas_platform',
  TOOL = 'tool',
  LIBRARY = 'library',
  SERVICE = 'service',
}

export enum ProjectStatus {
  ACTIVE = 'active',
  MAINTENANCE = 'maintenance',
  ARCHIVED = 'archived',
}

export enum TaskStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
}

export enum TaskPriority {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
}

export enum HealthStatus {
  HEALTHY = 'healthy',
  WARNING = 'warning',
  CRITICAL = 'critical',
  UNKNOWN = 'unknown',
}
```

---

## Testing Requirements

### Unit Tests
- Test domain logic in isolation
- Mock all external dependencies
- Target: 80% coverage minimum

### Integration Tests
- Test repository implementations
- Test API routes with test database
- Test CLI commands with fixtures

### E2E Tests
- Critical user flows only
- Use Playwright for WebUI
- Use CLI test harness for commands

---

## The 50 Rules

See [CODE_QUALITY.md](./Docs/CODE_QUALITY.md) for the complete set of 50 coding rules covering:
- Architecture & Structure (1-10)
- Code Quality & Maintainability (11-20)
- Testing & Reliability (21-30)
- Data & State (31-40)
- Process & Team Practices (41-50)

---

## Database Migrations (CRITICAL)

**You MUST maintain the migration system when changing the database schema.**

### Migration Files Location

```
migrations/
├── manifest.json              # MUST be updated when adding migrations
├── 001_initial_schema.sql
├── 002_add_rejection_count.sql
├── 003_add_disputes_table.sql
└── ...
```

### When Changing Database Schema

1. **Create a new migration file** with the next sequential number
2. **Update `migrations/manifest.json`** with the new migration entry
3. **Include both UP and DOWN** sections in the migration
4. **Never modify existing migrations** - only add new ones
5. **Test the migration** with `./scripts/test-migration.sh`

### Manifest Format

```json
{
  "version": "X.Y.Z",
  "migrations": [
    {
      "id": 1,
      "name": "001_initial_schema",
      "file": "001_initial_schema.sql",
      "checksum": "sha256:...",
      "appliedIn": "0.1.0"
    }
  ]
}
```

**Individual projects fetch migrations from GitHub via raw URLs.** The manifest MUST be accurate or migrations will fail.

See [CLI/MIGRATIONS.md](./CLI/MIGRATIONS.md) for complete migration system documentation.

---

## Code Review Checklist

Before merging, verify:

- [ ] No file exceeds 500 lines
- [ ] All dependencies are injectable
- [ ] Business logic is in pure functions
- [ ] Tests exist and pass
- [ ] No hard-coded configuration values
- [ ] Proper error handling with typed errors
- [ ] If schema changed: migration file created and manifest updated
