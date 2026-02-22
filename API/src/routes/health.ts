/**
 * Health API routes
 * Exposes stuck-task detection health summary for the dashboard/monitor.
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../../dist/config/loader.js';
import {
  detectStuckTasks,
  type StuckTaskDetectionConfig,
  type StuckTaskDetectionReport,
} from '../../../dist/health/stuck-task-detector.js';
import { getGlobalDbPath } from '../../../dist/runners/global-db.js';
import { openSqliteForRead } from '../utils/sqlite.js';

const router = Router();

function openProjectDatabaseReadonly(projectPath: string): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) return null;
  try {
    return openSqliteForRead(dbPath);
  } catch {
    return null;
  }
}

function openGlobalDatabaseReadonlyOrMemory(): { db: Database.Database; close: () => void } {
  const dbPath = getGlobalDbPath();
  if (existsSync(dbPath)) {
    const db = openSqliteForRead(dbPath);
    return { db, close: () => db.close() };
  }

  // No global DB yet; use an in-memory DB with an empty runners table.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'idle',
      pid INTEGER,
      project_path TEXT,
      current_task_id TEXT,
      started_at TEXT,
      heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
      section_id TEXT
    );
  `);
  return { db, close: () => db.close() };
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function isLikelySchemaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /no such table|no such column|has no column|syntax error/i.test(error.message);
}

function fallbackStuckTaskReport(): StuckTaskDetectionReport {
  return {
    timestamp: new Date(),
    orphanedTasks: [],
    hangingInvocations: [],
    zombieRunners: [],
    deadRunners: [],
    dbInconsistencies: [],
  };
}

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

function computeStatus(args: {
  orphanedTasks: number;
  hangingInvocations: number;
  zombieRunners: number;
  deadRunners: number;
  activeIncidents: number;
}): HealthStatus {
  if (args.deadRunners > 0 || args.zombieRunners > 0) return 'unhealthy';
  if (args.hangingInvocations > 0 || args.orphanedTasks > 0 || args.activeIncidents > 0) return 'degraded';
  return 'healthy';
}

/**
 * GET /api/health
 * Query params:
 *   - project: string (required) - project path
 *   - includeSignals: boolean (optional) - include raw signal arrays (default: false)
 */
router.get('/health', (req: Request, res: Response) => {
  const projectPath = req.query.project as string | undefined;
  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Project path required (query param: project)',
    });
    return;
  }

  const includeSignals = parseBoolean(req.query.includeSignals) ?? false;

  const projectDb = openProjectDatabaseReadonly(projectPath);
  if (!projectDb) {
    res.status(404).json({
      success: false,
      error: 'Project database not found at .steroids/steroids.db',
      project: projectPath,
    });
    return;
  }

  const { db: globalDb, close: closeGlobal } = openGlobalDatabaseReadonlyOrMemory();

  try {
    const cfg = loadConfig(projectPath);
    const detectionConfig: StuckTaskDetectionConfig = {
      orphanedTaskTimeoutSec: cfg.health?.orphanedTaskTimeout,
      maxCoderDurationSec: cfg.health?.maxCoderDuration,
      maxReviewerDurationSec: cfg.health?.maxReviewerDuration,
      runnerHeartbeatTimeoutSec: cfg.health?.runnerHeartbeatTimeout,
      invocationStalenessSec: cfg.health?.invocationStaleness,
    };

    let report: StuckTaskDetectionReport;
    try {
      report = detectStuckTasks({
        projectPath,
        projectDb,
        globalDb,
        config: detectionConfig,
      });
    } catch (error) {
      if (!isLikelySchemaError(error)) {
        throw error;
      }
      if (process.env.NODE_ENV !== 'test') {
        console.warn('Falling back to minimal health signals due to missing schema:', error);
      }
      report = fallbackStuckTaskReport();
    }

    // Incident counts (best-effort: table might not exist)
    let activeIncidents = 0;
    let recentIncidents = 0;
    try {
      const rowActive = projectDb
        .prepare(`SELECT COUNT(*) as count FROM incidents WHERE resolved_at IS NULL`)
        .get() as { count: number } | undefined;
      const rowRecent = projectDb
        .prepare(`SELECT COUNT(*) as count FROM incidents WHERE detected_at >= datetime('now', '-24 hours')`)
        .get() as { count: number } | undefined;
      activeIncidents = rowActive?.count ?? 0;
      recentIncidents = rowRecent?.count ?? 0;
    } catch {
      // ignore
    }

    const orphanedTasks = report.orphanedTasks.length;
    const hangingInvocations = report.hangingInvocations.length;
    const zombieRunners = report.zombieRunners.length;
    const deadRunners = report.deadRunners.length;

    const health = {
      status: computeStatus({
        orphanedTasks,
        hangingInvocations,
        zombieRunners,
        deadRunners,
        activeIncidents,
      }),
      lastCheck: new Date().toISOString(),
      checks: [
        { type: 'orphaned_tasks', healthy: orphanedTasks === 0, found: orphanedTasks },
        { type: 'hanging_invocations', healthy: hangingInvocations === 0, found: hangingInvocations },
        { type: 'zombie_runners', healthy: zombieRunners === 0, found: zombieRunners },
        { type: 'dead_runners', healthy: deadRunners === 0, found: deadRunners },
      ],
      activeIncidents,
      recentIncidents,
      ...(includeSignals
        ? {
            signals: {
              orphanedTasks: report.orphanedTasks,
              hangingInvocations: report.hangingInvocations,
              zombieRunners: report.zombieRunners,
              deadRunners: report.deadRunners,
              dbInconsistencies: report.dbInconsistencies,
            },
          }
        : {}),
    };

    res.json({
      success: true,
      project: projectPath,
      health,
    });
  } catch (error) {
    console.error('Error computing health status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to compute health status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    projectDb.close();
    closeGlobal();
  }
});

export default router;
