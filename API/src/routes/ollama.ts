import { Router, type Request, type Response } from 'express';
import {
  createOllamaApiClient,
  getResolvedConnectionConfig,
  loadConnectionConfig,
  setLocalConnection,
  setCloudConnection,
  testConnection,
} from '../../../dist/ollama/connection.js';
import { getInstalledModels } from '../../../dist/ollama/model-registry.js';
import type { OllamaPullProgress } from '../../../dist/ollama/api-client.js';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';

const router = Router();
const PULL_TIMEOUT_MS = 30 * 60 * 1000;

function writeProgress(res: Response, progress: OllamaPullProgress): void {
  res.write(`data: ${JSON.stringify(progress)}\n\n`);
}

// --- Connection endpoints ---

router.get('/ollama/connection', (_req: Request, res: Response) => {
  try {
    const config = loadConnectionConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/ollama/connection', async (req: Request, res: Response) => {
  try {
    const { mode, endpoint, apiKey } = req.body ?? {};
    if (mode === 'cloud') {
      if (!apiKey || typeof apiKey !== 'string') {
        res.status(400).json({ error: 'apiKey is required for cloud mode' });
        return;
      }
      const config = setCloudConnection(apiKey, endpoint);
      res.json(config);
    } else {
      const config = setLocalConnection(endpoint);
      res.json(config);
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/ollama/connection/test', async (_req: Request, res: Response) => {
  try {
    const status = await testConnection();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// --- Models endpoints ---

router.get('/ollama/models', async (_req: Request, res: Response) => {
  try {
    const config = getResolvedConnectionConfig();
    const client = createOllamaApiClient(config);
    const models = await getInstalledModels({
      client,
      endpoint: config.endpoint,
      mode: config.mode,
    });
    res.json(models);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.delete('/ollama/models', async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const config = getResolvedConnectionConfig();
    const client = createOllamaApiClient(config);
    await client.deleteModel(name);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// --- Paired models endpoints ---

router.get('/ollama/paired-models', (_req: Request, res: Response) => {
  const { db, close } = openGlobalDatabase();
  try {
    const rows = db.prepare('SELECT * FROM ollama_paired_models ORDER BY added_at DESC').all();
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    close();
  }
});

router.post('/ollama/paired-models', (req: Request, res: Response) => {
  const { model_name, runtime, endpoint, supports_tools } = req.body ?? {};
  if (!model_name || !runtime || !endpoint) {
    res.status(400).json({ error: 'model_name, runtime, and endpoint are required' });
    return;
  }
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `INSERT INTO ollama_paired_models (model_name, runtime, endpoint, supports_tools, available, added_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    ).run(model_name, runtime, endpoint, supports_tools ? 1 : 0, Date.now());
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    close();
  }
});

router.delete('/ollama/paired-models', (req: Request, res: Response) => {
  const id = req.body?.id;
  if (id === undefined || id === null) {
    res.status(400).json({ error: 'id is required' });
    return;
  }
  const { db, close } = openGlobalDatabase();
  try {
    db.prepare('DELETE FROM ollama_paired_models WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    close();
  }
});

// --- Pull endpoint (SSE) ---

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
