# Database Migrations

> How Steroids manages SQLite schema versions and migrations.
> For database schema, see [STORAGE.md](./STORAGE.md)

---

## Overview

Steroids uses **versioned migrations** to evolve the SQLite database schema. Migrations are:

- **Stored on GitHub** - Always available, versioned with CLI releases
- **Checked on every launch** - CLI verifies compatibility before running
- **Applied seamlessly** - User prompted once, then automatic
- **Idempotent** - Safe to run multiple times

---

## Startup Compatibility Check

**Every time the CLI launches**, it performs these checks:

```
┌─────────────────────────────────────────────────────────────────┐
│                     STEROIDS STARTUP FLOW                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Read CLI version    │
                   │ (from package.json) │
                   └─────────────────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Check for updates   │
                   │ (background, async) │
                   └─────────────────────┘
                              │
                              ▼
                   ┌─────────────────────┐
                   │ Is .steroids/ here? │
                   └─────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │ NO                            │ YES
              ▼                               ▼
        [Run command -              ┌─────────────────────┐
         no project context]        │ Read database       │
                                    │ schema version      │
                                    └─────────────────────┘
                                              │
                                              ▼
                                    ┌─────────────────────┐
                                    │ Compatible?         │
                                    └─────────────────────┘
                                              │
              ┌───────────────┬───────────────┼───────────────┐
              │               │               │               │
              ▼               ▼               ▼               ▼
         DB = CLI        DB < CLI        DB > CLI        DB corrupt
         (exact)         (needs up)      (CLI old)       (error)
              │               │               │               │
              ▼               ▼               ▼               ▼
        [Run command]   [Prompt to      [Block with      [Offer
                         migrate]        upgrade msg]     recovery]
```

### Version Compatibility Rules

| DB Version | CLI Version | Result |
|------------|-------------|--------|
| 3 | 3 | ✓ Run normally |
| 2 | 3 | ⚠ Prompt to migrate |
| 3 | 2 | ✗ Block - CLI too old |
| corrupt | any | ✗ Offer recovery |

---

## Seamless Migration Prompt

When the database needs migration, the user sees:

```
$ steroids tasks list

┌─────────────────────────────────────────────────────────────────┐
│  Database Update Required                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Your project database is at version 2, but this version of     │
│  Steroids requires version 3.                                   │
│                                                                  │
│  Changes in version 3:                                          │
│    • Added disputes table for coder/reviewer disagreements      │
│    • Added rejection_count to tasks                             │
│                                                                  │
│  This is a safe update. Your data will be preserved.            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

? Update database now? (Y/n) █
```

If user presses Enter or Y:

```
Updating database...
  ✓ Backed up to .steroids/backup/pre-migrate-20240115.db
  ✓ Applied migration 003_add_disputes_table

Database updated to version 3.

┌──────────────────────────────────────────────────────────────┐
│ ID       TITLE                    STATUS      SECTION        │
├──────────────────────────────────────────────────────────────┤
│ a1b2...  Fix login bug            pending     Backend        │
│ c3d4...  Add authentication       in_progress Backend        │
└──────────────────────────────────────────────────────────────┘
```

### Non-Interactive Mode

For scripts and CI, use `--yes` or set env var:

```bash
# Auto-accept migrations
steroids tasks list --yes

# Or via environment
STEROIDS_AUTO_MIGRATE=1 steroids tasks list
```

---

## CLI Version Check (Background)

On every launch, the CLI checks for updates **in the background** (non-blocking):

```python
async def check_for_updates():
    """Runs in background, doesn't block CLI startup."""
    try:
        # Fetch latest version from GitHub (cached for 24h)
        response = await fetch(
            "https://api.github.com/repos/steroids-cli/steroids/releases/latest",
            timeout=2  # Don't wait long
        )
        latest = response.json()["tag_name"]
        current = get_cli_version()

        if semver.gt(latest, current):
            # Store notification for display after command completes
            store_update_notification(latest)
    except:
        pass  # Silently fail - don't break CLI for network issues
```

After the command completes, if an update is available:

```
$ steroids tasks list

┌──────────────────────────────────────────────────────────────┐
│ ID       TITLE                    STATUS      SECTION        │
├──────────────────────────────────────────────────────────────┤
│ a1b2...  Fix login bug            pending     Backend        │
└──────────────────────────────────────────────────────────────┘

───────────────────────────────────────────────────────────────
💡 Steroids v0.4.0 is available (you have v0.3.0)
   Run: npm update -g @steroids/cli
───────────────────────────────────────────────────────────────
```

