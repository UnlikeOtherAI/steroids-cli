import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { openGlobalDatabase } from '../src/runners/global-db-connection.js';
import { runScan } from '../src/monitor/scanner.js';

function createTempDir(prefix: string): string {
  const dir = join(
    tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('monitor scanner', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(() => {
    homeDir = createTempDir('steroids-scanner-home');
    process.env.STEROIDS_HOME = homeDir;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.STEROIDS_HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('reports unresolved abandoned global runner rows even without enabled projects', async () => {
    const { db, close } = openGlobalDatabase();
    try {
      db.prepare(
        `INSERT INTO runners (id, status, pid, project_path, current_task_id, heartbeat_at, parallel_session_id)
         VALUES (?, 'idle', ?, ?, NULL, datetime('now', '-1 day'), ?)`
      ).run('runner-unresolved', 424242, '/tmp/parallel-project', 'session-1');
    } finally {
      close();
    }

    const result = await runScan();
    const anomaly = result.anomalies.find((entry) => entry.runnerId === 'runner-unresolved');

    expect(result.projectCount).toBe(0);
    expect(anomaly).toEqual(expect.objectContaining({
      type: 'dead_runner',
      severity: 'critical',
      projectPath: '/tmp/parallel-project',
      projectName: 'Unresolved Runner',
      runnerId: 'runner-unresolved',
      context: expect.objectContaining({
        rawProjectPath: '/tmp/parallel-project',
        projectResolved: false,
      }),
    }));
  });
});
