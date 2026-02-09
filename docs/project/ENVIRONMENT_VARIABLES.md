# Environment Variables

> Comprehensive guide to all environment variables supported by Steroids CLI.

---

## Overview

Steroids CLI supports environment variables to configure default behavior without requiring command-line flags. This is especially useful for:
- **CI/CD pipelines** - Set defaults in your build environment
- **Development workflows** - Configure your local shell environment
- **Container deployments** - Configure via Docker/Kubernetes env vars

**Priority Order:**
1. CLI flags (highest priority)
2. Environment variables
3. Config file settings
4. Built-in defaults (lowest priority)

---

## Supported Environment Variables

### Output Control

#### `STEROIDS_JSON`
**Maps to:** `--json` flag
**Values:** `1`, `true`
**Default:** Not set (false)

Output all command results as JSON envelopes for machine parsing.

```bash
# Enable JSON output
export STEROIDS_JSON=1
steroids tasks list

# Output format:
{
  "success": true,
  "command": "tasks",
  "subcommand": "list",
  "data": { ... },
  "error": null
}
```

**Use Cases:**
- CI/CD scripts that parse output
- Integration with other tools
- Automated monitoring systems

---

#### `STEROIDS_QUIET`
**Maps to:** `--quiet` flag
**Values:** `1`, `true`
**Default:** Not set (false)

Suppress all non-essential output. Only errors and critical information are shown.

```bash
# Enable quiet mode
export STEROIDS_QUIET=1
steroids tasks list
# No output unless there's an error
```

**Use Cases:**
- Background automation
- Cron jobs
- When you only care about exit codes

**Note:** Conflicts with `STEROIDS_VERBOSE` - cannot use both.

---

#### `STEROIDS_VERBOSE`
**Maps to:** `--verbose` flag
**Values:** `1`, `true`
**Default:** Not set (false)

Enable detailed diagnostic output for debugging and troubleshooting.

```bash
# Enable verbose mode
export STEROIDS_VERBOSE=1
steroids tasks update abc123 --status review
# Shows detailed operation steps, timing, etc.
```

**Use Cases:**
- Debugging issues
- Understanding what the CLI is doing
- Development and testing

**Note:** Conflicts with `STEROIDS_QUIET` - cannot use both.

---

#### `STEROIDS_NO_COLOR`
**Maps to:** `--no-color` flag
**Values:** `1`, `true`, or any value
**Default:** Not set (false)

Disable ANSI color codes in output.

```bash
# Disable colors
export STEROIDS_NO_COLOR=1
steroids tasks list
```

**Also Supported:** `NO_COLOR` (standard environment variable)

**Use Cases:**
- Piping output to files
- Log aggregation systems
- Terminals without color support
- Accessibility requirements

---

### Configuration

#### `STEROIDS_CONFIG`
**Maps to:** `--config` flag
**Values:** File path
**Default:** `.steroids/config.yaml`

Specify a custom configuration file path.

```bash
# Use custom config
export STEROIDS_CONFIG=/path/to/custom-config.yaml
steroids tasks list
```

**Use Cases:**
- Multiple projects with different configs
- Testing configuration changes
- Shared configuration in teams

---

#### `STEROIDS_TIMEOUT`
**Maps to:** `--timeout` flag
**Values:** Duration string (`30s`, `5m`, `1h`, or milliseconds)
**Default:** Not set (command-specific defaults)

Set a default timeout for all operations.

```bash
# Set 30 second timeout
export STEROIDS_TIMEOUT=30s

# Set 5 minute timeout
export STEROIDS_TIMEOUT=5m

# Set in milliseconds
export STEROIDS_TIMEOUT=120000
```

**Duration Formats:**
- `ms` - Milliseconds
- `s` - Seconds
- `m` - Minutes
- `h` - Hours
- Plain number - Treated as milliseconds

**Use Cases:**
- Prevent hanging in automation
- Faster failure in time-critical pipelines
- Testing timeout handling

---

### Behavior Control

#### `STEROIDS_NO_HOOKS`
**Maps to:** `--no-hooks` flag
**Values:** `1`, `true`
**Default:** Not set (false)

Skip execution of all hooks (pre/post command hooks).

```bash
# Disable hooks
export STEROIDS_NO_HOOKS=1
steroids tasks update abc123 --status review
# No pre-review or post-review hooks will run
```

**Use Cases:**
- Faster execution when hooks aren't needed
- Testing without side effects
- Debugging hook issues

---

#### `STEROIDS_AUTO_MIGRATE`
**Maps to:** Auto-accept migration prompts
**Values:** `1`, `true`
**Default:** Not set (false)

Automatically apply database migrations without prompting for confirmation.

```bash
# Auto-migrate in CI
export STEROIDS_AUTO_MIGRATE=1
steroids tasks list
# Will automatically migrate if needed
```

**Use Cases:**
- CI/CD pipelines
- Automated deployments
- Container startup scripts

**Alternative:** Use `--yes` flag with specific commands.

**Safety Note:** Only use in automated environments where you control the CLI version.

---

### Environment Detection