---

## Blocking on Incompatible CLI

If the database is NEWER than the CLI can handle:

```
$ steroids tasks list

┌─────────────────────────────────────────────────────────────────┐
│  CLI Update Required                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  This project's database is at version 4, but your CLI only     │
│  supports up to version 3.                                      │
│                                                                  │
│  To continue, update Steroids:                                  │
│                                                                  │
│    npm update -g @steroids/cli                                  │
│                                                                  │
│  Or if using Homebrew:                                          │
│                                                                  │
│    brew upgrade steroids                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Error: CLI version incompatible with project database.
```

Exit code: 1 (command does not run)

---

## Version Tracking

### CLI Version

The CLI version is stored in `package.json` and embedded at build time:

```typescript
// Built into the CLI binary
const CLI_VERSION = "0.3.0";
const MIN_DB_VERSION = 1;
const MAX_DB_VERSION = 3;  // This CLI supports DB versions 1-3
```

### Database Version

Each database stores its schema version:

```sql
-- In steroids.db
CREATE TABLE _schema (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Current version
INSERT INTO _schema (key, value) VALUES ('version', '3');
INSERT INTO _schema (key, value) VALUES ('created_at', '2024-01-15T10:00:00Z');
INSERT INTO _schema (key, value) VALUES ('last_migration', '003_add_disputes_table');
```

### Reading Version

```python
def get_db_version(db_path):
    """Get current database schema version."""
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.execute(
            "SELECT value FROM _schema WHERE key = 'version'"
        )
        row = cursor.fetchone()
        return int(row[0]) if row else 0
    except sqlite3.DatabaseError:
        return None  # Corrupted or not a valid database

def check_compatibility(db_path):
    """Check if database is compatible with this CLI version."""
    db_version = get_db_version(db_path)

    if db_version is None:
        return "corrupt"
    if db_version < MIN_DB_VERSION:
        return "too_old"  # Shouldn't happen in practice
    if db_version > MAX_DB_VERSION:
        return "cli_outdated"
    if db_version < MAX_DB_VERSION:
        return "needs_migration"
    return "compatible"
```

---

## Startup Check Implementation

```typescript
// src/startup.ts

interface StartupResult {
  canProceed: boolean;
  action?: 'migrate' | 'upgrade_cli' | 'recover';
  message?: string;
}

async function checkProjectCompatibility(): Promise<StartupResult> {
  const projectPath = findProjectRoot();

  // No .steroids directory - not a steroids project (OK)
  if (!projectPath) {
    return { canProceed: true };
  }

  const dbPath = path.join(projectPath, '.steroids', 'steroids.db');

  // No database yet - will be created (OK)
  if (!fs.existsSync(dbPath)) {
    return { canProceed: true };
  }

  const dbVersion = getDbVersion(dbPath);

  // Database corrupted
  if (dbVersion === null) {
    return {
      canProceed: false,
      action: 'recover',
      message: 'Database appears corrupted. Run `steroids recover` to attempt repair.'
    };
  }

  // Database newer than CLI
  if (dbVersion > MAX_DB_VERSION) {
    return {
      canProceed: false,
      action: 'upgrade_cli',
      message: `Database is version ${dbVersion}, but this CLI only supports up to ${MAX_DB_VERSION}.`
    };
  }

  // Database needs migration
  if (dbVersion < MAX_DB_VERSION) {
    return {
      canProceed: false,
      action: 'migrate',
      message: `Database is version ${dbVersion}, needs update to ${MAX_DB_VERSION}.`
    };
  }

  // All good
  return { canProceed: true };
}
```

---

## Migration Prompt Implementation

```typescript
// src/migrate-prompt.ts

async function promptForMigration(dbVersion: number, targetVersion: number): Promise<boolean> {
  // In non-interactive mode, check for auto-migrate
  if (!process.stdin.isTTY || process.env.STEROIDS_AUTO_MIGRATE === '1') {
    if (process.env.STEROIDS_AUTO_MIGRATE === '1') {
      return true;  // Auto-accept
    }
    // Non-interactive without auto-migrate flag
    console.error('Database needs migration. Run with --yes or set STEROIDS_AUTO_MIGRATE=1');
    process.exit(1);
  }

  // Fetch migration descriptions for display
  const migrations = await fetchMigrationManifest();
  const pending = migrations.filter(m => m.id > dbVersion && m.id <= targetVersion);

  console.log(boxen(`
