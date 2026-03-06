import { Router, type Request, type Response } from 'express';
import { createOllamaApiClient, getResolvedConnectionConfig } from '../../../src/ollama/connection.js';
import type { OllamaPullProgress } from '../../../src/ollama/api-client.js';

const router = Router();
const PULL_TIMEOUT_MS = 30 * 60 * 1000;

function writeProgress(res: Response, progress: OllamaPullProgress): void {
  res.write(`data: ${JSON.stringify(progress)}\n\n`);
}

router.post('/ollama/pull', async (req: Request, res: Response) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) {
    res.status(400).json({ success: false, error: 'model is required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const resolved = getResolvedConnectionConfig();
  const client = createOllamaApiClient(resolved);
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  try {
    await client.pullModel(
      model,
      (progress) => {
        if (!closed) {
          writeProgress(res, progress);
        }
      },
      { timeoutMs: PULL_TIMEOUT_MS },
    );
  } catch (error) {
    if (!closed) {
      writeProgress(res, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        phase: 'error',
        done: true,
        percent: null,
      });
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
});

export default router;
