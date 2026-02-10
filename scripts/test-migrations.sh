#!/bin/bash
# Test that all migrations apply correctly to a fresh database
# Creates a temporary test database, applies migrations, and verifies schema

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR="/tmp/steroids-migration-test-$$"
TEST_DB="$TEST_DIR/.steroids/steroids.db"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Steroids Migration Test"
echo "=========================================="
echo ""

# Cleanup function
cleanup() {
    if [ -d "$TEST_DIR" ]; then
        rm -rf "$TEST_DIR"
        echo -e "${YELLOW}Cleaned up test directory${NC}"
    fi
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Create test directory
echo "Creating test directory: $TEST_DIR"
mkdir -p "$TEST_DIR/.steroids"

# Create a minimal database with only the base tables (simulating old database)
echo "Creating minimal test database (simulating pre-migration state)..."
sqlite3 "$TEST_DB" << 'EOF'
-- Minimal schema without any migration columns
CREATE TABLE _schema (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    section_id TEXT REFERENCES sections(id),
    source_file TEXT,
    rejection_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE task_locks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE section_locks (
    section_id TEXT PRIMARY KEY REFERENCES sections(id),
    runner_id TEXT NOT NULL,
    acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

INSERT INTO _schema (key, value) VALUES ('version', '0.1.0');
INSERT INTO _schema (key, value) VALUES ('created_at', datetime('now'));
EOF

echo -e "${GREEN}Created test database${NC}"
echo ""

# Show initial state
echo "Initial database state:"
echo "  Tables: $(sqlite3 "$TEST_DB" ".tables" | tr -s ' ' ', ')"
echo "  Migrations applied: $(sqlite3 "$TEST_DB" "SELECT COUNT(*) FROM _migrations;")"
echo ""

# Run migrations using Node.js script
echo "Applying migrations..."
cd "$PROJECT_ROOT"

node --no-warnings << EOF
import Database from 'better-sqlite3';
import { readBundledManifest, getMigrationStatus, runMigrations, readMigrationFile } from './dist/migrations/index.js';

const db = new Database('$TEST_DB');

try {
    const manifest = readBundledManifest();
    console.log('Manifest version:', manifest.version);
    console.log('Latest DB version:', manifest.latestDbVersion);
    console.log('Migrations in manifest:', manifest.migrations.length);
    console.log('');

    const statusBefore = getMigrationStatus(db, manifest);
    console.log('Before migration:');
    console.log('  Current version:', statusBefore.currentVersion);
    console.log('  Pending migrations:', statusBefore.pending.length);
    if (statusBefore.pending.length > 0) {
        console.log('  Pending:', statusBefore.pending.map(m => m.name).join(', '));
    }
    console.log('');

    // Apply migrations
    const result = runMigrations(db, manifest);

    if (result.success) {
        console.log('\x1b[32mMigrations applied successfully!\x1b[0m');
        if (result.applied.length > 0) {
            console.log('  Applied:', result.applied.join(', '));
        } else {
            console.log('  No migrations needed');
        }
    } else {
        console.log('\x1b[31mMigration failed!\x1b[0m');
        console.log('  Failed at:', result.failed);
        console.log('  Error:', result.error);
        process.exit(1);
    }
    console.log('');

    const statusAfter = getMigrationStatus(db, manifest);
    console.log('After migration:');
    console.log('  Current version:', statusAfter.currentVersion);
    console.log('  Is up to date:', statusAfter.isUpToDate);
    console.log('  Applied migrations:', statusAfter.applied.length);

} catch (err) {
    console.error('\x1b[31mError:\x1b[0m', err.message);
    process.exit(1);
} finally {
    db.close();
}
EOF

if [ $? -ne 0 ]; then
    echo -e "${RED}Migration test FAILED${NC}"
    exit 1
fi

echo ""

# Verify schema has expected columns
echo "Verifying schema..."

# Check audit table has new columns
AUDIT_COLS=$(sqlite3 "$TEST_DB" "PRAGMA table_info(audit);" | cut -d'|' -f2 | tr '\n' ',')
echo "  audit columns: $AUDIT_COLS"

if [[ "$AUDIT_COLS" != *"commit_sha"* ]]; then
    echo -e "${RED}FAILED: audit.commit_sha column missing${NC}"
    exit 1
fi

if [[ "$AUDIT_COLS" != *"actor_type"* ]]; then
    echo -e "${RED}FAILED: audit.actor_type column missing${NC}"
    exit 1
fi

if [[ "$AUDIT_COLS" != *"model"* ]]; then
    echo -e "${RED}FAILED: audit.model column missing${NC}"
    exit 1
fi

# Check sections table has priority
SECTIONS_COLS=$(sqlite3 "$TEST_DB" "PRAGMA table_info(sections);" | cut -d'|' -f2 | tr '\n' ',')
echo "  sections columns: $SECTIONS_COLS"

if [[ "$SECTIONS_COLS" != *"priority"* ]]; then
    echo -e "${RED}FAILED: sections.priority column missing${NC}"
    exit 1
fi

# Check sections table has skipped
if [[ "$SECTIONS_COLS" != *"skipped"* ]]; then
    echo -e "${RED}FAILED: sections.skipped column missing${NC}"
    exit 1
fi

# Check tasks table has file anchor columns
TASKS_COLS=$(sqlite3 "$TEST_DB" "PRAGMA table_info(tasks);" | cut -d'|' -f2 | tr '\n' ',')
echo "  tasks columns: $TASKS_COLS"

if [[ "$TASKS_COLS" != *"file_path"* ]]; then
    echo -e "${RED}FAILED: tasks.file_path column missing${NC}"
    exit 1
fi

if [[ "$TASKS_COLS" != *"file_line"* ]]; then
    echo -e "${RED}FAILED: tasks.file_line column missing${NC}"
    exit 1
fi

if [[ "$TASKS_COLS" != *"file_commit_sha"* ]]; then
    echo -e "${RED}FAILED: tasks.file_commit_sha column missing${NC}"
    exit 1
fi

if [[ "$TASKS_COLS" != *"file_content_hash"* ]]; then
    echo -e "${RED}FAILED: tasks.file_content_hash column missing${NC}"
    exit 1
fi

# Check section_dependencies table exists
TABLES=$(sqlite3 "$TEST_DB" ".tables")
echo "  tables: $TABLES"

if [[ "$TABLES" != *"section_dependencies"* ]]; then
    echo -e "${RED}FAILED: section_dependencies table missing${NC}"
    exit 1
fi

# Check task_invocations table exists
if [[ "$TABLES" != *"task_invocations"* ]]; then
    echo -e "${RED}FAILED: task_invocations table missing${NC}"
    exit 1
fi

# Verify task_invocations has expected columns
INVOCATIONS_COLS=$(sqlite3 "$TEST_DB" "PRAGMA table_info(task_invocations);" | cut -d'|' -f2 | tr '\n' ',')
echo "  task_invocations columns: $INVOCATIONS_COLS"

if [[ "$INVOCATIONS_COLS" != *"rejection_number"* ]]; then
    echo -e "${RED}FAILED: task_invocations.rejection_number column missing${NC}"
    exit 1
fi

if [[ "$INVOCATIONS_COLS" != *"started_at_ms"* ]]; then
    echo -e "${RED}FAILED: task_invocations.started_at_ms column missing${NC}"
    exit 1
fi

if [[ "$INVOCATIONS_COLS" != *"completed_at_ms"* ]]; then
    echo -e "${RED}FAILED: task_invocations.completed_at_ms column missing${NC}"
    exit 1
fi

if [[ "$INVOCATIONS_COLS" != *"status"* ]]; then
    echo -e "${RED}FAILED: task_invocations.status column missing${NC}"
    exit 1
fi

# Test: Fresh database (using SCHEMA_SQL) should also work and be up to date
echo ""
echo "Testing fresh database (SCHEMA_SQL path)..."
FRESH_DIR="/tmp/steroids-fresh-test-$$"
mkdir -p "$FRESH_DIR"
cd "$FRESH_DIR"
git init -q  # Required for steroids init
# Use the local CLI build under test (not a globally-installed steroids binary).
node "$PROJECT_ROOT/dist/index.js" init -y --no-register 2>&1 | head -3
FRESH_DB="$FRESH_DIR/.steroids/steroids.db"

FRESH_MIGRATIONS=$(sqlite3 "$FRESH_DB" "SELECT COUNT(*) FROM _migrations;")
echo "  Fresh DB migrations recorded: $FRESH_MIGRATIONS"

if [ "$FRESH_MIGRATIONS" -ne 10 ]; then
    echo -e "${RED}FAILED: Fresh database should have 10 migrations recorded, got $FRESH_MIGRATIONS${NC}"
    rm -rf "$FRESH_DIR"
    exit 1
fi

# Verify fresh DB has all the same columns
FRESH_TASKS_COLS=$(sqlite3 "$FRESH_DB" "PRAGMA table_info(tasks);" | cut -d'|' -f2 | tr '\n' ',')
if [[ "$FRESH_TASKS_COLS" != *"file_path"* ]]; then
    echo -e "${RED}FAILED: Fresh DB tasks.file_path column missing${NC}"
    rm -rf "$FRESH_DIR"
    exit 1
fi

FRESH_SECTIONS_COLS=$(sqlite3 "$FRESH_DB" "PRAGMA table_info(sections);" | cut -d'|' -f2 | tr '\n' ',')
if [[ "$FRESH_SECTIONS_COLS" != *"priority"* ]]; then
    echo -e "${RED}FAILED: Fresh DB sections.priority column missing${NC}"
    rm -rf "$FRESH_DIR"
    exit 1
fi

echo -e "  ${GREEN}Fresh database schema matches migrated database${NC}"
rm -rf "$FRESH_DIR"

echo ""
echo -e "${GREEN}=========================================="
echo "All migration tests PASSED!"
echo -e "==========================================${NC}"
