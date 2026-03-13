import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createApp } from '../API/src/index.js';
import { initDatabase } from '../src/database/connection.js';
import { getIntakeReport, upsertIntakePollState, upsertIntakeReport } from '../src/database/intake-queries.js';
import type { IntakeReport } from '../src/intake/types.js';

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

function createReport(
  externalId: string,
  overrides: Partial<IntakeReport> = {}
): IntakeReport {
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
    updatedAt: `2026-03-12T09:${externalId.padStart(2, '0')}:00.000Z`,
    tags: ['bug'],
    payload: { externalId },
    ...overrides,
  };
}

describe('API intake endpoints', () => {
  const originalHome = process.env.HOME;
  const originalNodeEnv = process.env.NODE_ENV;
  let homeDir: string;
  let projectPath: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    homeDir = createTempDir('steroids-home-intake');
    process.env.HOME = homeDir;
    process.env.STEROIDS_HOME = homeDir;
    projectPath = createTempDir('steroids-project-intake');

    const { db, close } = initDatabase(projectPath);
    try {
      db.prepare(
        `INSERT INTO tasks (id, title, status, created_at, updated_at, failure_count)
         VALUES (?, ?, ?, datetime('now'), datetime('now'), 0)`
      ).run('task-1', 'Linked bug fix task', 'in_progress');

      upsertIntakeReport(db, createReport('1', { severity: 'critical', status: 'triaged' }), {
        linkedTaskId: 'task-1',
      });
      upsertIntakeReport(db, createReport('2', { severity: 'high', status: 'open' }));
      upsertIntakeReport(db, createReport('3', { severity: 'low', status: 'resolved', resolvedAt: '2026-03-12T10:00:00.000Z' }));
      upsertIntakePollState(db, {
        source: 'github',
        cursor: '2',
        lastPolledAt: '2026-03-12T11:00:00.000Z',
        lastSuccessAt: '2026-03-12T11:00:00.000Z',
      });
      upsertIntakePollState(db, {
        source: 'sentry',
        lastPolledAt: '2026-03-12T11:05:00.000Z',
        lastErrorAt: '2026-03-12T11:05:00.000Z',
        lastErrorMessage: 'Sentry connector unavailable',
      });
    } finally {
      close();
    }

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
        '      labels:',
        '        - bug',
        '    sentry:',
        '      enabled: true',
        '      baseUrl: https://sentry.io',
        '      organization: acme',
        '      project: widgets',
        '      authTokenEnvVar: SENTRY_AUTH_TOKEN',
      ].join('\n')
    );

    server = http.createServer(createApp());
    port = await listen(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.HOME = originalHome;
    process.env.NODE_ENV = originalNodeEnv;
    delete process.env.STEROIDS_HOME;
    await rm(projectPath, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('lists intake reports with filters and returns individual report detail', async () => {
    const listResp = await fetch(
      `http://127.0.0.1:${port}/api/intake/reports?project=${encodeURIComponent(projectPath)}&status=open&limit=10`
    );
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as any;
    expect(listBody.success).toBe(true);
    expect(listBody.total).toBe(1);
    expect(listBody.reports[0].externalId).toBe('2');

    const detailResp = await fetch(
      `http://127.0.0.1:${port}/api/intake/reports/github/1?project=${encodeURIComponent(projectPath)}`
    );
    expect(detailResp.status).toBe(200);
    const detailBody = (await detailResp.json()) as any;
    expect(detailBody.report.externalId).toBe('1');
    expect(detailBody.report.linkedTaskId).toBe('task-1');
  });

  it('supports create, patch, and delete for intake reports', async () => {
    const createResp = await fetch(`http://127.0.0.1:${port}/api/intake/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: projectPath,
        report: createReport('9', { status: 'open', severity: 'info' }),
      }),
    });
    expect(createResp.status).toBe(201);
    const createBody = (await createResp.json()) as any;
    expect(createBody.created).toBe(true);
    expect(createBody.report.externalId).toBe('9');

    const patchResp = await fetch(`http://127.0.0.1:${port}/api/intake/reports/github/9`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: projectPath,
        status: 'in_progress',
        linkedTaskId: 'task-1',
        tags: ['bug', 'triaged'],
      }),
    });
    expect(patchResp.status).toBe(200);
    const patchBody = (await patchResp.json()) as any;
    expect(patchBody.report.status).toBe('in_progress');
    expect(patchBody.report.linkedTaskId).toBe('task-1');
    expect(patchBody.report.tags).toEqual(['bug', 'triaged']);
    expect(patchBody.report.updatedAt).toBe('2026-03-12T09:09:00.000Z');

    const deleteResp = await fetch(
      `http://127.0.0.1:${port}/api/intake/reports/github/9?project=${encodeURIComponent(projectPath)}`,
      { method: 'DELETE' }
    );
    expect(deleteResp.status).toBe(200);
    const deleteBody = (await deleteResp.json()) as any;
    expect(deleteBody.deleted).toBe(true);

    const { db, close } = initDatabase(projectPath);
    try {
      expect(getIntakeReport(db, 'github', '9')).toBeNull();
    } finally {
      close();
    }
  });

  it('rejects PATCH bodies with no recognized updatable fields and preserves stored state', async () => {
    const beforeResp = await fetch(
      `http://127.0.0.1:${port}/api/intake/reports/github/2?project=${encodeURIComponent(projectPath)}`
    );
    expect(beforeResp.status).toBe(200);
    const beforeBody = (await beforeResp.json()) as any;

    const patchResp = await fetch(`http://127.0.0.1:${port}/api/intake/reports/github/2`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: projectPath,
      }),
    });

    expect(patchResp.status).toBe(400);
    const patchBody = (await patchResp.json()) as any;
    expect(patchBody.success).toBe(false);
    expect(patchBody.error).toBe('Request body must contain at least one recognized updatable field');

    const afterResp = await fetch(
      `http://127.0.0.1:${port}/api/intake/reports/github/2?project=${encodeURIComponent(projectPath)}`
    );
    expect(afterResp.status).toBe(200);
    const afterBody = (await afterResp.json()) as any;
    expect(afterBody.report).toEqual(beforeBody.report);
  });

  it('returns intake stats and connector health summaries', async () => {
    const statsResp = await fetch(`http://127.0.0.1:${port}/api/intake/stats?project=${encodeURIComponent(projectPath)}`);
    expect(statsResp.status).toBe(200);
    const statsBody = (await statsResp.json()) as any;
    expect(statsBody.stats).toMatchObject({
      total: 3,
      linked: 1,
      unlinked: 2,
      bySource: { github: 3, sentry: 0 },
      byStatus: { triaged: 1, open: 1, resolved: 1 },
    });

    const healthResp = await fetch(
      `http://127.0.0.1:${port}/api/intake/connectors/health?project=${encodeURIComponent(projectPath)}`
    );
    expect(healthResp.status).toBe(200);
    const healthBody = (await healthResp.json()) as any;
    expect(healthBody.intakeEnabled).toBe(true);
    expect(healthBody.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'github',
          enabled: true,
          status: 'healthy',
          stats: expect.objectContaining({ totalReports: 3, linkedReports: 1 }),
        }),
        expect.objectContaining({
          source: 'sentry',
          enabled: true,
          status: 'unsupported',
        }),
      ])
    );
  });
});
