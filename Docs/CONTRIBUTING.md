# Contributing to Steroids

Thank you for your interest in contributing to Steroids. This guide will help you get started.

---

## Code of Conduct

Be respectful. Be professional. Focus on the code, not the person.

---

## Getting Started

### Prerequisites

- Node.js 20 LTS ([nvm](https://github.com/nvm-sh/nvm) recommended)
- pnpm 9+ (`corepack enable pnpm`)
- Git 2.40+

### Development Setup

```bash
# 1. Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/steroids.git
cd steroids

# 2. Install dependencies
pnpm install

# 3. Set up environment
cp .env.example .env

# 4. Start development server
pnpm dev

# 5. Verify everything works
pnpm test
```

### IDE Setup

#### VS Code (Recommended)

Install these extensions:
- ESLint
- Prettier
- Tailwind CSS IntelliSense

Recommended settings (`.vscode/settings.json`):
```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "typescript.preferences.importModuleSpecifier": "relative"
}
```

---

## Project Structure

```
Steroids/
├── CLI/                    # Command-line interface
│   └── src/
├── WebUI/                  # Web dashboard
│   └── packages/
│       ├── api/            # Fastify backend
│       └── web/            # React frontend
├── shared/                 # Shared types and utilities
├── Docs/                   # Documentation
└── tests/                  # Test suites
```

---

## Development Workflow

### 1. Create a Branch

```bash
# Feature
git checkout -b feature/add-project-search

# Bug fix
git checkout -b fix/task-status-toggle

# Documentation
git checkout -b docs/update-readme
```

### 2. Make Changes

Follow the coding standards in [CLAUDE.md](./CLAUDE.md):
- Maximum 500 lines per file
- Single responsibility per module
- All dependencies injectable
- Tests for new functionality

### 3. Test Your Changes

```bash
# Run all tests
pnpm test

# Run specific test
pnpm test src/domain/entities/Project.test.ts

# Run with coverage
pnpm test:coverage

# Run E2E tests
pnpm test:e2e
```

### 4. Commit Your Changes

We use [Conventional Commits](https://www.conventionalcommits.org/):

```bash
# Format: <type>(<scope>): <description>

# Types:
feat     # New feature
fix      # Bug fix
docs     # Documentation only
style    # Formatting, no code change
refactor # Code change that neither fixes nor adds
test     # Adding or updating tests
chore    # Maintenance tasks

# Examples:
git commit -m "feat(cli): add project search command"
git commit -m "fix(webui): resolve task toggle race condition"
git commit -m "docs: update installation instructions"
git commit -m "test(api): add integration tests for projects endpoint"
```

### 5. Push and Create PR

```bash
git push origin feature/add-project-search
```

Then open a Pull Request on GitHub.

---

## Pull Request Guidelines

### PR Title

Use the same format as commits:
```
feat(cli): add project search command
```

### PR Description

Use this template:

```markdown
## Summary
Brief description of changes.

## Changes
- Added X
- Updated Y
- Fixed Z

## Testing
How did you test this?

## Screenshots
(If applicable)

## Checklist
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] No file exceeds 500 lines
- [ ] All tests pass locally
```

### Review Process

1. Automated checks must pass (CI, linting, tests)
2. At least one maintainer approval required
3. All conversations must be resolved
4. Squash merge preferred

---

## Coding Standards

### TypeScript

```typescript
// Use explicit types for function parameters and returns
function calculateHealth(metrics: Metrics): number {
  return metrics.score;
}

// Use readonly for immutable data
interface Project {
  readonly id: string;
  readonly name: string;
}

// Prefer interfaces over types for objects
interface ProjectProps {
  name: string;
}

// Use type for unions/intersections
type Status = 'active' | 'inactive';
```

### React Components

```typescript
// Use function components with explicit props
interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export function Button({ label, onClick, disabled = false }: ButtonProps) {
  return (
    <button onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}
```

### Testing

```typescript
// One test = one assertion (or closely related assertions)
it('returns true when health score >= 80', () => {
  const project = createTestProject({ healthScore: 80 });
  expect(project.isHealthy()).toBe(true);
});

// Use descriptive test names
describe('Project', () => {
  describe('isHealthy', () => {
    it('returns true when healthScore >= 80');
    it('returns false when healthScore < 80');
    it('returns false when healthScore is null');
  });
});
```

---

## Adding New Features

### 1. Domain First

Start with domain entities and value objects:

```typescript
// src/domain/entities/NewFeature.ts
export class NewFeature {
  // ...
}
```

### 2. Use Cases

Add application logic:

```typescript
// src/application/use-cases/NewFeatureUseCase.ts
export class NewFeatureUseCase {
  constructor(private readonly repository: INewFeatureRepository) {}

  async execute(input: Input): Promise<Output> {
    // ...
  }
}
```

### 3. Infrastructure

Implement repositories and external integrations:

```typescript
// src/infrastructure/persistence/file/FileNewFeatureRepository.ts
export class FileNewFeatureRepository implements INewFeatureRepository {
  // ...
}
```

### 4. Presentation

Add API routes or CLI commands:

```typescript
// API route
fastify.get('/api/new-feature', handler);

// CLI command
program.command('new-feature').action(handler);
```

### 5. Tests

Add tests at each layer:

```
tests/unit/domain/entities/NewFeature.test.ts
tests/unit/application/use-cases/NewFeatureUseCase.test.ts
tests/integration/api/new-feature.test.ts
```

---

## Common Tasks

### Adding a CLI Command

1. Create command file: `CLI/src/cli/commands/mycommand.ts`
2. Register in `CLI/src/cli/commands/index.ts`
3. Add tests: `tests/integration/cli/mycommand.test.ts`
4. Update README with usage

### Adding an API Endpoint

1. Create route handler: `WebUI/packages/api/src/presentation/routes/myroute/`
2. Add Zod schema for validation
3. Register in router
4. Add integration tests
5. Update API documentation

---

## Troubleshooting

### "Cannot find module" Errors

```bash
# Rebuild TypeScript
pnpm build

# Or restart dev server
pnpm dev
```

### Test Failures

```bash
# Run with verbose output
pnpm test --reporter=verbose

# Run single test in isolation
pnpm test src/specific.test.ts
```

### Port Already in Use

```bash
# Find process using port 3000
lsof -i :3000

# Kill it
kill -9 <PID>
```

---

## Getting Help

- **Questions:** Open a [Discussion](https://github.com/unlikeother/steroids/discussions)
- **Bugs:** Open an [Issue](https://github.com/unlikeother/steroids/issues)
- **Security:** Email security@unlikeother.ai

---

## Recognition

Contributors are recognized in:
- GitHub Contributors page
- Release notes for significant contributions
- AUTHORS file for major features

---

Thank you for contributing to Steroids!
