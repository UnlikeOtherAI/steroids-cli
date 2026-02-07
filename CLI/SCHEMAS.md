# JSON/YAML Schemas

> Validation schemas for Steroids configuration and data files.
> For storage overview, see [STORAGE.md](./STORAGE.md)

---

## Overview

This document defines the schemas for all Steroids data files. Use these schemas for:
- Validating configuration files
- Understanding expected data structures
- Building integrations

---

## Config Schema

Config files use YAML with rich metadata (descriptions, options) for the TUI browser.

### Config File Format

Each setting includes metadata that powers `steroids config browse`:

```yaml
# .steroids/config.yaml
# Steroids Project Configuration

output:
  _description: "Output formatting options"

  format:
    _description: "Output format for CLI commands"
    _options: [table, json]
    _default: table
    value: table

  colors:
    _description: "Enable colored output"
    _options: [true, false]
    _default: true
    value: true

  verbose:
    _description: "Show detailed output for debugging"
    _options: [true, false]
    _default: false
    value: false
```

### Metadata Fields

| Field | Purpose |
|-------|---------|
| `_description` | Shown in TUI browser |
| `_options` | Valid values (for selection UI) |
| `_default` | Default value |
| `value` | Current setting |

### Project Config Schema

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
properties:
  output:
    type: object
    properties:
      format:
        type: object
        properties:
          value: { type: string, enum: [table, json], default: table }
      colors:
        type: object
        properties:
          value: { type: boolean, default: true }
      verbose:
        type: object
        properties:
          value: { type: boolean, default: false }

  health:
    type: object
    properties:
      threshold:
        type: integer
        minimum: 0
        maximum: 100
        default: 70
      checks:
        type: object
        properties:
          git:
            type: boolean
            default: true
          deps:
            type: boolean
            default: true
          tests:
            type: boolean
            default: true
          lint:
            type: boolean
            default: true
          todos:
            type: boolean
            default: true
        additionalProperties: false
    additionalProperties: false

  tasks:
    type: object
    properties:
      file:
        type: string
        default: TODO.md
      statusMarkers:
        type: object
        properties:
          pending:
            type: string
            default: "[ ]"
          in_progress:
            type: string
            default: "[-]"
          completed:
            type: string
            default: "[x]"
          review:
            type: string
            default: "[o]"
        additionalProperties: false
    additionalProperties: false

  backup:
    type: object
    description: Backup settings (project overrides global)
    properties:
      enabled:
        type: boolean
        default: true
        description: Enable/disable automatic backups
      beforePurge:
        type: boolean
        default: true
        description: Create backup before purge operations
      retentionDays:
        type: integer
        minimum: 1
        default: 30
        description: Days to keep backups
    additionalProperties: false

additionalProperties: false
```

### User Config (~/.steroids/config.yaml)

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
properties:
  output:
    $ref: "#/$defs/output"

  projects:
    type: object
    properties:
      basePath:
        type: string
        description: Default path for scanning projects
      scanInterval:
        type: string
        pattern: "^\\d+[smh]$"
        default: "5m"
        description: Interval for watch mode (e.g., 30s, 5m, 1h)
      ignored:
        type: array
        items:
          type: string
        default:
          - node_modules
          - .git
          - dist
          - build
          - vendor
          - __pycache__
    additionalProperties: false

  webui:
    type: object
    properties:
      port:
        type: integer
        minimum: 1
        maximum: 65535
        default: 3000
      host:
        type: string
        default: localhost
      openBrowser:
        type: boolean
        default: true
    additionalProperties: false

  backup:
    type: object
    description: Default backup settings (can be overridden per-project)
    properties:
      enabled:
        type: boolean
        default: true
        description: Enable/disable automatic backups globally
      beforePurge:
        type: boolean
        default: true
        description: Create backup before purge operations
      retentionDays:
        type: integer
        minimum: 1
        default: 30
        description: Days to keep backups
      path:
        type: string
        description: Custom backup directory path
    additionalProperties: false

additionalProperties: false
```

---

## Hooks Schema

Hooks are part of config.yaml. See [HOOKS.md](./HOOKS.md) and [CONFIG-SCHEMA.md](./CONFIG-SCHEMA.md).

---

## Task Schema

### Task Object (in tasks.json)

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [id, title, status, createdAt]
properties:
  id:
    type: string
    format: uuid
    description: "Unique GUID"
  title:
    type: string
    minLength: 1
  status:
    type: string
    enum: [pending, in_progress, completed, review]
  sectionId:
    type: ["string", "null"]
    format: uuid
    description: Parent section GUID
  sourceFile:
    type: ["string", "null"]
    description: Link to specification for review
  createdAt:
    type: string
    format: date-time
  lock:
    type: ["object", "null"]
    properties:
      runnerId:
        type: string
        format: uuid
      acquiredAt:
        type: string
        format: date-time
      expiresAt:
        type: string
        format: date-time
  audit:
    type: array
    description: Status change history
    description: GUID of parent section
  audit:
    type: array
    description: Audit trail of all status changes
    items:
      type: object
      required: [status, timestamp, actor]
      properties:
        status:
          type: string
          enum: [pending, in_progress, completed, review]
        previousStatus:
          type: string
          enum: [pending, in_progress, completed, review]
        timestamp:
          type: string
          format: date-time
        actor:
          type: object
          required: [type]
          properties:
            type:
              type: string
              enum: [human, model]
            model:
              type: string
              description: Model identifier (e.g., "claude-sonnet-4", "gpt-4")
            user:
              type: string
              description: Human user identifier
        approval:
          type: object
          description: Present when status changed to completed/review
          properties:
            approved:
              type: boolean
            approvedBy:
              type: string
              description: Model or user that approved
            approvedAt:
              type: string
              format: date-time
            notes:
              type: string
