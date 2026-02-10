/**
 * Tasks API routes
 * Exposes task details and logs for individual tasks
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Tail } from 'tail';
import { openSqliteForRead } from '../utils/sqlite.js';

const router = Router();

const MAX_SSE_CONNECTIONS = Math.max(1, parseInt(process.env.MAX_SSE_CONNECTIONS || '100', 10) || 100);
let activeSseConnections = 0;

interface TaskDetails {
  id: string;
  title: string;
  status: string;
  section_id: string | null;
  section_name: string | null;
  source_file: string | null;
  rejection_count: number;
  created_at: string;
  updated_at: string;
}

interface AuditEntry {
  id: number;
  task_id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  actor_type: string | null;
  model: string | null;
  notes: string | null;
  commit_sha: string | null;
  created_at: string;
  duration_seconds?: number;
}

interface InvocationEntry {
  id: number;
  task_id: string;
  role: string;
  provider: string;
  model: string;
  exit_code: number;
  duration_ms: number;
  success: number;
  timed_out: number;
  rejection_number: number | null;
  created_at: string;
}

interface InvocationDetails extends InvocationEntry {
  prompt: string;
  response: string | null;
  error: string | null;
}

interface DisputeEntry {
  id: string;
  task_id: string;
  type: string;
  status: string;
  reason: string;
  coder_position: string | null;
  reviewer_position: string | null;
  resolution: string | null;
  resolution_notes: string | null;
  created_by: string;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface TaskResponse extends TaskDetails {
  duration: {
    total_seconds: number;
    in_progress_seconds: number;
    review_seconds: number;
  };
  audit_trail: AuditEntry[];
  invocations: InvocationEntry[];
  disputes: DisputeEntry[];
  github_url: string | null;
}

/**
 * Get GitHub URL from git remote
 * @param projectPath - Path to project root
 * @returns GitHub base URL (e.g., https://github.com/owner/repo) or null
 */
function getGitHubUrl(projectPath: string): string | null {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: projectPath,
      encoding: 'utf-8',
    }).trim();

    // Convert SSH or HTTPS URL to web URL
    // SSH: git@github.com:owner/repo.git
    // HTTPS: https://github.com/owner/repo.git
    let webUrl: string | null = null;

    if (remoteUrl.startsWith('git@github.com:')) {
      // SSH format
      const path = remoteUrl.replace('git@github.com:', '').replace(/\.git$/, '');
      webUrl = `https://github.com/${path}`;
    } else if (remoteUrl.includes('github.com')) {
      // HTTPS format
      webUrl = remoteUrl.replace(/\.git$/, '');
    }

    return webUrl;
  } catch {
    return null;
  }
}

/**
 * Open project database
 * @param projectPath - Path to project root
 * @returns Database connection or null if not found
 */
function openProjectDatabase(projectPath: string): Database.Database | null {
  const dbPath = join(projectPath, '.steroids', 'steroids.db');
  if (!existsSync(dbPath)) {
    return null;
  }
  try {
    return openSqliteForRead(dbPath);
  } catch {
    return null;
  }
}

/**
 * Calculate duration for each status from audit trail
 * @param auditTrail - Array of audit entries sorted by created_at
 * @returns Audit entries with duration_seconds added
 */
function calculateDurations(auditTrail: AuditEntry[]): AuditEntry[] {
  // Sort by created_at ascending for duration calculation
  const sorted = [...auditTrail].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

  return sorted.map((entry, index) => {
    // Duration is time until next status change
    if (index < sorted.length - 1) {
      const startTime = new Date(entry.created_at).getTime();
      const endTime = new Date(sorted[index + 1].created_at).getTime();
      const durationSeconds = Math.round((endTime - startTime) / 1000);
      return { ...entry, duration_seconds: durationSeconds };
    }
    // Current/last status - duration from entry until now
    const startTime = new Date(entry.created_at).getTime();
    const now = Date.now();
    const durationSeconds = Math.round((now - startTime) / 1000);
    return { ...entry, duration_seconds: durationSeconds };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeSSE(res: Response, payload: unknown): Promise<void> {
  if (res.writableEnded) return;
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  const ok = res.write(chunk);
  if (ok) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('error', onError);
    };
    res.on('drain', onDrain);
    res.on('error', onError);
  });
}

