import { Router, type Request, type Response } from 'express';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HuggingFaceTokenAuth } from '../../../src/huggingface/auth.js';
import { HuggingFaceModelRegistry, type HFCachedModel } from '../../../src/huggingface/model-registry.js';
import { openGlobalDatabase } from '../../../dist/runners/global-db.js';

const router = Router();

const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map<string, { expiresAt: number; models: HFCachedModel[] }>();

const RUNTIME_VALUES = new Set(['claude-code', 'opencode']);
const BASE_ROUTING_POLICIES = new Set(['fastest', 'cheapest', 'preferred']);

interface HFReadyModelRow {
  model_id: string;
  runtime: string;
  routing_policy: string;
  supports_tools: number;
  available: number;
  added_at: number;
}

function getAuth(): HuggingFaceTokenAuth {
  return new HuggingFaceTokenAuth({
    tokenFilePath: join(getSteroidsHomeDir(), 'huggingface', 'token'),
  });
}

function getRegistry(): HuggingFaceModelRegistry {
  return new HuggingFaceModelRegistry({
    cacheFilePath: join(getSteroidsHomeDir(), 'huggingface', 'models.json'),
  });
}

function getSteroidsHomeDir(): string {
  return process.env.STEROIDS_HOME || join(homedir(), '.steroids');
}

