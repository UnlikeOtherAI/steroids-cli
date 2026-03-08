import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createApp } from '../API/src/index.js';
import { openGlobalDatabase } from '../dist/runners/global-db.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('Unexpected address'));
      resolve(addr.port);
    });
  });
}

function createTempDir(prefix: string): string {
  const base = '/tmp';
  const dir = join(base, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('API Hugging Face routes', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;
  let server: http.Server;
  let port: number;
  let homeDir: string;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = createTempDir('steroids-home-hf-api');
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;
    const hfCacheDir = join(homeDir, 'huggingface');
    mkdirSync(hfCacheDir, { recursive: true });
    writeFileSync(
      join(hfCacheDir, 'models.json'),
      JSON.stringify({
        lastUpdated: Date.now(),
        models: [
          {
            id: 'deepseek-ai/DeepSeek-V3',
            pipelineTag: 'text-generation',
            downloads: 1,
            likes: 1,
            tags: [],
            providers: ['groq', 'novita'],
            contextLength: 131072,
            supportsTools: true,
            pricing: {
              groq: { input: 0.15, output: 0.75 },
              novita: { input: 0.05, output: 0.25 },
            },
            addedAt: Date.now(),
            source: 'search',
          },
        ],
      }),
      'utf-8'
    );

    const app = createApp();
    server = http.createServer(app);
    port = await listen(server);
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.STEROIDS_HOME;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns disconnected account status when token is not configured', async () => {
    const resp = await fetch(`http://127.0.0.1:${port}/api/hf/account`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { connected: boolean };
    expect(body.connected).toBe(false);
  });

  it('exposes hf and ollama providers with grouped ready-model picker options', async () => {
    const providersResp = await fetch(`http://127.0.0.1:${port}/api/ai/providers`);
    expect(providersResp.status).toBe(200);
    const providersBody = await providersResp.json() as {
      success: boolean;
      providers: Array<{ id: string; installed: boolean }>;
    };
    expect(providersBody.success).toBe(true);
    // hf and ollama are no longer direct providers — models are browsed via API routes
    // but invocation goes through claude or opencode
    expect(providersBody.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'opencode' }),
      ])
    );
    const providerIds = providersBody.providers.map(p => p.id);
    expect(providerIds).not.toContain('hf');
    expect(providerIds).not.toContain('ollama');

    const base = `http://127.0.0.1:${port}/api/hf/ready-models`;
    await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
        routingPolicy: 'fastest',
        supportsTools: true,
      }),
    });
    await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: 'Qwen/Qwen2.5-Coder-32B-Instruct',
        runtime: 'opencode',
        routingPolicy: 'fastest',
        supportsTools: true,
      }),
    });

    const modelsResp = await fetch(`http://127.0.0.1:${port}/api/ai/models/hf`);
    expect(modelsResp.status).toBe(200);
    const modelsBody = await modelsResp.json() as {
      success: boolean;
      provider: string;
      source: string;
      models: Array<{ id: string; runtime: string; groupLabel: string }>;
    };

    expect(modelsBody.success).toBe(true);
    expect(modelsBody.provider).toBe('hf');
    expect(modelsBody.source).toBe('ready-models');
    expect(modelsBody.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'deepseek-ai/DeepSeek-V3',
          runtime: 'claude-code',
          groupLabel: 'Claude Code (Hugging Face)',
          mappedProvider: 'claude',
        }),
        expect.objectContaining({
          id: 'huggingface/Qwen/Qwen2.5-Coder-32B-Instruct',
          runtime: 'opencode',
          groupLabel: 'OpenCode (Hugging Face)',
          mappedProvider: 'opencode',
        }),
      ])
    );

    const { db, close } = openGlobalDatabase();
    try {
      db.prepare(
        `INSERT INTO ollama_paired_models (model_name, runtime, endpoint, supports_tools, available, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('deepseek-coder-v2:33b', 'claude-code', 'http://localhost:11434', 1, 1, Date.now());
      db.prepare(
        `INSERT INTO ollama_paired_models (model_name, runtime, endpoint, supports_tools, available, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('qwen2.5-coder:32b', 'opencode', 'http://localhost:11434', 1, 1, Date.now() - 1);
    } finally {
      close();
    }

    const ollamaModelsResp = await fetch(`http://127.0.0.1:${port}/api/ai/models/ollama`);
    expect(ollamaModelsResp.status).toBe(200);
    const ollamaModelsBody = await ollamaModelsResp.json() as {
      success: boolean;
      provider: string;
      source: string;
      models: Array<{ id: string; runtime: string; groupLabel: string }>;
    };

    expect(ollamaModelsBody.success).toBe(true);
    expect(ollamaModelsBody.provider).toBe('ollama');
    expect(ollamaModelsBody.source).toBe('ready-models');
    expect(ollamaModelsBody.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'deepseek-coder-v2:33b',
          runtime: 'claude-code',
          groupLabel: 'Claude Code (Ollama)',
          mappedProvider: 'claude',
        }),
        expect.objectContaining({
          id: 'ollama/qwen2.5-coder:32b',
          runtime: 'opencode',
          groupLabel: 'OpenCode (Ollama)',
          mappedProvider: 'opencode',
        }),
      ])
    );
  });

  it('creates, updates, lists, and deletes ready-to-use model pairings', async () => {
    const base = `http://127.0.0.1:${port}/api/hf/ready-models`;

    const createResp = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
        routingPolicy: 'fastest',
        supportsTools: true,
      }),
    });
    expect(createResp.status).toBe(200);

    const listResp = await fetch(base);
    expect(listResp.status).toBe(200);
    const listed = await listResp.json() as {
      models: Array<{
        modelId: string;
        runtime: string;
        routingPolicy: string;
        supportsTools: boolean;
        routingPolicyOptions?: string[];
        contextLength?: number;
      }>;
    };
    expect(listed.models).toHaveLength(1);
    expect(listed.models[0]).toMatchObject({
      modelId: 'deepseek-ai/DeepSeek-V3',
      runtime: 'claude-code',
      routingPolicy: 'fastest',
      supportsTools: true,
    });
    expect(listed.models[0].routingPolicyOptions).toEqual(
      expect.arrayContaining(['fastest', 'cheapest', 'preferred', 'groq', 'novita'])
    );
    expect(listed.models[0].contextLength).toBe(131072);

    const updateResp = await fetch(base, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
        routingPolicy: 'cheapest',
      }),
    });
    expect(updateResp.status).toBe(200);

    const relistResp = await fetch(base);
    const relisted = await relistResp.json() as {
      models: Array<{ routingPolicy: string }>;
    };
    expect(relisted.models[0].routingPolicy).toBe('cheapest');

    const runtimeResp = await fetch(`${base}/runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
        nextRuntime: 'opencode',
      }),
    });
    expect(runtimeResp.status).toBe(200);

    const afterRuntimeResp = await fetch(base);
    const afterRuntime = await afterRuntimeResp.json() as {
      models: Array<{ runtime: string }>;
    };
    expect(afterRuntime.models[0].runtime).toBe('opencode');

    const deleteResp = await fetch(base, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'opencode',
      }),
    });
    expect(deleteResp.status).toBe(200);

    const emptyResp = await fetch(base);
    const emptyBody = await emptyResp.json() as { models: unknown[] };
    expect(emptyBody.models).toHaveLength(0);
  });

  it('returns usage dashboard data from hf_usage table', async () => {
    const { db, close } = openGlobalDatabase();
    try {
      db.prepare(
        `INSERT INTO hf_usage (
          model, provider, routing_policy, role, prompt_tokens, completion_tokens, estimated_cost_usd, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'deepseek-ai/DeepSeek-V3',
        'novita',
        'cheapest',
        'coder',
        700,
        300,
        0.015,
        Date.now()
      );

      db.prepare(
        `INSERT INTO hf_usage (
          model, provider, routing_policy, role, prompt_tokens, completion_tokens, estimated_cost_usd, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'Qwen/Qwen2.5-Coder-32B-Instruct',
        null,
        'fastest',
        'reviewer',
        200,
        100,
        0.01,
        Date.now()
      );
    } finally {
      close();
    }

    const resp = await fetch(`http://127.0.0.1:${port}/api/hf/usage`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      today: { requests: number; totalTokens: number; estimatedCostUsd: number };
      byModel7d: Array<{ model: string; requests: number; totalTokens: number }>;
    };

    expect(body.today.requests).toBe(2);
    expect(body.today.totalTokens).toBe(1300);
    expect(body.today.estimatedCostUsd).toBeCloseTo(0.025, 8);
    expect(body.byModel7d).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: 'deepseek-ai/DeepSeek-V3',
          requests: 1,
          totalTokens: 1000,
        }),
        expect.objectContaining({
          model: 'Qwen/Qwen2.5-Coder-32B-Instruct',
          requests: 1,
          totalTokens: 300,
        }),
      ])
    );
  });
});
