/**
 * Credit Alerts API routes — credit exhaustion incidents for dashboard notifications.
 */
import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteForRead } from '../utils/sqlite.js';
import { getRegisteredProjects } from '../../../dist/runners/projects.js';

export const creditAlertRoutes = Router();

interface IncidentRow { id: string; runner_id: string | null; details: string | null; created_at: string }

function openProjectDb(path: string, readonly: boolean): Database.Database | null {
  const dbPath = join(path, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) return null;
  try { return readonly ? openSqliteForRead(dbPath) : new Database(dbPath); } catch { return null; }
}

function parseRow(row: IncidentRow) {
  let provider = '', model = '', role = '', message = '';
  if (row.details) {
    try { const d = JSON.parse(row.details); provider = d.provider ?? ''; model = d.model ?? ''; role = d.role ?? ''; message = d.message ?? ''; } catch { /* malformed */ }
  }
  return { id: row.id, provider, model, role, message, runnerId: row.runner_id, createdAt: row.created_at };
}

const ALERT_SQL = `SELECT id, runner_id, details, created_at FROM incidents
  WHERE failure_mode = 'credit_exhaustion' AND resolved_at IS NULL ORDER BY created_at DESC`;

const DISMISS_SQL = `UPDATE incidents SET resolved_at = datetime('now'), resolution = ?
  WHERE id = ? AND resolved_at IS NULL AND failure_mode = 'credit_exhaustion'`;

const RETRY_SQL = `UPDATE incidents SET resolved_at = datetime('now'), resolution = 'retry'
  WHERE id = ? AND resolved_at IS NULL AND failure_mode = 'credit_exhaustion'`;

function resolveIncident(req: Request, res: Response, sql: string, params: unknown[]) {
  const projectPath = req.body?.project as string | undefined;
  if (!projectPath) { res.status(400).json({ error: 'Missing body param: project' }); return; }
  const db = openProjectDb(projectPath, false);
  if (!db) { res.status(404).json({ error: 'Project database not found' }); return; }
  try {
    const r = db.prepare(sql).run(...params);
    if (r.changes === 0) { res.status(404).json({ error: 'Incident not found or already resolved' }); return; }
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Failed to update alert' }); } finally { db.close(); }
}

/** GET / — list active credit exhaustion incidents. project query param is optional. */
creditAlertRoutes.get('/', (req: Request, res: Response) => {
  const project = req.query.project as string | undefined;
  const paths = project ? [project] : getRegisteredProjects(false).map((p: { path: string }) => p.path);
  const alerts: ReturnType<typeof parseRow>[] = [];
  for (const p of paths) {
    const db = openProjectDb(p, true);
    if (!db) continue;
    try { (db.prepare(ALERT_SQL).all() as IncidentRow[]).forEach((r) => alerts.push(parseRow(r))); } catch { /* best-effort */ } finally { db.close(); }
  }
  alerts.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
  res.json({ alerts });
});

/** POST /:id/dismiss — resolve a credit alert. Body: optional {resolution}, defaults "dismissed". */
creditAlertRoutes.post('/:id/dismiss', (req: Request, res: Response) => {
  const resolution = (req.body?.resolution as string) || 'dismissed';
  resolveIncident(req, res, DISMISS_SQL, [resolution, req.params.id]);
});

/** POST /:id/retry — resolve with retry signal. Body: {project} only. */
creditAlertRoutes.post('/:id/retry', (req: Request, res: Response) => {
  resolveIncident(req, res, RETRY_SQL, [req.params.id]);
});
