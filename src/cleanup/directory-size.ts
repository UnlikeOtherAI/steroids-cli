/**
 * Compute storage breakdown of a project's .steroids/ directory.
 * Scans known subpaths only (not full recursive traversal) for speed.
 * All fs operations are async — safe for use in API handlers.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface StorageBreakdown {
  total_bytes: number;
  total_human: string;
  breakdown: {
    database: { bytes: number; human: string };
    invocations: { bytes: number; human: string; file_count: number };
    logs: { bytes: number; human: string; file_count: number };
    backups: { bytes: number; human: string; backup_count: number };
    other: { bytes: number; human: string };
  };
  clearable_bytes: number;
  clearable_human: string;
  threshold_warning: 'orange' | 'red' | null;
}

const MB = 1024 * 1024;
const THRESHOLD_ORANGE = 10 * MB;
const THRESHOLD_RED = 100 * MB;
const DB_FILES = ['steroids.db', 'steroids.db-wal', 'steroids.db-shm'];
const KNOWN_PATHS = new Set([...DB_FILES, 'invocations', 'logs', 'backup']);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
}

async function safeStatSize(filePath: string): Promise<number> {
  try { return (await fs.stat(filePath)).size; } catch { return 0; }
}

export async function sumDirectorySize(
  dirPath: string,
  recursive = false,
): Promise<{ bytes: number; fileCount: number }> {
  let bytes = 0;
  let fileCount = 0;
  let entries;
  try { entries = await fs.readdir(dirPath, { withFileTypes: true }); } catch { return { bytes: 0, fileCount: 0 }; }
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isFile()) {
      try { const st = await fs.stat(fullPath); bytes += st.size; fileCount++; } catch { /* tolerate */ }
    } else if (entry.isDirectory() && recursive) {
      const sub = await sumDirectorySize(fullPath, true);
      bytes += sub.bytes;
      fileCount += sub.fileCount;
    }
  }
  return { bytes, fileCount };
}

function emptyBreakdown(): StorageBreakdown {
  return {
    total_bytes: 0, total_human: '0 B',
    breakdown: {
      database: { bytes: 0, human: '0 B' },
      invocations: { bytes: 0, human: '0 B', file_count: 0 },
      logs: { bytes: 0, human: '0 B', file_count: 0 },
      backups: { bytes: 0, human: '0 B', backup_count: 0 },
      other: { bytes: 0, human: '0 B' },
    },
    clearable_bytes: 0, clearable_human: '0 B', threshold_warning: null,
  };
}

export async function getStorageBreakdown(steroidsDir: string): Promise<StorageBreakdown> {
  try { await fs.access(steroidsDir); } catch { return emptyBreakdown(); }

  const dbSizes = await Promise.all(DB_FILES.map(f => safeStatSize(join(steroidsDir, f))));
  const dbBytes = dbSizes.reduce((a, b) => a + b, 0);

  const [invocations, logs, backups] = await Promise.all([
    sumDirectorySize(join(steroidsDir, 'invocations'), false),
    sumDirectorySize(join(steroidsDir, 'logs'), true),
    sumDirectorySize(join(steroidsDir, 'backup'), true),
  ]);

  let backupCount = 0;
  try {
    const be = await fs.readdir(join(steroidsDir, 'backup'), { withFileTypes: true });
    backupCount = be.filter(e => e.isDirectory()).length;
  } catch { /* no backup dir */ }

  let otherBytes = 0;
  try {
    const allEntries = await fs.readdir(steroidsDir, { withFileTypes: true });
    for (const entry of allEntries) {
      if (KNOWN_PATHS.has(entry.name)) continue;
      const fullPath = join(steroidsDir, entry.name);
      if (entry.isFile()) otherBytes += await safeStatSize(fullPath);
      else if (entry.isDirectory()) otherBytes += (await sumDirectorySize(fullPath, true)).bytes;
    }
  } catch { /* tolerate */ }

  const totalBytes = dbBytes + invocations.bytes + logs.bytes + backups.bytes + otherBytes;
  const clearableBytes = invocations.bytes + logs.bytes + backups.bytes;
  let warning: StorageBreakdown['threshold_warning'] = null;
  if (clearableBytes >= THRESHOLD_RED) warning = 'red';
  else if (clearableBytes >= THRESHOLD_ORANGE) warning = 'orange';

  return {
    total_bytes: totalBytes, total_human: formatBytes(totalBytes),
    breakdown: {
      database: { bytes: dbBytes, human: formatBytes(dbBytes) },
      invocations: { bytes: invocations.bytes, human: formatBytes(invocations.bytes), file_count: invocations.fileCount },
      logs: { bytes: logs.bytes, human: formatBytes(logs.bytes), file_count: logs.fileCount },
      backups: { bytes: backups.bytes, human: formatBytes(backups.bytes), backup_count: backupCount },
      other: { bytes: otherBytes, human: formatBytes(otherBytes) },
    },
    clearable_bytes: clearableBytes, clearable_human: formatBytes(clearableBytes),
    threshold_warning: warning,
  };
}
