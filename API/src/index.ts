/**
 * Steroids API Server
 * REST API for multi-project monitoring and management
 */

import express from 'express';
import cors from 'cors';
import { execSync } from 'node:child_process';
import { realpathSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load API keys from .zshrc if not already set in the environment.
// The API server is a daemon and may not inherit interactive shell env vars.
(function loadEnvFromZshrc() {
  const vars = ['STEROIDS_ANTHROPIC', 'STEROIDS_GOOGLE', 'STEROIDS_MISTRAL', 'STEROIDS_OPENAI'];
  const missing = vars.filter((v) => !process.env[v]);
  if (missing.length === 0) return;
  try {
    const exports = missing.map((v) => `printf "${v}=%s\\n" "$${v}"`).join('; ');
    const out = execSync(
      `zsh -c 'source ~/.zshrc 2>/dev/null; ${exports}'`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq);
      const val = line.slice(eq + 1).trim();
      if (val && !process.env[key]) process.env[key] = val;
    }
  } catch {
    // .zshrc not accessible or vars not defined there — continue without them
  }
}());
import projectsRouter from './routes/projects.js';
import storageRouter from './routes/storage.js';
import activityRouter from './routes/activity.js';
import runnersRouter from './routes/runners.js';
import tasksRouter from './routes/tasks.js';
import taskFeedbackRouter from './routes/task-feedback.js';
import configRouter from './routes/config.js';
import reviewerConfigRouter from './routes/config-reviewer.js';
import healthRouter from './routes/health.js';
import incidentsRouter from './routes/incidents.js';
import skillsRouter from './routes/skills.js';
import { creditAlertRoutes } from './routes/credit-alerts.js';

const PORT = process.env.PORT || 3501;
const HOST = process.env.HOST || '0.0.0.0';

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  const paths = [
    join(__dirname, '..', 'package.json'),       // From src/
    join(__dirname, '..', '..', 'package.json'), // From dist/
  ];
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        return JSON.parse(readFileSync(p, 'utf-8')).version;
      }
    } catch { /* continue */ }
  }
  return 'unknown';
}

const version = getVersion();

export function createApp(): express.Express {
  const app = express();

  // Middleware - CORS allowing all origins for local network access
  app.use(cors({
    origin: true, // Allow all origins
    credentials: true,
  }));
  app.use(express.json());

  // Request logging (keep test output clean)
  if (process.env.NODE_ENV !== 'test') {
    app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
      next();
    });
  }

  // Routes
  app.use('/api', projectsRouter);
  app.use('/api', storageRouter);
  app.use('/api', activityRouter);
  app.use('/api', runnersRouter);
  app.use('/api', tasksRouter);
  app.use('/api', taskFeedbackRouter);
  app.use('/api', configRouter);
  app.use('/api', reviewerConfigRouter);
  app.use('/api', healthRouter);
  app.use('/api', incidentsRouter);
  app.use('/api', skillsRouter);
  app.use('/api/credit-alerts', creditAlertRoutes);

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version,
    });
  });

  // Root endpoint
  app.get('/', (req, res) => {
    res.json({
      name: 'Steroids API',
      version,
      endpoints: [
        'GET /health',
        'GET /api/projects',
        'GET /api/projects/status?path=<path>',
        'GET /api/projects/storage?path=<path>',
        'GET /api/projects/<path>/tasks?status=<status>&section=<id>&issue=<failed_retries|stale>&hours=<hours>',
        'GET /api/projects/<path>/sections',
        'POST /api/projects',
        'POST /api/projects/remove',
        'POST /api/projects/enable',
        'POST /api/projects/disable',
        'POST /api/projects/prune',
        'GET /api/activity?hours=<hours>&project=<path>',
        'GET /api/runners',
        'GET /api/runners/active-tasks',
        'GET /api/tasks/<taskId>?project=<path>',
        'GET /api/tasks/<taskId>/logs?project=<path>',
        'GET /api/tasks/<taskId>/feedback?project=<path>',
        'POST /api/tasks/<taskId>/feedback',
        'DELETE /api/tasks/<taskId>/feedback/<feedbackId>?project=<path>',
        'GET /api/config/schema',
        'GET /api/config/schema/<category>',
        'GET /api/config?scope=global|project|merged&project=<path>',
        'PUT /api/config',
        'PUT /api/config/reviewer-custom-instructions',
        'GET /api/health?project=<path>',
        'GET /api/incidents?project=<path>&limit=<n>&task=<prefix>&unresolved=<true|false>',
        'GET /api/ai/providers',
        'GET /api/ai/models/<provider>',
        'GET /api/credit-alerts?project=<path>',
        'POST /api/credit-alerts/<id>/dismiss',
        'POST /api/credit-alerts/<id>/retry',
      ],
    });
  });

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: 'Not found',
      path: req.path,
    });
  });

  // Error handler
  app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: err.message,
    });
  });

  return app;
}

const app = createApp();

export function startServer(): void {
  // Start server on all interfaces
  app.listen(Number(PORT), HOST, () => {
    console.log(`Steroids API server listening on ${HOST}:${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`API docs: http://localhost:${PORT}/`);
  });
}

function normalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Only start listening when executed as the entrypoint (safe to import in tests).
// This works for `node dist/.../index.js` and `tsx watch src/index.ts` (tsx keeps the entry file in argv).
const shouldAutoStart = (() => {
  if (process.env.NODE_ENV === 'test') return false;
  const thisPath = normalizePath(fileURLToPath(import.meta.url));
  const argvPaths = process.argv.slice(1).map((a) => normalizePath(a));
  return argvPaths.includes(thisPath);
})();

if (shouldAutoStart) startServer();

export default app;
