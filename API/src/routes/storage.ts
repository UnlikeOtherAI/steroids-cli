/**
 * Storage API routes
 * Project storage breakdown with caching
 */

import { Router, Request, Response } from 'express';
import {
  validateProjectPath,
  getCachedStorageBreakdown,
} from '../utils/storage-cache.js';

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

export default router;