function isAllowedRoutingPolicy(value: string): boolean {
  if (BASE_ROUTING_POLICIES.has(value)) return true;
  return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function getModelMap(models: HFCachedModel[]): Map<string, HFCachedModel> {
  return new Map(models.map((model) => [model.id, model]));
}

function getRoutingPolicyOptions(providers: string[]): string[] {
  return [...BASE_ROUTING_POLICIES, ...providers];
}

function toReadyModelResponse(row: HFReadyModelRow, model?: HFCachedModel) {
  const providers = model?.providers ?? [];
  return {
    modelId: row.model_id,
    runtime: row.runtime,
    routingPolicy: row.routing_policy,
    supportsTools: model?.supportsTools ?? (row.supports_tools === 1),
    available: row.available === 1,
    addedAt: row.added_at,
    providers,
    contextLength: model?.contextLength,
    pricing: model?.pricing,
    providerContextLengths: model?.providerContextLengths,
    routingPolicyOptions: getRoutingPolicyOptions(providers),
  };
}

router.get('/hf/account', async (_req: Request, res: Response) => {
  const auth = getAuth();
  try {
    if (!auth.hasToken()) {
      res.json({
        connected: false,
      });
      return;
    }

    const validation = await auth.validateToken();
    if (!validation.valid) {
      res.json({
        connected: true,
        valid: false,
        error: validation.error,
      });
      return;
    }

    const account = validation.account;
    const orgEnterprise = (account?.orgs ?? []).some((org) => org.isEnterprise);
    const tier = orgEnterprise ? 'enterprise' : (account?.isPro ? 'pro' : 'free');

    res.json({
      connected: true,
      valid: true,
      name: account?.name ?? null,
      tier,
      canPay: Boolean(account?.canPay),
      hasBroadScopes: Boolean(validation.hasBroadScopes),
      periodEnd: account?.periodEnd ?? null,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load Hugging Face account',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/hf/account/connect', async (req: Request, res: Response) => {
  const auth = getAuth();
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  try {
    const validation = await auth.validateToken(token);
    if (!validation.valid) {
      res.status(400).json({
        error: validation.error ?? 'Invalid token',
      });
      return;
    }

    auth.saveToken(token);
    res.json({
      ok: true,
      connected: true,
      name: validation.account?.name ?? null,
      hasBroadScopes: Boolean(validation.hasBroadScopes),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to connect Hugging Face account',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/hf/account/disconnect', (_req: Request, res: Response) => {
  const auth = getAuth();
  try {
    auth.clearToken();
    res.json({ ok: true, connected: false });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to disconnect Hugging Face account',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/hf/models', async (req: Request, res: Response) => {
  const auth = getAuth();
  const registry = getRegistry();
  const query = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const token = auth.getToken() ?? undefined;

  try {
    if (!query) {
      const models = await registry.getCuratedModels({ token });
      res.json({
        source: 'curated',
        models,
      });
      return;
    }

    const cached = searchCache.get(query);
    if (cached && cached.expiresAt > Date.now()) {
      res.json({
        source: 'search-cache',
        models: cached.models,
      });
      return;
    }

    const models = await registry.searchModels(query, { token });
    searchCache.set(query, {
      expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
      models,
    });

    res.json({
      source: 'search',
      models,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load Hugging Face models',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/hf/ready-models', async (_req: Request, res: Response) => {
  const auth = getAuth();
  const registry = getRegistry();
  const { db, close } = openGlobalDatabase();
  try {
    const rows = db.prepare(
      `SELECT model_id, runtime, routing_policy, supports_tools, available, added_at
       FROM hf_paired_models
       ORDER BY added_at DESC, model_id ASC`
    ).all() as HFReadyModelRow[];

    const token = auth.getToken() ?? undefined;
    const curated = await registry.getCuratedModels({ token }).catch(() => []);
    const modelMap = getModelMap(curated);
    const missingModelIds = rows
      .map((row) => row.model_id)
      .filter((modelId) => !modelMap.has(modelId));

    if (missingModelIds.length > 0) {
      const fallbackModels = await mapWithConcurrency(missingModelIds, 4, async (modelId) => {
        const result = await registry.searchModels(modelId, { limit: 5, token }).catch(() => []);
        return result.find((model) => model.id === modelId) ?? null;
      });
      for (const model of fallbackModels) {
        if (model) modelMap.set(model.id, model);
      }
    }

    res.json({
      models: rows.map((row) => toReadyModelResponse(row, modelMap.get(row.model_id))),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to load ready-to-use Hugging Face models',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.post('/hf/ready-models', async (req: Request, res: Response) => {
  const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
  const runtime = typeof req.body?.runtime === 'string' ? req.body.runtime.trim() : '';
  const routingPolicy = typeof req.body?.routingPolicy === 'string' ? req.body.routingPolicy.trim() : 'fastest';
  const supportsTools = req.body?.supportsTools ? 1 : 0;

  if (!modelId) {
    res.status(400).json({ error: 'modelId is required' });
    return;
  }

  if (!RUNTIME_VALUES.has(runtime)) {
    res.status(400).json({ error: 'runtime must be claude-code or opencode' });
    return;
  }

  if (!isAllowedRoutingPolicy(routingPolicy)) {
    res.status(400).json({ error: 'routingPolicy is invalid' });
    return;
  }

  const { db, close } = openGlobalDatabase();
  try {
    db.prepare(
      `INSERT INTO hf_paired_models (model_id, runtime, routing_policy, supports_tools, available, added_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(model_id, runtime)
       DO UPDATE SET
         routing_policy = excluded.routing_policy,
         supports_tools = excluded.supports_tools,
         available = 1`
    ).run(modelId, runtime, routingPolicy, supportsTools, Date.now());

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save ready-to-use model',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.patch('/hf/ready-models', (req: Request, res: Response) => {
  const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
  const runtime = typeof req.body?.runtime === 'string' ? req.body.runtime.trim() : '';
  const routingPolicy = typeof req.body?.routingPolicy === 'string' ? req.body.routingPolicy.trim() : '';

  if (!modelId || !runtime || !routingPolicy) {
    res.status(400).json({ error: 'modelId, runtime, and routingPolicy are required' });
    return;
  }

  if (!isAllowedRoutingPolicy(routingPolicy)) {
    res.status(400).json({ error: 'routingPolicy is invalid' });
    return;
  }

  const { db, close } = openGlobalDatabase();
  try {
    const result = db.prepare(
      `UPDATE hf_paired_models
       SET routing_policy = ?
       WHERE model_id = ? AND runtime = ?`
    ).run(routingPolicy, modelId, runtime);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Model pairing not found' });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update routing policy',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.post('/hf/ready-models/runtime', (req: Request, res: Response) => {
  const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
  const runtime = typeof req.body?.runtime === 'string' ? req.body.runtime.trim() : '';
  const nextRuntime = typeof req.body?.nextRuntime === 'string' ? req.body.nextRuntime.trim() : '';

  if (!modelId || !runtime || !nextRuntime) {
    res.status(400).json({ error: 'modelId, runtime, and nextRuntime are required' });
    return;
  }
  if (!RUNTIME_VALUES.has(runtime) || !RUNTIME_VALUES.has(nextRuntime)) {
    res.status(400).json({ error: 'runtime and nextRuntime must be claude-code or opencode' });
    return;
  }

  const { db, close } = openGlobalDatabase();
  try {
    const row = db.prepare(
      `SELECT routing_policy, supports_tools, available, added_at
       FROM hf_paired_models
       WHERE model_id = ? AND runtime = ?`
    ).get(modelId, runtime) as {
      routing_policy: string;
      supports_tools: number;
      available: number;
      added_at: number;
    } | undefined;

    if (!row) {
      res.status(404).json({ error: 'Model pairing not found' });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO hf_paired_models (model_id, runtime, routing_policy, supports_tools, available, added_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_id, runtime)
         DO UPDATE SET
           routing_policy = excluded.routing_policy,
           supports_tools = excluded.supports_tools,
           available = excluded.available`
      ).run(modelId, nextRuntime, row.routing_policy, row.supports_tools, row.available, row.added_at);

      db.prepare(
        `DELETE FROM hf_paired_models
         WHERE model_id = ? AND runtime = ?`
      ).run(modelId, runtime);
    });
    tx();

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to change runtime',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

router.delete('/hf/ready-models', (req: Request, res: Response) => {
  const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
  const runtime = typeof req.body?.runtime === 'string' ? req.body.runtime.trim() : '';

  if (!modelId || !runtime) {
    res.status(400).json({ error: 'modelId and runtime are required' });
    return;
  }

  const { db, close } = openGlobalDatabase();
  try {
    const result = db.prepare(
      `DELETE FROM hf_paired_models
       WHERE model_id = ? AND runtime = ?`
    ).run(modelId, runtime);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Model pairing not found' });
      return;
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to remove ready-to-use model',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    close();
  }
});

export default router;

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>
): Promise<U[]> {
  if (items.length === 0) return [];
  const results: U[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}