Database Update Required

Your project database is at version ${dbVersion}, but this version of
Steroids requires version ${targetVersion}.

Changes in version ${targetVersion}:
${pending.map(m => `  • ${m.description}`).join('\n')}

This is a safe update. Your data will be preserved.
`, { padding: 1, borderStyle: 'round' }));

  const answer = await prompts({
    type: 'confirm',
    name: 'migrate',
    message: 'Update database now?',
    initial: true
  });

  return answer.migrate;
}
```

---

## Update Check Cache

To avoid hitting GitHub on every launch:

```typescript
// src/update-check.ts

const CACHE_FILE = path.join(os.homedir(), '.steroids', 'update-cache.json');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
  currentVersion: string;
}

async function checkForUpdatesBackground(): Promise<void> {
  // Don't block - run in background
  setImmediate(async () => {
    try {
      // Check cache first
      if (fs.existsSync(CACHE_FILE)) {
        const cache: UpdateCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        if (Date.now() - cache.checkedAt < CACHE_TTL) {
          // Cache still valid, use cached result
          if (semver.gt(cache.latestVersion, CLI_VERSION)) {
            scheduleUpdateNotification(cache.latestVersion);
          }
          return;
        }
      }

      // Fetch from GitHub
      const response = await fetch(
        'https://api.github.com/repos/steroids-cli/steroids/releases/latest',
        { timeout: 2000 }
      );

      if (!response.ok) return;

      const data = await response.json();
      const latestVersion = data.tag_name.replace(/^v/, '');

      // Update cache
      const cache: UpdateCache = {
        checkedAt: Date.now(),
        latestVersion,
        currentVersion: CLI_VERSION
      };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));

      // Schedule notification if update available
      if (semver.gt(latestVersion, CLI_VERSION)) {
        scheduleUpdateNotification(latestVersion);
      }
    } catch {
      // Silently fail - don't break CLI for network issues
    }
  });
}

function scheduleUpdateNotification(newVersion: string): void {
  // Will be shown after command completes
  process.on('beforeExit', () => {
    console.log(`
───────────────────────────────────────────────────────────────
💡 Steroids v${newVersion} is available (you have v${CLI_VERSION})
   Run: npm update -g @steroids/cli
───────────────────────────────────────────────────────────────
`);
  });
}
```

---

## Migration Files

### Location on GitHub

```
https://github.com/steroids-cli/steroids/tree/main/migrations/
├── manifest.json              # Lists all migrations
├── 001_initial_schema.sql     # First migration
├── 002_add_rejection_count.sql
├── 003_add_disputes_table.sql
└── ...
```

### Manifest File

The `manifest.json` file lists all available migrations:

```json
{
  "version": "1.0.0",
  "latestDbVersion": 3,
  "migrations": [
    {
      "id": 1,
      "name": "001_initial_schema",
      "file": "001_initial_schema.sql",
      "description": "Initial database schema with tasks, sections, and audit tables",
      "checksum": "sha256:abc123...",
      "cliVersion": "0.1.0"
    },
    {
      "id": 2,
      "name": "002_add_rejection_count",
      "file": "002_add_rejection_count.sql",
      "description": "Added rejection_count to tasks for tracking review cycles",
      "checksum": "sha256:def456...",
      "cliVersion": "0.2.0"
    },
    {
      "id": 3,
      "name": "003_add_disputes_table",
      "file": "003_add_disputes_table.sql",
      "description": "Added disputes table for coder/reviewer disagreements",
      "checksum": "sha256:ghi789...",
      "cliVersion": "0.3.0"
    }
  ]
}
```

### Raw File URLs

Migrations can be fetched directly:

```
https://raw.githubusercontent.com/steroids-cli/steroids/main/migrations/manifest.json
https://raw.githubusercontent.com/steroids-cli/steroids/main/migrations/001_initial_schema.sql
```

---

## Migration Tracking

Each database tracks which migrations have been applied:

```sql
-- In every steroids.db
CREATE TABLE _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## CLI Commands

### Check Migration Status

```bash
steroids migrate status

Current database version: 2
Latest available version: 3

Pending migrations:
  3. 003_add_disputes_table (added in v0.3.0)

Run `steroids migrate up` to apply pending migrations.
```

### Apply Migrations

```bash
steroids migrate up

Fetching manifest from GitHub...
Current version: 2
Target version: 3

