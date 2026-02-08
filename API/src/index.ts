/**
 * Steroids API Server
 * REST API for multi-project monitoring and management
 */

import express from 'express';
import cors from 'cors';
import projectsRouter from './routes/projects.js';
import activityRouter from './routes/activity.js';
import runnersRouter from './routes/runners.js';
import tasksRouter from './routes/tasks.js';

const app = express();
const PORT = process.env.PORT || 3501;
const HOST = process.env.HOST || '0.0.0.0';

// Middleware - CORS allowing all origins for local network access
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
}));
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api', projectsRouter);
app.use('/api', activityRouter);
app.use('/api', runnersRouter);
app.use('/api', tasksRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.4.2',
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Steroids API',
    version: '0.4.2',
    endpoints: [
      'GET /health',
      'GET /api/projects',
      'GET /api/projects/status?path=<path>',
      'GET /api/projects/<path>/tasks',
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

// Start server on all interfaces
app.listen(Number(PORT), HOST, () => {
  console.log(`Steroids API server listening on ${HOST}:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API docs: http://localhost:${PORT}/`);
});

export default app;
