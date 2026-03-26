import { Router, type Request, type Response } from 'express';
import {
  scheduleReloadSelfHeal,
  type ReloadSelfHealOptions,
} from '../../../dist/self-heal/reload-sweep.js';

const router = Router();

const VALID_SOURCES = new Set<ReloadSelfHealOptions['source']>([
  'runners_page',
  'task_page',
  'project_tasks_page',
]);

router.post('/self-heal/reload', (req: Request, res: Response) => {
  try {
    const source = req.body?.source;
    const projectPath = req.body?.projectPath;

    if (!VALID_SOURCES.has(source)) {
      res.status(400).json({
        success: false,
        error: 'Invalid source',
      });
      return;
    }

    if (projectPath !== undefined && typeof projectPath !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Invalid projectPath',
      });
      return;
    }

    const result = scheduleReloadSelfHeal({ source, projectPath });
    res.status(result.scheduled ? 202 : 200).json({
      success: true,
      scheduled: result.scheduled,
      reason: result.reason,
    });
  } catch (error) {
    console.error('Error scheduling reload self-heal:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to schedule reload self-heal',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
