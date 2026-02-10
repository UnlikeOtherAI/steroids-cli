/**
 * Incidents API routes
 * Exposes stuck-task incident history for dashboard/monitor.
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const router = Router();

interface IncidentRow {
  id: string;
  task_id: string | null;
  runner_id: string | null;
  failure_mode: string;
  detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
  details: string | null;
  created_at: string;
  task_title?: string | null;
}

function openProjectDatabaseReadonly(projectPath: string): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * GET /api/incidents
 * Query params:
 *   - project: string (required) - project path
 *   - limit: number (optional, default 50, max 200)
 *   - task: string (optional) - filter by task ID prefix
 *   - unresolved: boolean (optional) - true => resolved_at IS NULL, false => resolved_at IS NOT NULL
 */
router.get('/incidents', (req: Request, res: Response) => {
  const projectPath = req.query.project as string | undefined;
  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Project path required (query param: project)',
    });
    return;
  }

  const limit = Math.min(parsePositiveInt(req.query.limit, 50), 200);
  const taskPrefix = (req.query.task as string | undefined)?.trim();
  const unresolved = parseBoolean(req.query.unresolved);

  const db = openProjectDatabaseReadonly(projectPath);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  try {
    // Best-effort: incidents table may not exist (migrations disabled).
    let incidents: IncidentRow[] = [];
    try {
      const where: string[] = [];
      const params: Array<string | number> = [];

      if (taskPrefix) {
        where.push('i.task_id LIKE ?');
        params.push(`${taskPrefix}%`);
      }
      if (unresolved === true) where.push('i.resolved_at IS NULL');
      if (unresolved === false) where.push('i.resolved_at IS NOT NULL');

      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const sql = `
        SELECT
          i.id, i.task_id, i.runner_id, i.failure_mode, i.detected_at, i.resolved_at, i.resolution, i.details, i.created_at,
          t.title as task_title
        FROM incidents i
        LEFT JOIN tasks t ON t.id = i.task_id
        ${whereSql}
        ORDER BY i.detected_at DESC
        LIMIT ?
      `;
      incidents = db.prepare(sql).all(...params, limit) as IncidentRow[];
    } catch {
      incidents = [];
    }

    res.json({
      success: true,
      project: projectPath,
      total: incidents.length,
      incidents,
    });
  } catch (error) {
    console.error('Error listing incidents:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list incidents',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    db.close();
  }
});

export default router;

