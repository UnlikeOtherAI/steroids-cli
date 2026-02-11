/**
 * Credit Alerts API routes
 * Exposes credit exhaustion incidents for dashboard notifications.
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteForRead } from '../utils/sqlite.js';

export const creditAlertRoutes = Router();

interface IncidentRow {
  id: string;
  runner_id: string | null;
  details: string | null;
  created_at: string;
}

function openProjectDb(projectPath: string, readonly: boolean): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) return null;
  try {
    return readonly ? openSqliteForRead(dbPath) : new Database(dbPath);
  } catch {
    return null;
  }
}

/** GET /api/credit-alerts — list active (unresolved) credit exhaustion incidents */
creditAlertRoutes.get('/', (req: Request, res: Response) => {
  const projectPath = req.query.project as string | undefined;
  if (!projectPath) {
    res.status(400).json({ error: 'Missing query param: project' });
    return;
  }

  const db = openProjectDb(projectPath, true);
  if (!db) {
    res.status(404).json({ error: 'Project database not found' });
    return;
  }

  try {
    const rows = db.prepare(`
      SELECT id, runner_id, details, created_at
      FROM incidents
      WHERE failure_mode = 'credit_exhaustion' AND resolved_at IS NULL
      ORDER BY created_at DESC
    `).all() as IncidentRow[];

    const alerts = rows.map((row) => {
      let provider = '';
      let model = '';
      let role = '';
      let message = '';
      if (row.details) {
        try {
          const d = JSON.parse(row.details);
          provider = d.provider ?? '';
          model = d.model ?? '';
          role = d.role ?? '';
          message = d.message ?? '';
        } catch { /* ignore malformed JSON */ }
      }
      return {
        id: row.id,
        provider,
        model,
        role,
        message,
        runnerId: row.runner_id,
        createdAt: row.created_at,
      };
    });

    res.json({ alerts });
  } catch {
    res.json({ alerts: [] });
  } finally {
    db.close();
  }
});

/** POST /api/credit-alerts/:id/dismiss — resolve a credit alert */
creditAlertRoutes.post('/:id/dismiss', (req: Request, res: Response) => {
  const projectPath = req.body.project as string | undefined;
  if (!projectPath) {
    res.status(400).json({ error: 'Missing body param: project' });
    return;
  }

  const db = openProjectDb(projectPath, false);
  if (!db) {
    res.status(404).json({ error: 'Project database not found' });
    return;
  }

  try {
    const resolution = (req.body.resolution as string) || 'dismissed';
    const result = db.prepare(
      `UPDATE incidents SET resolved_at = datetime('now'), resolution = ? WHERE id = ? AND resolved_at IS NULL`,
    ).run(resolution, req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Incident not found or already resolved' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to dismiss alert' });
  } finally {
    db.close();
  }
});

/** POST /api/credit-alerts/:id/retry — resolve with retry signal */
creditAlertRoutes.post('/:id/retry', (req: Request, res: Response) => {
  const projectPath = req.body.project as string | undefined;
  if (!projectPath) {
    res.status(400).json({ error: 'Missing body param: project' });
    return;
  }

  const db = openProjectDb(projectPath, false);
  if (!db) {
    res.status(404).json({ error: 'Project database not found' });
    return;
  }

  try {
    const result = db.prepare(
      `UPDATE incidents SET resolved_at = datetime('now'), resolution = 'retry' WHERE id = ? AND resolved_at IS NULL`,
    ).run(req.params.id);
    if (result.changes === 0) {
      res.status(404).json({ error: 'Incident not found or already resolved' });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retry alert' });
  } finally {
    db.close();
  }
});
