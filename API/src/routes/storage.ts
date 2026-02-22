/**
 * Storage API routes
 * Project storage breakdown and cleanup
 */

import { Router, Request, Response } from 'express';
import {
  validateProjectPath,
  getCachedStorageBreakdown,
  bustStorageCache,
} from '../utils/storage-cache.js';
import { cleanupInvocationLogs } from '../../../dist/cleanup/invocation-logs.js';
import { cleanupTextLogs } from '../../../dist/cleanup/text-logs.js';
import { cleanupBackups } from '../../../dist/cleanup/backups.js';
import { formatBytes } from '../../../dist/cleanup/directory-size.js';

const router = Router();

/**
 * GET /api/projects/storage
 * Get storage breakdown for a project's .steroids/ directory
 * Query: path (required) — absolute path to the project
 */
router.get('/projects/storage', async (req: Request, res: Response) => {
  try {
    const result = await validateProjectPath(req.query.path as string);
    if (!result.valid) {
      res.status(result.status).json({ success: false, error: result.error });
      return;
    }

    const retention = parseRetentionDays(req.query.retention_days);
    if (!retention.valid) {
      res.status(400).json({ success: false, error: retention.error });
      return;
    }

    const breakdown = await getCachedStorageBreakdown(
      result.realPath, 
      retention.days,
      Math.max(retention.days, 30) // Match cleanupBackups floor
    );
    res.json(breakdown);
  } catch (error) {
    console.error('Error getting project storage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get storage breakdown',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

function parseRetentionDays(raw: unknown): { valid: true; days: number } | { valid: false; error: string } {
  if (raw === undefined) return { valid: true, days: 7 };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 365) {
    return { valid: false, error: 'retention_days must be a positive integer (1-365)' };
  }
  return { valid: true, days: raw };
}

function runCleanup(projectPath: string, retentionDays: number) {
  const invResult = cleanupInvocationLogs(projectPath, { retentionDays });
  const textResult = cleanupTextLogs(projectPath, { retentionDays });
  // Respect user retention but keep backups for at least 30 days by default
  const backupResult = cleanupBackups(projectPath, { retentionDays: Math.max(retentionDays, 30) });
  bustStorageCache(projectPath);
  return {
    ok: true as const,
    deleted_files: invResult.deletedFiles + textResult.deletedFiles + backupResult.deletedFiles,
    freed_bytes: invResult.freedBytes + textResult.freedBytes + backupResult.freedBytes,
    freed_human: formatBytes(invResult.freedBytes + textResult.freedBytes + backupResult.freedBytes),
  };
}

/**
 * POST /api/projects/clear-logs
 * Delete old invocation and text logs for a project
 * Body: { path: string, retention_days?: number }
 */
router.post('/projects/clear-logs', async (req: Request, res: Response) => {
  try {
    const { path: rawPath, retention_days } = req.body;

    const retention = parseRetentionDays(retention_days);
    if (!retention.valid) {
      res.status(400).json({ ok: false, error: retention.error });
      return;
    }

    const validation = await validateProjectPath(rawPath);
    if (!validation.valid) {
      res.status(validation.status).json({ ok: false, error: validation.error });
      return;
    }

    res.json(runCleanup(validation.realPath, retention.days));
  } catch (error) {
    console.error('Error clearing project logs:', error);
    res.status(500).json({
      ok: false,
      error: 'Failed to clear logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
