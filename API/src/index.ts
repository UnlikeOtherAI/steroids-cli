/**
 * Steroids API Server
 * REST API for multi-project monitoring and management
 */

import express from 'express';
import cors from 'cors';
import projectsRouter from './routes/projects.js';
import activityRouter from './routes/activity.js';
import runnersRouter from './routes/runners.js';

const app = express();
const PORT = process.env.PORT || 3501;

// Middleware
app.use(cors());
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.2.5',
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Steroids API',
    version: '0.2.5',
    endpoints: [
      'GET /health',
      'GET /api/projects',
      'GET /api/projects/status?path=<path>',
      'POST /api/projects',
      'POST /api/projects/remove',
      'POST /api/projects/enable',
      'POST /api/projects/disable',
      'POST /api/projects/prune',
      'GET /api/activity?hours=<hours>&project=<path>',
      'GET /api/runners',
      'GET /api/runners/active-tasks',
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

// Start server
app.listen(PORT, () => {
  console.log(`Steroids API server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API docs: http://localhost:${PORT}/`);
});

export default app;