async function writeSSEComment(res: Response, comment: string): Promise<void> {
  if (res.writableEnded) return;
  const chunk = `: ${comment}\n\n`;
  const ok = res.write(chunk);
  if (ok) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('error', onError);
    };
    res.on('drain', onDrain);
    res.on('error', onError);
  });
}

async function waitForFile(filePath: string, opts: { timeoutMs: number; pollMs: number; isAborted: () => boolean }): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (opts.isAborted()) return false;
    if (existsSync(filePath)) return true;
    await sleep(opts.pollMs);
  }
  return existsSync(filePath);
}

async function streamJsonlFileToSSE(
  res: Response,
  filePath: string,
  opts: { isAborted: () => boolean }
): Promise<void> {
  const rs = createReadStream(filePath, { encoding: 'utf8' });
  let buffer = '';

  for await (const chunk of rs) {
    if (opts.isAborted()) return;
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        await writeSSE(res, entry);
      } catch {
        // ignore malformed JSONL lines
      }
    }
  }

  const tailLine = buffer.trim();
  if (tailLine && !opts.isAborted()) {
    try {
      const entry = JSON.parse(tailLine);
      await writeSSE(res, entry);
    } catch {
      // ignore
    }
  }
}

async function readSampledJsonlEntries(
  filePath: string,
  opts: { keepEveryN: number; shouldKeep?: (entry: any, index: number) => boolean }
): Promise<any[]> {
  const rs = createReadStream(filePath, { encoding: 'utf8' });
  let buffer = '';
  let index = 0;
  const out: any[] = [];

  const keep = (entry: any, i: number): boolean => {
    if (opts.shouldKeep) return opts.shouldKeep(entry, i);
    // Keep all tools, and sample the rest.
    return entry?.type === 'tool' || i % opts.keepEveryN === 0;
  };

  for await (const chunk of rs) {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');

      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (keep(entry, index)) out.push(entry);
      } catch {
        // ignore malformed JSONL lines
      } finally {
        index++;
      }
    }
  }

  const tailLine = buffer.trim();
  if (tailLine) {
    try {
      const entry = JSON.parse(tailLine);
      if (keep(entry, index)) out.push(entry);
    } catch {
      // ignore
    }
  }

  return out;
}

/**
 * GET /api/tasks/:taskId
 * Get detailed information about a task including audit history
 * Query params:
 *   - project: string (required) - project path
 */