Applying migration 003_add_disputes_table...
  → Downloading 003_add_disputes_table.sql
  → Verifying checksum...
  → Applying to .steroids/steroids.db...
  → Done.

All migrations applied. Database is now at version 3.
```

### Apply to Specific Version

```bash
# Migrate up to version 2 only
steroids migrate up --to 2

# Migrate from scratch (new database)
steroids migrate up --from 0
```

### Rollback (Dangerous)

```bash
# Rollback last migration
steroids migrate down

WARNING: This will undo the last migration and may cause data loss.
Are you sure? [y/N]: y

Rolling back migration 003_add_disputes_table...
  → Executing down migration...
  → Done.

Database is now at version 2.
```

### Force Refresh

```bash
# Re-download manifest and re-verify all checksums
steroids migrate refresh

Fetching manifest from GitHub...
Verifying applied migrations...
  ✓ 001_initial_schema (checksum matches)
  ✓ 002_add_rejection_count (checksum matches)

All migrations verified.
```

---

## Migration File Format

Each migration file contains SQL with up and down sections:

```sql
-- Migration: 003_add_disputes_table
-- Version: 0.3.0
-- Description: Add disputes table for coder/reviewer disagreements

-- UP
CREATE TABLE disputes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reason TEXT NOT NULL,
    coder_position TEXT,
    reviewer_position TEXT,
    resolution TEXT,
    resolution_notes TEXT,
    created_by TEXT NOT NULL,
    resolved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
);

CREATE INDEX idx_disputes_task ON disputes(task_id);
CREATE INDEX idx_disputes_status ON disputes(status);

-- DOWN
DROP INDEX IF EXISTS idx_disputes_status;
DROP INDEX IF EXISTS idx_disputes_task;
DROP TABLE IF EXISTS disputes;
```

---

## Automatic Migration

### On First Run

When `steroids init` creates a new project:

```bash
steroids init

Creating .steroids/ directory...
Fetching latest migrations from GitHub...
Creating steroids.db with schema version 3...
  → Applying 001_initial_schema...
  → Applying 002_add_rejection_count...
  → Applying 003_add_disputes_table...

Project initialized successfully.
```

### On Version Mismatch

When CLI version is newer than database version:

```bash
steroids tasks list

Database schema is outdated (version 2, need 3).
Run `steroids migrate up` to update.

# Or with auto-migrate enabled in config:
Database schema is outdated. Auto-migrating...
  → Applying 003_add_disputes_table...
Done.
```

### Config Option

```yaml
# In ~/.steroids/config.yaml
database:
  autoMigrate: true    # Automatically apply migrations
  backupBeforeMigrate: true  # Create backup before migrating
```

---

## Global vs Project Databases

### Project Database (`.steroids/steroids.db`)

Each project has its own database:

```bash
cd my-project
steroids migrate status
# Shows status for .steroids/steroids.db
```

### Global Database (`~/.steroids/steroids.db`)

Global runner state has its own database:

```bash
steroids migrate status --global
# Shows status for ~/.steroids/steroids.db
```

Both databases use the same migration system but may have different schemas.

---

## Offline Mode

If GitHub is unreachable:

```bash
steroids migrate up

ERROR: Cannot fetch migrations from GitHub.
  Network error: Connection refused

Options:
  1. Check your internet connection
  2. Use cached migrations: steroids migrate up --cached
  3. Manually download migrations to ~/.steroids/migrations/
```

### Cached Migrations

Migrations are cached after download:

```
~/.steroids/
├── config.yaml
├── steroids.db
└── migrations/           # Cached migration files
    ├── manifest.json
    ├── 001_initial_schema.sql
    ├── 002_add_rejection_count.sql
    └── 003_add_disputes_table.sql
```

```bash
# Use cached migrations (offline mode)
steroids migrate up --cached
```

---

## Migration Safety

### Checksum Verification

Every migration is verified before applying:

```python
def verify_migration(migration, file_content):
    expected = migration['checksum']
    actual = f"sha256:{sha256(file_content).hexdigest()}"

    if expected != actual:
        raise MigrationError(
            f"Checksum mismatch for {migration['name']}. "
            f"Expected {expected}, got {actual}. "
            "The migration file may have been corrupted or tampered with."
        )
```

### Backup Before Migrate

```bash
steroids migrate up --backup

