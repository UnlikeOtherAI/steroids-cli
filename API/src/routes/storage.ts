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
    const breakdown = await getCachedStorageBreakdown(result.realPath);
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

/**
 * POST /api/projects/clear-logs
 * Delete old invocation and text logs for a project
 * Body: { path: string, retention_days?: number }
 */
router.post('/projects/clear-logs', async (req: Request, res: Response) => {
  try {
    const { path: rawPath, retention_days } = req.body as { path?: string; retention_days?: unknown };

    // Validate retention_days: positive integer, max 365
    if (retention_days !== undefined) {
      if (typeof retention_days !== 'number' || !Number.isInteger(retention_days) || retention_days < 1 || retention_days > 365) {
        res.status(400).json({ ok: false, error: 'retention_days must be a positive integer (1-365)' });
        return;
      }
    }
    const retentionDays = (retention_days as number | undefined) ?? 7;

    // Security: resolve real path and verify it's a registered project
    const validation = await validateProjectPath(rawPath);
    if (!validation.valid) {
      res.status(validation.status).json({ ok: false, error: validation.error });
      return;
    }

    const projectPath = validation.realPath;
    const invResult = cleanupInvocationLogs(projectPath, { retentionDays });
    const textResult = cleanupTextLogs(projectPath, { retentionDays });
    const totalDeleted = invResult.deletedFiles + textResult.deletedFiles;
    const totalFreed = invResult.freedBytes + textResult.freedBytes;

    bustStorageCache(projectPath);

    res.json({
      ok: true,
      deleted_files: totalDeleted,
      freed_bytes: totalFreed,
      freed_human: formatBytes(totalFreed),
    });
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