router.get('/tasks/:taskId', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const projectPath = req.query.project as string;

    if (!projectPath) {
      res.status(400).json({
        success: false,
        error: 'Missing required query parameter: project',
      });
      return;
    }

    const db = openProjectDatabase(projectPath);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    try {
      // Get task details with section name
      const task = db
        .prepare(
          `SELECT
            t.id, t.title, t.status, t.section_id,
            s.name as section_name,
            t.source_file, t.rejection_count,
            t.created_at, t.updated_at
          FROM tasks t
          LEFT JOIN sections s ON t.section_id = s.id
          WHERE t.id = ?`
        )
        .get(taskId) as TaskDetails | undefined;

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found',
          task_id: taskId,
        });
        return;
      }

      // Get audit trail
      const auditTrail = db
        .prepare(
          `SELECT id, task_id, from_status, to_status, actor, actor_type, model, notes, commit_sha, created_at
          FROM audit
          WHERE task_id = ?
          ORDER BY created_at ASC`
        )
        .all(taskId) as AuditEntry[];

      // Get disputes for task
      const disputes = db
        .prepare(
          `SELECT * FROM disputes
          WHERE task_id = ?
          ORDER BY created_at DESC`
        )
        .all(taskId) as DisputeEntry[];

      // Get LLM invocations (exclude prompt/response to keep payload light)
      const invocations = db
        .prepare(
          `SELECT id, task_id, role, provider, model, exit_code, duration_ms, success, timed_out, rejection_number, created_at
          FROM task_invocations
          WHERE task_id = ?
          ORDER BY created_at ASC`
        )
        .all(taskId) as InvocationEntry[];

      // Calculate durations for each status
      const auditWithDurations = calculateDurations(auditTrail);

      // Calculate total time in each status
      let inProgressSeconds = 0;
      let reviewSeconds = 0;

      for (const entry of auditWithDurations) {
        if (entry.to_status === 'in_progress' && entry.duration_seconds) {
          inProgressSeconds += entry.duration_seconds;
        } else if (entry.to_status === 'review' && entry.duration_seconds) {
          reviewSeconds += entry.duration_seconds;
        }
      }

      // Total time is just the sum of active work time (coding + review)
      const totalSeconds = inProgressSeconds + reviewSeconds;

      // Get GitHub URL for commit links
      const githubUrl = getGitHubUrl(projectPath);

      const response: TaskResponse = {
        ...task,
        duration: {
          total_seconds: totalSeconds,
          in_progress_seconds: inProgressSeconds,
          review_seconds: reviewSeconds,
        },
        audit_trail: auditWithDurations.reverse(), // Most recent first for display
        invocations, // Oldest first (chronological)
        disputes,
        github_url: githubUrl,
      };

      res.json({
        success: true,
        task: response,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error getting task details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get task details',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/tasks/:taskId/stream
 * Stream invocation activity (JSONL) for the currently-running invocation using SSE.
 * Query params:
 *   - project: string (required) - project path
 */
router.get('/tasks/:taskId/stream', async (req: Request, res: Response) => {
  const { taskId } = req.params;
  const projectPath = req.query.project as string | undefined;

  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Missing required query parameter: project',
    });
    return;
  }

  if (activeSseConnections >= MAX_SSE_CONNECTIONS) {
    res.status(429).json({
      success: false,
      error: 'Too many active streams',
      max: MAX_SSE_CONNECTIONS,
    });
    return;
  }

  activeSseConnections++;

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    activeSseConnections = Math.max(0, activeSseConnections - 1);
    try {
      res.end();
    } catch {
      // ignore
    }
  };

  req.on('close', close);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const db = openProjectDatabase(projectPath);
  if (!db) {
    await writeSSE(res, { type: 'error', error: 'Project database not found', project: projectPath });
    close();
    return;
  }

  let invocation: { id: number; status: string } | undefined;
  try {
    invocation = db
      .prepare(
        `SELECT id, status
         FROM task_invocations
         WHERE task_id = ? AND status = 'running'
         ORDER BY started_at_ms DESC
         LIMIT 1`
      )
      .get(taskId) as { id: number; status: string } | undefined;
  } catch (error) {
    await writeSSE(res, {
      type: 'error',
      error: 'Failed to query running invocation (is the database migrated?)',
      message: error instanceof Error ? error.message : String(error),
    });
    close();
    return;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  if (!invocation) {
    await writeSSE(res, { type: 'no_active_invocation', taskId });
    close();
    return;
  }

  const logFile = join(projectPath, '.steroids', 'invocations', `${invocation.id}.log`);
  const isAborted = (): boolean => closed || res.writableEnded;

  // If the invocation just started, the log file may not exist yet.
  if (!existsSync(logFile)) {
    await writeSSE(res, { type: 'waiting_for_log', taskId, invocationId: invocation.id });
    const ok = await waitForFile(logFile, { timeoutMs: 5000, pollMs: 100, isAborted });
    if (!ok) {
      await writeSSE(res, { type: 'log_not_found', taskId, invocationId: invocation.id });
      close();
      return;
    }
  }

  try {
    // 1) Send existing log entries first
    await streamJsonlFileToSSE(res, logFile, { isAborted });

    if (isAborted()) return;

    // 2) Tail for new entries
    const tail = new Tail(logFile, { follow: true, useWatchFile: true });
    let writeChain: Promise<void> = Promise.resolve();

    const heartbeat = setInterval(() => {
      // Keep proxies from timing out the connection.
      writeChain = writeChain.then(() => writeSSEComment(res, 'heartbeat')).catch(() => {});
    }, 30000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      try {
        tail.unwatch();
      } catch {
        // ignore
      }
      close();
    };

    req.on('close', () => {
      clearInterval(heartbeat);
      try {
        tail.unwatch();
      } catch {}
    });

    tail.on('line', (line: string) => {
      if (isAborted()) return;
      const trimmed = line.trim();
      if (!trimmed) return;

      writeChain = writeChain
        .then(async () => {
          try {
            const entry = JSON.parse(trimmed) as any;
            await writeSSE(res, entry);
            if (entry?.type === 'complete' || entry?.type === 'error') {
              cleanup();
            }
          } catch {
            // ignore malformed JSONL lines
          }
        })
        .catch(() => {});
    });

    tail.on('error', (err: unknown) => {
      void writeChain
        .then(() =>
          writeSSE(res, {
            type: 'error',
            error: 'Tail error',
            message: err instanceof Error ? err.message : String(err),
          })
        )
        .finally(cleanup);
    });
  } catch (error) {
    await writeSSE(res, {
      type: 'error',
      error: 'Failed to stream invocation log',
      message: error instanceof Error ? error.message : String(error),
    });
    close();
  }
});

