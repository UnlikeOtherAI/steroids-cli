import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createApp } from '../API/src/index.js';

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
      }>;
    };
    expect(listed.models).toHaveLength(1);
    expect(listed.models[0]).toMatchObject({
      modelId: 'deepseek-ai/DeepSeek-V3',
      runtime: 'claude-code',
      routingPolicy: 'fastest',
      supportsTools: true,
    });

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

    const deleteResp = await fetch(base, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelId: 'deepseek-ai/DeepSeek-V3',
        runtime: 'claude-code',
      }),
    });
    expect(deleteResp.status).toBe(200);

    const emptyResp = await fetch(base);
    const emptyBody = await emptyResp.json() as { models: unknown[] };
    expect(emptyBody.models).toHaveLength(0);
  });
});
