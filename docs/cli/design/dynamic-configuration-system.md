# Dynamic Configuration System Implementation

## Overview

Implement a schema-driven configuration system that exposes the config schema via CLI command, makes it available through the API, and renders dynamic settings UI in the WebUI.

## Components

### 1. CLI: `config schema` Subcommand

**File**: `src/commands/config.ts`

New subcommand that outputs the configuration schema in JSON Schema format:

```bash
steroids config schema              # Full schema as JSON
steroids config schema ai           # Just the 'ai' category
```

**Supporting file**: `src/config/json-schema.ts`
- `toJsonSchema(schema?: SchemaObject): JSONSchema` - Converts internal schema to JSON Schema
- `getCategoryJsonSchema(category: string): JSONSchema | null` - Get schema for a category
- `getSchemaCategories(): string[]` - List all category names

### 2. API: Config Endpoints

**File**: `API/src/routes/config.ts`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/config/schema` | Return full JSON Schema |
| GET | `/api/config/schema/:category` | Return schema for category |
| GET | `/api/config?scope=global\|project&project=<path>` | Get config values |
| PUT | `/api/config` | Update config values |

### 3. WebUI: Dynamic Settings Page

**Files**:
- `WebUI/src/pages/SettingsPage.tsx` - Main settings page
- `WebUI/src/components/settings/SchemaForm.tsx` - Recursive form renderer
- `WebUI/src/components/settings/SchemaField.tsx` - Individual field component

**Structure**:
```
Settings Page
├── Scope Toggle: [Global] [Project: <name>]
├── Categories (collapsible sections)
│   ├── AI Configuration
│   │   ├── Orchestrator
│   │   │   ├── Provider (dropdown: claude/gemini/openai)
│   │   │   └── Model (text input)
│   │   ├── Coder
│   │   └── Reviewer
│   ├── Git Settings
│   ├── Runners
│   └── ... (all categories from schema)
└── Save Button
```

**Field Type Rendering**:
- `string` with `enum` → dropdown/select
- `string` → text input
- `number` → number input
- `boolean` → toggle switch
- `array` → multi-line text area (one item per line)

## JSON Schema Format

Internal schema format:
```typescript
{
  ai: {
    _description: 'AI provider configuration',
    _type: 'object',
    coder: {
      provider: {
        _description: 'AI provider for coder',
        _type: 'string',
        _options: ['claude', 'gemini', 'openai'],
        _default: 'claude',
      }
    }
  }
}
```

Converted to standard JSON Schema:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ai": {
      "type": "object",
      "description": "AI provider configuration",
      "properties": {
        "coder": {
          "type": "object",
          "properties": {
            "provider": {
              "type": "string",
              "description": "AI provider for coder",
              "enum": ["claude", "gemini", "openai"],
              "default": "claude"
            }
          }
        }
      }
    }
  }
}
```

## File Changes Summary

### New Files
- `src/config/json-schema.ts` - Schema conversion utility
- `API/src/routes/config.ts` - Config API endpoints
- `WebUI/src/pages/SettingsPage.tsx` - Settings page
- `WebUI/src/components/settings/SchemaForm.tsx` - Dynamic form renderer
- `WebUI/src/components/settings/SchemaField.tsx` - Field component

### Modified Files
- `src/commands/config.ts` - Add `schema` subcommand
- `API/src/index.ts` - Register config router
- `WebUI/src/App.tsx` - Add settings route
- `WebUI/src/services/api.ts` - Add config API methods

## Usage

### CLI
```bash
# Get full schema
steroids config schema

# Get specific category
steroids config schema ai
steroids config schema runners

# Pipe to jq for formatting
steroids config schema | jq .
```

### API
```bash
# Get schema
curl http://localhost:3501/api/config/schema

# Get global config
curl http://localhost:3501/api/config?scope=global

# Get project config
curl "http://localhost:3501/api/config?scope=project&project=/path/to/project"

# Update config
curl -X PUT http://localhost:3501/api/config \
  -H "Content-Type: application/json" \
  -d '{"scope": "global", "updates": {"ai.coder.model": "claude-opus-4"}}'
```

### WebUI
Navigate to Settings page via sidebar. Toggle between Global and Project scope, modify settings, and click Save Changes.