/**
 * GET /api/tasks/:taskId/timeline
 * Parse invocation JSONL activity logs on demand and return a sampled timeline.
 * Query params:
 *   - project: string (required) - project path
 */
router.get('/tasks/:taskId/timeline', async (req: Request, res: Response) => {
  const { taskId } = req.params;
  const projectPath = req.query.project as string | undefined;

  if (!projectPath) {
    res.status(400).json({
      success: false,
      error: 'Missing required query parameter: project',
    });
    return;
  }

  const db = openProjectDatabase(projectPath);
  if (!db) {
    res.status(404).json({
      success: false,
      error: 'Project database not found',
      project: projectPath,
    });
    return;
  }

  type InvocationTimelineRow = {
    id: number;
    role: string;
    provider: string;
    model: string;
    started_at_ms: number;
    completed_at_ms: number | null;
    status: string;
  };

  let invocations: InvocationTimelineRow[] = [];
  try {
    invocations = db
      .prepare(
        `SELECT id, role, provider, model, started_at_ms, completed_at_ms, status
         FROM task_invocations
         WHERE task_id = ?
         ORDER BY started_at_ms ASC`
      )
      .all(taskId) as InvocationTimelineRow[];
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to query invocations (is the database migrated?)',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  } finally {
    try {
      db.close();
    } catch {}
  }

  const timeline: any[] = [];

  for (const inv of invocations) {
    // Invocation start event (from DB lifecycle timestamps).
    timeline.push({
      ts: inv.started_at_ms,
      type: 'invocation.started',
      invocationId: inv.id,
      role: inv.role,
      provider: inv.provider,
      model: inv.model,
    });

    const logFile = join(projectPath, '.steroids', 'invocations', `${inv.id}.log`);
    if (existsSync(logFile)) {
      try {
        const sampled = await readSampledJsonlEntries(logFile, { keepEveryN: 10 });
        for (const e of sampled) timeline.push({ ...e, invocationId: inv.id });
      } catch {
        // ignore per spec: timeline is best-effort
      }
    }

    // Invocation completion event, when available.
    if (inv.completed_at_ms) {
      timeline.push({
        ts: inv.completed_at_ms,
        type: 'invocation.completed',
        invocationId: inv.id,
        success: inv.status === 'completed',
        duration: inv.completed_at_ms - inv.started_at_ms,
      });
    }
  }

  res.json({ success: true, timeline });
});

/**
 * GET /api/tasks/:taskId/logs
 * Get execution logs/audit trail for a task
 * Query params:
 *   - project: string (required) - project path
 *   - limit: number (optional) - max entries to return (default: 50)
 *   - offset: number (optional) - offset for pagination (default: 0)
 */
