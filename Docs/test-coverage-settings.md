# Test Coverage Settings

## Overview
Allow projects to configure whether tests are expected for new code. When enabled, the reviewer will reject work that lacks proper test coverage.

## Configuration Schema

### Project Config (`.steroids/config.yaml`)
```yaml
quality:
  tests:
    required: true          # Whether to require tests (default: false)
    minCoverage: 80         # Optional: minimum coverage percentage
```

### Global Config (`~/.steroids/config.yaml`)
Same schema - acts as default, overridden by project config.

## Behavior

### When `tests.required: true`
1. Reviewer prompt includes test verification instructions:
   - Check if new code has corresponding tests
   - Verify tests actually test the new functionality
   - If minCoverage specified, check coverage report

2. Reviewer should REJECT if:
   - New code files have no corresponding test files
   - Tests don't cover the main functionality
   - Coverage falls below minCoverage threshold

### When `tests.required: false` (default)
1. Reviewer prompt omits test verification instructions
2. Missing tests are not a rejection reason
3. Other quality checks still apply

## Implementation

### Config Changes
```typescript
// src/config/schema.ts
interface QualityConfig {
  tests?: {
    required?: boolean;    // Default: false
    minCoverage?: number;  // Optional: 0-100
  };
}
```

### Prompt Generation
```typescript
// src/prompts/reviewer.ts
function getReviewerPrompt(config: Config): string {
  const testInstructions = config.quality?.tests?.required
    ? `
## Test Coverage (REQUIRED)
This project requires tests for new code:
- Verify new functionality has corresponding tests
- Tests must actually exercise the new code paths
${config.quality.tests.minCoverage ? `- Minimum coverage: ${config.quality.tests.minCoverage}%` : ''}
- REJECT if tests are missing or inadequate
`
    : '';

  return basePrompt + testInstructions;
}
```

## CLI Commands

### View test settings
```bash
steroids config show quality.tests
# Output: { required: true, minCoverage: 80 }
```

### Set test settings
```bash
steroids config set quality.tests.required true
steroids config set quality.tests.minCoverage 80
```

## Tasks

1. Add `quality.tests` to config schema (schema.ts)
2. Update config validation for new fields
3. Modify reviewer prompt to conditionally include test instructions
4. Add `steroids config show` support for nested paths
5. Add `steroids config set` support for nested paths
6. Update documentation with test coverage settings

## Examples

### TypeScript project with strict testing
```yaml
# .steroids/config.yaml
quality:
  tests:
    required: true
    minCoverage: 80
```

### Prototype project without test requirements
```yaml
# .steroids/config.yaml
quality:
  tests:
    required: false
```

## Default Behavior
- `tests.required` defaults to `false` to avoid breaking existing projects
- Projects that want test enforcement must explicitly opt-in