```

### Tasks List Response

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [success, command, data]
properties:
  success:
    type: boolean
  command:
    type: string
    const: tasks
  timestamp:
    type: string
    format: date-time
  data:
    type: object
    required: [tasks, summary, pagination]
    properties:
      tasks:
        type: array
        items:
          $ref: "#/$defs/task"
      summary:
        type: object
        properties:
          total:
            type: integer
          pending:
            type: integer
          in_progress:
            type: integer
          completed:
            type: integer
          review:
            type: integer
      pagination:
        type: object
        properties:
          total:
            type: integer
          limit:
            type: integer
          offset:
            type: integer
          hasMore:
            type: boolean
  warnings:
    type: array
    items:
      type: string
```

---

## IDs File Schema

### IDs Mapping File (.steroids/ids.json)

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [version, tasks, sections]
properties:
  version:
    type: integer
    const: 1
  tasks:
    type: object
    additionalProperties:
      type: object
      required: [file, line, title, createdAt]
      properties:
        file:
          type: string
        line:
          type: integer
          minimum: 1
        title:
          type: string
        createdAt:
          type: string
          format: date-time
        orphanedAt:
          type: string
          format: date-time
          description: Set when task no longer found in file
  sections:
    type: object
    additionalProperties:
      type: object
      required: [file, line, name, createdAt]
      properties:
        file:
          type: string
        line:
          type: integer
          minimum: 1
        name:
          type: string
        createdAt:
          type: string
          format: date-time
        orphanedAt:
          type: string
          format: date-time
```

---

## Section Schema

### Section Object

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [id, name, file]
properties:
  id:
    type: string
    format: uuid
    description: Random GUID assigned on section creation
  name:
    type: string
    minLength: 1
    description: Section heading text (without ##)
  file:
    type: string
    description: Source file path
  line:
    type: integer
    minimum: 1
  taskCount:
    type: integer
    minimum: 0
  completedCount:
    type: integer
    minimum: 0
  isCompleted:
    type: boolean
    description: True if all tasks in section are completed
```

---

## Project Schema

### Project Object (scan results)

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [name, path, type]
properties:
  name:
    type: string
    description: Project directory name
  path:
    type: string
    description: Absolute path to project
  type:
    type: string
    enum: [node, python, rust, go, ruby, unknown]
  hasGit:
    type: boolean
  hasTodo:
    type: boolean
  taskCount:
    type: object
    properties:
      pending:
        type: integer
      in_progress:
        type: integer
      completed:
        type: integer
      review:
        type: integer
  healthScore:
    type: ["integer", "null"]
    minimum: 0
    maximum: 100
  lastModified:
    type: string
    format: date-time
```

---

## Health Schema

### Health Check Response

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [success, command, data]
properties:
  success:
    type: boolean
  command:
    type: string
    const: health
  data:
    type: object
    required: [score, status, checks]
    properties:
      score:
        type: integer
        minimum: 0
        maximum: 100
      status:
        type: string
        enum: [healthy, warning, critical]
        description: "healthy >= 80, warning 50-79, critical < 50"
      checks:
        type: array
        items:
          type: object
          required: [name, passed, score]
          properties:
            name:
              type: string
              enum: [git, deps, tests, lint, todos]
            passed:
              type: boolean
            score:
              type: integer
              minimum: 0
              maximum: 100
            message:
              type: string
            suggestion:
              type: ["string", "null"]
```

---

## Runner Schema

### Runner Object

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [id, status]
properties:
  id:
    type: string
    format: uuid
  status:
    type: string
    enum: [idle, running, completed, failed]
  projectPath:
    type: string
    description: Absolute path to project being worked on
  currentTask:
    type: string
    format: uuid
    description: GUID of task currently being executed
  startedAt:
    type: string
    format: date-time
  completedAt:
    type: string
    format: date-time
  lastHeartbeat:
    type: string
    format: date-time
  pid:
    type: integer
    description: Process ID of runner
  error:
    type: string
    description: Error message if status is failed
```

### Runner State File (~/.steroids/runners/state.json)

```yaml
$schema: "https://json-schema.org/draft/2020-12/schema"
type: object
required: [version, runners]
properties:
  version:
    type: integer
    const: 1
  runners:
    type: object
    additionalProperties:
      $ref: "#/$defs/runner"
  lastWakeup:
    type: string
    format: date-time
```

---

## Payload & Error Schemas

For hook payload schemas and error response schemas, see [SCHEMAS-PAYLOADS.md](./SCHEMAS-PAYLOADS.md).

---

## Validation

### CLI Validation Command

```bash
# Validate config syntax
steroids config validate

# Validate hooks configuration
steroids hooks validate
```

### Programmatic Validation

Use any JSON Schema validator with these schemas. Example with `ajv`:

```javascript
const Ajv = require('ajv');
const ajv = new Ajv();

const configSchema = require('./schemas/config.json');
const validate = ajv.compile(configSchema);

const config = yaml.load(fs.readFileSync('.steroids/config.yaml'));
const valid = validate(config);

if (!valid) {
  console.error(validate.errors);
}
```

---

## Related Documentation

- [STORAGE.md](./STORAGE.md) - File storage specification
- [TODO-FORMAT.md](./TODO-FORMAT.md) - Markdown parsing grammar
- [API.md](./API.md) - JSON output schemas
- [HOOKS.md](./HOOKS.md) - Hooks configuration guide
