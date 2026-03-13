import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../API/src/index.js';
import { initDatabase } from '../src/database/connection.js';
import { getIntakeReport } from '../src/database/intake-queries.js';
import type { IntakeReport } from '../src/intake/types.js';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unexpected server address'));
        return;
      }

      resolve(address.port);
    });
  });
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

function createReport(externalId: string, overrides: Partial<IntakeReport> = {}): IntakeReport {
  return {
    source: 'github',
    externalId,
    url: `https://github.com/acme/widgets/issues/${externalId}`,
    fingerprint: `github:acme/widgets#${externalId}`,
    title: `Issue ${externalId}`,
    summary: `Summary ${externalId}`,
    severity: 'medium',
    status: 'open',
    createdAt: '2026-03-12T09:00:00.000Z',
    updatedAt: '2026-03-12T09:01:00.000Z',
    tags: ['bug'],
    payload: { externalId },
    ...overrides,
  };
}

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('intake webhook endpoint', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

  let homeDir: string;
  let projectPath: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_WEBHOOK_SECRET = 'top-secret';
    homeDir = createTempDir('steroids-home-webhook');
    projectPath = createTempDir('steroids-project-webhook');
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;

    const { close } = initDatabase(projectPath);
    close();

    writeFileSync(
      join(projectPath, '.steroids', 'config.yaml'),
      [
        'intake:',
        '  enabled: true',
        '  connectors:',
        '    github:',
        '      enabled: true',
        '      apiBaseUrl: https://api.github.com',
        '      owner: acme',
        '      repo: widgets',
        '      tokenEnvVar: GITHUB_TOKEN',
      ].join('\n')
    );

    server = http.createServer(createApp());
    port = await listen(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.GITHUB_WEBHOOK_SECRET = originalWebhookSecret;
    delete process.env.STEROIDS_HOME;
    await rm(projectPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('accepts a valid signed webhook and persists the normalized report', async () => {
    const payload = {
      project: projectPath,
      report: createReport('41'),
    };
    const body = JSON.stringify(payload);

    const response = await fetch(`http://127.0.0.1:${port}/webhooks/intake/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signBody('top-secret', body),
      },
      body,
    });

    expect(response.status).toBe(201);
    const responseBody = (await response.json()) as any;
    expect(responseBody.success).toBe(true);
    expect(responseBody.created).toBe(true);
    expect(responseBody.report.externalId).toBe('41');

    const { db, close } = initDatabase(projectPath);
    try {
      expect(getIntakeReport(db, 'github', '41')).toEqual(
        expect.objectContaining({
          externalId: '41',
          source: 'github',
          title: 'Issue 41',
        })
      );
    } finally {
      close();
    }
  });

  it('rejects webhook requests with an invalid signature', async () => {
    const body = JSON.stringify({
      project: projectPath,
      report: createReport('42'),
    });

    const response = await fetch(`http://127.0.0.1:${port}/webhooks/intake/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signBody('wrong-secret', body),
      },
      body,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid webhook signature',
    });
  });

  it('rejects webhook requests when the report source does not match the connector', async () => {
    const body = JSON.stringify({
      project: projectPath,
      report: createReport('43', { source: 'sentry' }),
    });

    const response = await fetch(`http://127.0.0.1:${port}/webhooks/intake/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signBody('top-secret', body),
      },
      body,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Webhook report source mismatch: expected github, got sentry',
    });
  });

  it('returns 503 when the connector secret env var is not set', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;

    const body = JSON.stringify({
      project: projectPath,
      report: createReport('44'),
    });

    const response = await fetch(`http://127.0.0.1:${port}/webhooks/intake/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signBody('top-secret', body),
      },
      body,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Intake webhook secret env var is empty or missing: GITHUB_WEBHOOK_SECRET',
    });
  });
});