#### `CI`
**Purpose:** Automatically detected by Steroids
**Values:** Any value
**Effect:** Disables interactive prompts, forces non-interactive mode

This is automatically set by most CI systems (GitHub Actions, GitLab CI, CircleCI, etc.).

```bash
# Steroids automatically detects CI environment
CI=1 steroids tasks list
# Will error if interactive input is required
```

**Detection Logic:**
```typescript
function isInteractive(): boolean {
  return process.stdin.isTTY &&
         process.stdout.isTTY &&
         !process.env.CI;
}
```

**Use Cases:**
- Automatically handled by CI systems
- Prevents hanging on prompts
- Forces explicit flag usage

---

#### `NO_COLOR`
**Purpose:** Standard cross-tool color disable
**Values:** Any value
**Effect:** Same as `STEROIDS_NO_COLOR=1`

This is a standard environment variable supported by many CLI tools.

```bash
# Disable colors (standard way)
export NO_COLOR=1
steroids tasks list
```

**Reference:** [NO_COLOR standard](https://no-color.org/)

---

## Example Configurations

### CI/CD Pipeline

```bash
# .github/workflows/steroids.yml
env:
  STEROIDS_JSON: 1
  STEROIDS_AUTO_MIGRATE: 1
  STEROIDS_NO_COLOR: 1
  STEROIDS_TIMEOUT: 5m
  # CI is automatically set by GitHub Actions
```

### Development Environment

```bash
# ~/.bashrc or ~/.zshrc
export STEROIDS_VERBOSE=1
export STEROIDS_TIMEOUT=30s
```

### Production Container

```bash
# docker-compose.yml
environment:
  - STEROIDS_AUTO_MIGRATE=1
  - STEROIDS_QUIET=1
  - STEROIDS_NO_HOOKS=1
  - STEROIDS_CONFIG=/app/config/steroids.yaml
```

### Logging/Monitoring

```bash
# For log aggregation
export STEROIDS_JSON=1
export STEROIDS_NO_COLOR=1
export STEROIDS_VERBOSE=1
```

---

## Testing Environment Variables

You can test environment variable behavior easily:

```bash
# Test JSON output
STEROIDS_JSON=1 steroids tasks list

# Test quiet mode
STEROIDS_QUIET=1 steroids tasks list

# Test timeout
STEROIDS_TIMEOUT=1s steroids loop  # Will timeout quickly

# Combine multiple
STEROIDS_JSON=1 STEROIDS_NO_COLOR=1 steroids tasks list
```

---

## Precedence Example

```bash
# Set env var
export STEROIDS_JSON=1

# This will use JSON output (from env var)
steroids tasks list

# This will NOT use JSON (CLI flag overrides)
steroids tasks list --json=false  # (if supported)

# This will use JSON (env var default applies)
steroids tasks list --verbose
```

---

## Troubleshooting

### Environment Variables Not Working?

1. **Check variable name** - Must be exact (case-sensitive)
   ```bash
   echo $STEROIDS_JSON  # Should show "1" or "true"
   ```

2. **Check value format** - Use `1` or `true` for booleans
   ```bash
   # ✅ Correct
   export STEROIDS_JSON=1
   export STEROIDS_JSON=true

   # ❌ Won't work
   export STEROIDS_JSON=yes
   export STEROIDS_JSON=TRUE  # Case matters
   ```

3. **Check export** - Must use `export` in shell
   ```bash
   # ✅ Correct
   export STEROIDS_JSON=1

   # ❌ Won't work (variable not exported)
   STEROIDS_JSON=1
   ```

4. **Test in same shell** - Variables only persist in current session
   ```bash
   export STEROIDS_JSON=1
   steroids tasks list  # Same terminal session
   ```

### Conflicts

**STEROIDS_QUIET vs STEROIDS_VERBOSE**
```bash
# ❌ Error: Cannot use both
export STEROIDS_QUIET=1
export STEROIDS_VERBOSE=1
steroids tasks list
# Error: Cannot use --quiet and --verbose together
```

**Solution:** Choose one or the other, or use neither for normal output.

---

## Implementation Details

### Source Code

Environment variables are loaded in `src/cli/flags.ts`:

```typescript
export function loadEnvFlags(): Partial<GlobalFlags> {
  const env: Partial<GlobalFlags> = {};

  if (isTruthy(process.env.STEROIDS_JSON)) {
    env.json = true;
  }
  if (isTruthy(process.env.STEROIDS_QUIET)) {
    env.quiet = true;
  }
  // ... etc

  return env;
}
```

### Testing

Environment variables are tested in `tests/flags.test.ts`:

```bash
npm test -- flags.test.ts
```

All environment variable tests should pass.

---

## Related Documentation

- [CLI Architecture](../cli/ARCHITECTURE.md) - Overall CLI design
- [Migrations](../cli/MIGRATIONS.md) - STEROIDS_AUTO_MIGRATE details
- [Testing](./TESTING.md) - Testing with environment variables
- [Configuration](../cli/CONFIG-SCHEMA.md) - Config file vs env vars