Creating backup at .steroids/backup/pre-migrate-20240115.db...
Applying migrations...
```

### Transaction Wrapping

Each migration runs in a transaction:

```python
def apply_migration(db, migration_sql):
    try:
        db.execute("BEGIN TRANSACTION")
        db.executescript(migration_sql)
        db.execute("COMMIT")
    except Exception as e:
        db.execute("ROLLBACK")
        raise MigrationError(f"Migration failed: {e}")
```

---

## Creating New Migrations

When developing Steroids, create migrations with:

```bash
# In the steroids-cli repo
./scripts/create-migration.sh "add_invocation_logs_table"

Created: migrations/004_add_invocation_logs_table.sql
Updated: migrations/manifest.json

Edit the migration file, then commit both files.
```

### Migration Naming

- Sequential numbered prefix: `001_`, `002_`, etc.
- Descriptive snake_case name: `add_disputes_table`
- Full name: `003_add_disputes_table.sql`

### Testing Migrations

```bash
# Test migration on fresh database
./scripts/test-migration.sh 004

Creating fresh database...
Applying migrations 001-003...
Testing migration 004...
  → UP: Success
  → DOWN: Success
  → UP again: Success

Migration 004 passed all tests.
```

---

## Version Compatibility

| CLI Version | Database Version | Notes |
|-------------|------------------|-------|
| 0.1.0 | 1 | Initial release |
| 0.2.0 | 2 | Added rejection_count |
| 0.3.0 | 3 | Added disputes table |
| 0.4.0 | 4 | Added invocation_logs |

### Forward Compatibility

Older CLI versions refuse to run on newer databases:

```bash
# CLI v0.2.0 trying to use database v3
steroids tasks list

ERROR: Database version 3 is newer than this CLI supports (max: 2).
Please upgrade Steroids: npm install -g @steroids/cli@latest
```

### Backward Compatibility

Newer CLI versions can migrate older databases:

```bash
# CLI v0.4.0 on database v1
steroids tasks list

Database needs migration (v1 → v4).
Run `steroids migrate up` to update.
```

---

## Database Recovery

If the database is corrupted:

```
$ steroids tasks list

┌─────────────────────────────────────────────────────────────────┐
│  Database Error                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  The project database appears to be corrupted or unreadable.    │
│                                                                  │
│  Options:                                                        │
│    1. Attempt automatic recovery                                │
│    2. Restore from backup                                       │
│    3. Reset database (loses all task history)                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

? What would you like to do? ›
❯ Attempt recovery
  Restore from backup
  Reset database
```

### Recovery Command

```bash
# Attempt automatic recovery
steroids recover

Checking database integrity...
  ✗ Database file is corrupted

Attempting recovery...
  → Running SQLite integrity check...
  → Recovering readable data...
  → Found 15 tasks, 3 sections, 42 audit entries
  → Creating new database with recovered data...

Recovery complete. 15 of 15 tasks recovered.
```

### Restore from Backup

```bash
# List available backups
steroids backup list

TIMESTAMP              SIZE      TYPE
2024-01-15 10:30:00   45 KB     auto (pre-migrate)
2024-01-14 15:00:00   42 KB     manual
2024-01-10 09:00:00   38 KB     auto (pre-purge)

# Restore specific backup
steroids backup restore 2024-01-15

Restoring from .steroids/backup/2024-01-15T10-30-00/...
  → Backing up current database first...
  → Restoring steroids.db...
  → Verifying integrity...

Database restored to 2024-01-15 10:30:00 state.
```

### Reset Database

```bash
# Nuclear option - loses all history
steroids reset --confirm

WARNING: This will delete all task history and start fresh.
Your tasks will need to be re-added.

Are you absolutely sure? Type 'RESET' to confirm: RESET

Deleting .steroids/steroids.db...
Creating fresh database with latest schema (v3)...

Database reset complete.
```

---

## TL;DR - User Experience

**Normal usage** - nothing to think about:
```bash
steroids tasks list
# Just works
```

**After CLI update** - seamless prompt:
```bash
steroids tasks list

Database Update Required
Your project database is at version 2, needs version 3.

? Update database now? (Y/n) [Enter]

✓ Database updated.

# Command runs normally
```

**If CLI is too old**:
```bash
steroids tasks list

CLI Update Required
Your CLI (v0.2.0) is too old for this database (v3).
Run: npm update -g @steroids/cli
```

**If something breaks**:
```bash
steroids recover
# Attempts to fix it
```

---

## Related Documentation

- [STORAGE.md](./STORAGE.md) - Database schema details
- [SCHEMAS.md](./SCHEMAS.md) - Full SQL schema reference
