/**
 * Intake API routes
 * CRUD endpoints for normalized intake reports plus summary stats and connector health.
 */

import { Router, type Request, type Response } from 'express';
import { loadConfig } from '../../../src/config/loader.js';
import {
  getIntakeReport,
  listIntakeReports,
  upsertIntakeReport,
} from '../../../src/database/intake-queries.js';
import type { IntakeReportStatus, IntakeSeverity, IntakeSource } from '../../../src/intake/types.js';
import {
  buildConnectorHealth,
  buildStats,
  isIntakeSeverity,
  isIntakeSource,
  isIntakeStatus,
  mergeReport,
  openProjectDatabase,
  parseBoolean,
  parsePositiveInt,
  parseReportPayload,
  parseReportUpdateBody,
} from './intake-support.js';

const router = Router();

function requireProjectQuery(req: Request, res: Response): string | null {
  const projectPath = req.query.project as string | undefined;
  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Project path required (query param: project)',
    });
    return null;
  }

  return projectPath;
}

function validateSourceParam(source: string, res: Response): source is IntakeSource {
  if (!isIntakeSource(source)) {
    res.status(400).json({
      success: false,
      error: `Unsupported intake source: ${source}`,
    });
    return false;
  }

  return true;
}

router.get('/intake/reports', (req: Request, res: Response) => {
  const projectPath = requireProjectQuery(req, res);
  if (!projectPath) return;

  const db = openProjectDatabase(projectPath, true);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  try {
    const sourceParam = req.query.source as string | undefined;
    const statusParam = req.query.status as string | undefined;
    const severityParam = req.query.severity as string | undefined;
    const linkedTaskId = req.query.linkedTaskId as string | undefined;
    const hasLinkedTask = parseBoolean(req.query.hasLinkedTask);
    const limit = Math.min(parsePositiveInt(req.query.limit, 100), 500);

    if (sourceParam && !isIntakeSource(sourceParam)) {
      res.status(400).json({ success: false, error: `Unsupported intake source: ${sourceParam}` });
      return;
    }
    if (statusParam && !isIntakeStatus(statusParam)) {
      res.status(400).json({ success: false, error: `Unsupported intake status: ${statusParam}` });
      return;
    }
    if (severityParam && !isIntakeSeverity(severityParam)) {
      res.status(400).json({ success: false, error: `Unsupported intake severity: ${severityParam}` });
      return;
    }

    const source = sourceParam as IntakeSource | undefined;
    const status = statusParam as IntakeReportStatus | undefined;
    const severity = severityParam as IntakeSeverity | undefined;

    const reports = listIntakeReports(db, {
      source,
      status,
      severity,
      linkedTaskId,
      hasLinkedTask,
      limit,
    });

    res.json({
      success: true,
      project: projectPath,
      total: reports.length,
      reports,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list intake reports',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

router.get('/intake/reports/:source/:externalId', (req: Request, res: Response) => {
  const projectPath = requireProjectQuery(req, res);
  if (!projectPath) return;

  const { source, externalId } = req.params;
  if (!validateSourceParam(source, res)) return;

  const db = openProjectDatabase(projectPath, true);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  try {
    const report = getIntakeReport(db, source, externalId);
    if (!report) {
      res.status(404).json({
        success: false,
        error: 'Intake report not found',
        source,
        externalId,
      });
      return;
    }

    res.json({
      success: true,
      project: projectPath,
      report,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to load intake report',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

router.post('/intake/reports', (req: Request, res: Response) => {
  const projectPath = (req.body?.project as string | undefined) ?? null;
  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Missing required body parameter: project',
    });
    return;
  }

  const parsed = parseReportPayload(req.body?.report ?? req.body);
  if ('error' in parsed) {
    res.status(400).json({
      success: false,
      error: parsed.error,
    });
    return;
  }

  const linkedTaskId = req.body?.linkedTaskId as string | null | undefined;
  if (
    linkedTaskId !== undefined &&
    linkedTaskId !== null &&
    (typeof linkedTaskId !== 'string' || linkedTaskId.trim() === '')
  ) {
    res.status(400).json({
      success: false,
      error: 'linkedTaskId must be a non-empty string or null',
    });
    return;
  }

  const db = openProjectDatabase(projectPath, false);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  try {
    const existing = getIntakeReport(db, parsed.source, parsed.externalId);
    const report = upsertIntakeReport(db, parsed, {
      linkedTaskId: linkedTaskId === undefined ? undefined : linkedTaskId,
    });

    res.status(existing ? 200 : 201).json({
      success: true,
      project: projectPath,
      report,
      created: !existing,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to persist intake report',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

router.patch('/intake/reports/:source/:externalId', (req: Request, res: Response) => {
  const projectPath = (req.body?.project as string | undefined) ?? null;
  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Missing required body parameter: project',
    });
    return;
  }

  const { source, externalId } = req.params;
  if (!validateSourceParam(source, res)) return;

  const updates = parseReportUpdateBody(req.body);
  if ('error' in updates) {
    res.status(400).json({
      success: false,
      error: updates.error,
    });
    return;
  }

  const db = openProjectDatabase(projectPath, false);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  try {
    const existing = getIntakeReport(db, source, externalId);
    if (!existing) {
      res.status(404).json({
        success: false,
        error: 'Intake report not found',
        source,
        externalId,
      });
      return;
    }

    const report = upsertIntakeReport(db, mergeReport(existing, updates), {
      linkedTaskId: Object.prototype.hasOwnProperty.call(updates, 'linkedTaskId')
        ? updates.linkedTaskId ?? null
        : undefined,
    });

    res.json({
      success: true,
      project: projectPath,
      report,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to update intake report',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

router.delete('/intake/reports/:source/:externalId', (req: Request, res: Response) => {
  const projectPath = (req.query.project as string | undefined) ?? (req.body?.project as string | undefined);
  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Missing required project parameter',
    });
    return;
  }

  const { source, externalId } = req.params;
  if (!validateSourceParam(source, res)) return;

  const db = openProjectDatabase(projectPath, false);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  try {
    const result = db
      .prepare('DELETE FROM intake_reports WHERE source = ? AND external_id = ?')
      .run(source, externalId);

    if (result.changes === 0) {
      res.status(404).json({
        success: false,
        error: 'Intake report not found',
        source,
        externalId,
      });
      return;
    }

    res.json({
      success: true,
      project: projectPath,
      source,
      externalId,
      deleted: true,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete intake report',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

router.get('/intake/stats', (req: Request, res: Response) => {
  const projectPath = requireProjectQuery(req, res);
  if (!projectPath) return;

  const db = openProjectDatabase(projectPath, true);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  try {
    const reports = listIntakeReports(db);
    res.json({
      success: true,
      project: projectPath,
      stats: buildStats(reports),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to compute intake stats',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

router.get('/intake/connectors/health', (req: Request, res: Response) => {
  const projectPath = requireProjectQuery(req, res);
  if (!projectPath) return;

  const db = openProjectDatabase(projectPath, true);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  try {
    const config = loadConfig(projectPath).intake;
    res.json({
      success: true,
      project: projectPath,
      intakeEnabled: config?.enabled === true,
      connectors: buildConnectorHealth(db, config),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to compute connector health',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
});

export default router;
