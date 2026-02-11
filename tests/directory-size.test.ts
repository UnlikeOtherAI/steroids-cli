import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  formatBytes,
  sumDirectorySize,
  getStorageBreakdown,
} from '../src/cleanup/directory-size.js';

describe('formatBytes', () => {
  it('formats bytes', () => expect(formatBytes(500)).toBe('500 B'));
  it('formats 1024 as 1.0 KB', () => expect(formatBytes(1024)).toBe('1.0 KB'));
  it('formats kilobytes', () => expect(formatBytes(2048)).toBe('2.0 KB'));
  it('formats 1048576 as 1.0 MB', () => expect(formatBytes(1048576)).toBe('1.0 MB'));
  it('formats megabytes', () => expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB'));
  it('formats gigabytes', () => expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB'));
  it('formats zero', () => expect(formatBytes(0)).toBe('0 B'));
});

describe('sumDirectorySize', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'sum-dir-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('sums flat files (non-recursive)', async () => {
    writeFileSync(join(tmp, 'a.log'), 'aaaa');
    writeFileSync(join(tmp, 'b.log'), 'bb');
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'sub', 'c.log'), 'cccccc');

    const result = await sumDirectorySize(tmp, false);
    expect(result.fileCount).toBe(2);
    expect(result.bytes).toBe(6); // 4 + 2, sub not counted
  });

  it('sums recursively when recursive=true', async () => {
    writeFileSync(join(tmp, 'a.log'), 'aaaa');
    mkdirSync(join(tmp, 'sub'));
    writeFileSync(join(tmp, 'sub', 'b.log'), 'bb');

    const result = await sumDirectorySize(tmp, true);
    expect(result.fileCount).toBe(2);
    expect(result.bytes).toBe(6);
  });

  it('returns zeros for non-existent directory', async () => {
    const result = await sumDirectorySize(join(tmp, 'nope'), false);
    expect(result).toEqual({ bytes: 0, fileCount: 0 });
  });
});

describe('getStorageBreakdown', () => {
  let steroidsDir: string;
  beforeEach(() => {
    const proj = mkdtempSync(join(tmpdir(), 'steroids-proj-'));
    steroidsDir = join(proj, '.steroids');
    mkdirSync(steroidsDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(join(steroidsDir, '..'), { recursive: true, force: true });
  });

  it('returns all zeros and null warning for empty directory', async () => {
    const result = await getStorageBreakdown(steroidsDir);
    expect(result.total_bytes).toBe(0);
    expect(result.clearable_bytes).toBe(0);
    expect(result.threshold_warning).toBeNull();
  });

  it('returns empty breakdown for non-existent dir', async () => {
    const result = await getStorageBreakdown('/tmp/definitely-does-not-exist-xyz');
    expect(result.total_bytes).toBe(0);
    expect(result.threshold_warning).toBeNull();
  });

  it('categorizes database files', async () => {
    writeFileSync(join(steroidsDir, 'steroids.db'), 'x'.repeat(1000));
    writeFileSync(join(steroidsDir, 'steroids.db-wal'), 'y'.repeat(500));

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.breakdown.database.bytes).toBe(1500);
    expect(result.breakdown.database.human).toBe('1.5 KB');
  });

  it('counts invocation files (non-recursive)', async () => {
    mkdirSync(join(steroidsDir, 'invocations'));
    writeFileSync(join(steroidsDir, 'invocations', '1.log'), 'data1');
    writeFileSync(join(steroidsDir, 'invocations', '2.log'), 'data22');

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.breakdown.invocations.file_count).toBe(2);
    expect(result.breakdown.invocations.bytes).toBe(11);
  });

  it('counts log files recursively (date subdirs)', async () => {
    const dateDir = join(steroidsDir, 'logs', '2025-01-15');
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(join(dateDir, 'run.log'), 'logdata');

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.breakdown.logs.file_count).toBe(1);
    expect(result.breakdown.logs.bytes).toBe(7);
  });

  it('counts backup subdirectories', async () => {
    const b1 = join(steroidsDir, 'backup', '2025-01-01T00-00-00');
    const b2 = join(steroidsDir, 'backup', '2025-02-01T00-00-00');
    mkdirSync(b1, { recursive: true });
    mkdirSync(b2, { recursive: true });
    writeFileSync(join(b1, 'steroids.db'), 'backup1');
    writeFileSync(join(b2, 'steroids.db'), 'backup22');

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.breakdown.backups.backup_count).toBe(2);
    expect(result.breakdown.backups.bytes).toBe(15);
  });

  it('puts unknown files into "other"', async () => {
    writeFileSync(join(steroidsDir, 'config.yaml'), 'key: value');

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.breakdown.other.bytes).toBe(10);
  });

  it('computes total as sum of all categories', async () => {
    writeFileSync(join(steroidsDir, 'steroids.db'), 'x'.repeat(100));
    mkdirSync(join(steroidsDir, 'invocations'));
    writeFileSync(join(steroidsDir, 'invocations', '1.log'), 'y'.repeat(50));
    writeFileSync(join(steroidsDir, 'config.yaml'), 'z'.repeat(10));

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.total_bytes).toBe(160);
  });

  it('clearable_bytes = invocations + logs only', async () => {
    mkdirSync(join(steroidsDir, 'invocations'));
    writeFileSync(join(steroidsDir, 'invocations', '1.log'), 'x'.repeat(200));
    mkdirSync(join(steroidsDir, 'logs'));
    writeFileSync(join(steroidsDir, 'logs', 'a.log'), 'y'.repeat(100));
    mkdirSync(join(steroidsDir, 'backup'));
    writeFileSync(join(steroidsDir, 'backup', 'snap.db'), 'z'.repeat(500));

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.clearable_bytes).toBe(300); // 200 + 100, NOT including backups
  });

  it('threshold null when clearable < 50MB', async () => {
    const result = await getStorageBreakdown(steroidsDir);
    expect(result.threshold_warning).toBeNull();
  });

  it('threshold orange when clearable >= 50MB', async () => {
    mkdirSync(join(steroidsDir, 'invocations'));
    const buf = Buffer.alloc(55 * 1024 * 1024, 'x');
    writeFileSync(join(steroidsDir, 'invocations', 'big.log'), buf);

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.threshold_warning).toBe('orange');
  });

  it('threshold red when clearable >= 100MB', async () => {
    mkdirSync(join(steroidsDir, 'invocations'));
    const buf = Buffer.alloc(105 * 1024 * 1024, 'x');
    writeFileSync(join(steroidsDir, 'invocations', 'big.log'), buf);

    const result = await getStorageBreakdown(steroidsDir);
    expect(result.threshold_warning).toBe('red');
  });
});
