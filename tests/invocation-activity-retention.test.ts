import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupInvocationLogs } from '../src/cleanup/invocation-logs.js';

describe('cleanupInvocationLogs (invocation activity JSONL retention)', () => {
  let projectPath: string;
  let invDir: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-proj-'));
    invDir = join(projectPath, '.steroids', 'invocations');
    mkdirSync(invDir, { recursive: true });
    writeFileSync(join(invDir, 'README.txt'), 'Activity logs\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('deletes .log files older than retention window (mtime-based)', () => {
    const nowMs = 1_700_000_000_000; // fixed time for determinism
    const dayMs = 24 * 60 * 60 * 1000;

    const oldFile = join(invDir, '1.log');
    const newFile = join(invDir, '2.log');
    writeFileSync(oldFile, '{"ts":1,"type":"start"}\n', 'utf-8');
    writeFileSync(newFile, '{"ts":2,"type":"start"}\n', 'utf-8');

    // Make old file 10 days old; new file 1 day old.
    utimesSync(oldFile, (nowMs - 10 * dayMs) / 1000, (nowMs - 10 * dayMs) / 1000);
    utimesSync(newFile, (nowMs - 1 * dayMs) / 1000, (nowMs - 1 * dayMs) / 1000);

    const result = cleanupInvocationLogs(projectPath, { retentionDays: 7, nowMs });
    expect(result.deletedFiles).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
    expect(existsSync(join(invDir, 'README.txt'))).toBe(true);
  });

  it('supports dry-run mode (no deletion)', () => {
    const nowMs = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;

    const oldFile = join(invDir, '1.log');
    writeFileSync(oldFile, '{"ts":1,"type":"start"}\n', 'utf-8');
    utimesSync(oldFile, (nowMs - 30 * dayMs) / 1000, (nowMs - 30 * dayMs) / 1000);

    const result = cleanupInvocationLogs(projectPath, { retentionDays: 7, dryRun: true, nowMs });
    expect(result.deletedFiles).toBe(1);
    expect(existsSync(oldFile)).toBe(true);
  });

  it('does nothing when retentionDays is 0 (keep forever)', () => {
    const nowMs = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;

    const oldFile = join(invDir, '1.log');
    writeFileSync(oldFile, '{"ts":1,"type":"start"}\n', 'utf-8');
    utimesSync(oldFile, (nowMs - 365 * dayMs) / 1000, (nowMs - 365 * dayMs) / 1000);

    const result = cleanupInvocationLogs(projectPath, { retentionDays: 0, nowMs });
    expect(result.deletedFiles).toBe(0);
    expect(existsSync(oldFile)).toBe(true);
  });
});

