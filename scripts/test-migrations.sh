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

# Check section_dependencies table exists
TABLES=$(sqlite3 "$TEST_DB" ".tables")
echo "  tables: $TABLES"

if [[ "$TABLES" != *"section_dependencies"* ]]; then
    echo -e "${RED}FAILED: section_dependencies table missing${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}=========================================="
echo "All migration tests PASSED!"
echo -e "==========================================${NC}"