router.get('/tasks/:taskId/logs', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const projectPath = req.query.project as string;
    const limitParam = req.query.limit;
    const offsetParam = req.query.offset;

    if (!projectPath) {
      res.status(400).json({
        success: false,
        error: 'Missing required query parameter: project',
      });
      return;
    }

    // Parse limit and offset
    let limit = 50;
    let offset = 0;

    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam as string, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500); // Cap at 500
      }
    }

    if (offsetParam !== undefined) {
      const parsed = parseInt(offsetParam as string, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        offset = parsed;
      }
    }

    const db = openProjectDatabase(projectPath);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    try {
      // Check task exists
      const task = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(taskId) as
        | { id: string; title: string; status: string }
        | undefined;

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found',
          task_id: taskId,
        });
        return;
      }

      // Get total count
      const countResult = db
        .prepare('SELECT COUNT(*) as count FROM audit WHERE task_id = ?')
        .get(taskId) as { count: number };

      // Get audit entries with pagination
      const logs = db
        .prepare(
          `SELECT id, task_id, from_status, to_status, actor, actor_type, model, notes, commit_sha, created_at
          FROM audit
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`
        )
        .all(taskId, limit, offset) as AuditEntry[];

      res.json({
        success: true,
        task_id: taskId,
        task_title: task.title,
        task_status: task.status,
        logs,
        pagination: {
          total: countResult.count,
          limit,
          offset,
          has_more: offset + logs.length < countResult.count,
        },
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error getting task logs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get task logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/projects/:projectPath/sections
 * List all sections for a project with task counts by status
 */
router.get('/projects/:projectPath(*)/sections', (req: Request, res: Response) => {
  try {
    const projectPath = decodeURIComponent(req.params.projectPath);

    const db = openProjectDatabase(projectPath);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    try {
      // Check if priority column exists (older databases may not have it)
      const hasPriority = (() => {
        try {
          const cols = db.prepare("PRAGMA table_info(sections)").all() as Array<{ name: string }>;
          return cols.some(c => c.name === 'priority');
        } catch {
          return false;
        }
      })();

      const prioritySelect = hasPriority ? 's.priority,' : '50 as priority,';
      const orderBy = hasPriority ? 'ORDER BY s.priority DESC, s.name ASC' : 'ORDER BY s.name ASC';

      // Get sections with task counts by status
      const sections = db
        .prepare(
          `SELECT
            s.id,
            s.name,
            ${prioritySelect}
            s.created_at,
            COUNT(t.id) as total_tasks,
            SUM(CASE WHEN t.status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
            SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END) as review,
            SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN t.status = 'skipped' THEN 1 ELSE 0 END) as skipped
          FROM sections s
          LEFT JOIN tasks t ON t.section_id = s.id
          GROUP BY s.id
          ${orderBy}`
        )
        .all() as Array<{
        id: string;
        name: string;
        priority: number;
        created_at: string;
        total_tasks: number;
        pending: number;
        in_progress: number;
        review: number;
        completed: number;
        failed: number;
        skipped: number;
      }>;

      // Also get tasks without a section (null section_id)
      const unassigned = db
        .prepare(
          `SELECT
            COUNT(*) as total_tasks,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
            SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
            SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
          FROM tasks
          WHERE section_id IS NULL`
        )
        .get() as {
        total_tasks: number;
        pending: number;
        in_progress: number;
        review: number;
        completed: number;
        failed: number;
        skipped: number;
      };

      res.json({
        success: true,
        project: projectPath,
        sections,
        unassigned: unassigned.total_tasks > 0 ? unassigned : null,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error listing project sections:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list project sections',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/projects/:projectPath/tasks
 * List all tasks for a project
 * Query params:
 *   - status: string (optional) - filter by status
 *   - section: string (optional) - filter by section id
 *   - limit: number (optional) - max entries (default: 100)
 */
router.get('/projects/:projectPath(*)/tasks', (req: Request, res: Response) => {
  try {
    // projectPath comes URL-encoded, decode it
    const projectPath = decodeURIComponent(req.params.projectPath);
    const statusFilter = req.query.status as string | undefined;
    const sectionFilter = req.query.section as string | undefined;
    const limitParam = req.query.limit;

    let limit = 100;
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam as string, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500);
      }
    }

    const db = openProjectDatabase(projectPath);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    try {
      let query = `
        SELECT
          t.id, t.title, t.status, t.section_id,
          s.name as section_name,
          t.source_file, t.rejection_count,
          t.created_at, t.updated_at
        FROM tasks t
        LEFT JOIN sections s ON t.section_id = s.id
        WHERE 1=1
      `;
      const params: (string | number)[] = [];

      if (statusFilter) {
        query += ' AND t.status = ?';
        params.push(statusFilter);
      }

      if (sectionFilter) {
        query += ' AND t.section_id = ?';
        params.push(sectionFilter);
      }

      query += ' ORDER BY t.created_at DESC LIMIT ?';
      params.push(limit);

      const tasks = db.prepare(query).all(...params) as TaskDetails[];

      // Get task counts by status
      const statusCounts = db
        .prepare(
          `SELECT status, COUNT(*) as count
          FROM tasks
          GROUP BY status`
        )
        .all() as { status: string; count: number }[];

      const counts = statusCounts.reduce(
        (acc, { status, count }) => {
          acc[status] = count;
          return acc;
        },
        {} as Record<string, number>
      );

      res.json({
        success: true,
        project: projectPath,
        tasks,
        count: tasks.length,
        status_counts: counts,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error listing project tasks:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list project tasks',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/tasks/:taskId/invocations/:invocationId
 * Get full details for a specific invocation including prompt and response
 * Query params:
 *   - project: string (required) - project path
 */
router.get('/tasks/:taskId/invocations/:invocationId', (req: Request, res: Response) => {
  try {
    const { taskId, invocationId } = req.params;
    const projectPath = req.query.project as string;

    if (!projectPath) {
      res.status(400).json({
        success: false,
        error: 'Missing required query parameter: project',
      });
      return;
    }

    const db = openProjectDatabase(projectPath);
    if (!db) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    try {
      // Get full invocation details including prompt and response
      const invocation = db
        .prepare(
          `SELECT id, task_id, role, provider, model, prompt, response, error, exit_code, duration_ms, success, timed_out, rejection_number, created_at
          FROM task_invocations
          WHERE id = ? AND task_id = ?`
        )
        .get(invocationId, taskId) as InvocationDetails | undefined;

      if (!invocation) {
        res.status(404).json({
          success: false,
          error: 'Invocation not found',
          invocation_id: invocationId,
          task_id: taskId,
        });
        return;
      }

      res.json({
        success: true,
        invocation,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error getting invocation details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get invocation details',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/tasks/:taskId/restart
 * Restart a failed/disputed task by resetting rejection count and setting status to pending
 * Body: { project: string, notes?: string }
 * Notes are stored in the audit entry as human guidance for the coder
 */
router.post('/tasks/:taskId/restart', (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const projectPath = req.body.project as string;
    const notes = req.body.notes as string | undefined;

    if (!projectPath) {
      res.status(400).json({
        success: false,
        error: 'Missing required body parameter: project',
      });
      return;
    }

    const dbPath = join(projectPath, '.steroids', 'steroids.db');
    if (!existsSync(dbPath)) {
      res.status(404).json({
        success: false,
        error: 'Project database not found',
        project: projectPath,
      });
      return;
    }

    let db: Database.Database;
    try {
      db = new Database(dbPath); // Writable mode
    } catch {
      res.status(500).json({
        success: false,
        error: 'Failed to open project database',
      });
      return;
    }

    try {
      // Check task exists
      const task = db.prepare('SELECT id, title, status FROM tasks WHERE id = ?').get(taskId) as
        | { id: string; title: string; status: string }
        | undefined;

      if (!task) {
        res.status(404).json({
          success: false,
          error: 'Task not found',
          task_id: taskId,
        });
        return;
      }

      // Block restart for tasks already in progress
      if (task.status === 'in_progress' || task.status === 'review') {
        res.status(400).json({
          success: false,
          error: `Cannot restart task in ${task.status} status. Task is currently being worked on.`,
        });
        return;
      }

      // Resolve any open disputes for this task
      const openDisputes = db
        .prepare(`SELECT id FROM disputes WHERE task_id = ? AND status = 'open'`)
        .all(taskId) as { id: string }[];

      for (const dispute of openDisputes) {
        db.prepare(
          `UPDATE disputes
           SET status = 'resolved', resolution = 'custom', resolution_notes = ?,
               resolved_by = 'human:webui', resolved_at = datetime('now')
           WHERE id = ?`
        ).run(notes || 'Resolved via WebUI restart', dispute.id);
      }

      // Reset task: set status to pending and rejection_count to 0
      db.prepare(
        `UPDATE tasks
         SET status = 'pending', rejection_count = 0, updated_at = datetime('now')
         WHERE id = ?`
      ).run(taskId);

      // Add audit entry with human guidance notes
      const auditNotes = notes
        ? `Task restarted via WebUI. Human guidance: ${notes}`
        : 'Task restarted via WebUI';

      db.prepare(
        `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, created_at)
         VALUES (?, ?, 'pending', 'human:webui', 'human', ?, datetime('now'))`
      ).run(taskId, task.status, auditNotes);

      res.json({
        success: true,
        message: 'Task restarted successfully',
        task_id: taskId,
        disputes_resolved: openDisputes.length,
      });
    } finally {
      db.close();
    }
  } catch (error) {
    console.error('Error restarting task:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to restart task',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
