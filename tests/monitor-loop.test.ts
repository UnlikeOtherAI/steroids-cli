import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let currentDb: Database.Database;
let currentScanResult: any;

const mockSpawn = jest.fn<any>();
const mockResolveCliEntrypoint = jest.fn<any>();
const mockOpenGlobalDatabase = jest.fn(() => ({
  db: currentDb,
  close: jest.fn(),
}));
const mockRunScan = jest.fn(async () => currentScanResult);

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

jest.unstable_mockModule('../src/runners/global-db-connection.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
}));

jest.unstable_mockModule('../src/cli/entrypoint.js', () => ({
  resolveCliEntrypoint: mockResolveCliEntrypoint,
}));

jest.unstable_mockModule('../src/monitor/scanner.js', () => ({
  runScan: mockRunScan,
}));

const { monitorCheck, runMonitorCycle } = await import('../src/monitor/loop.js');

function createMonitorDb(responsePreset: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE monitor_config (
      id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL,
      interval_seconds INTEGER NOT NULL,
      first_responder_agents TEXT NOT NULL,
      response_preset TEXT NOT NULL,
      custom_prompt TEXT,
      escalation_rules TEXT NOT NULL,
      first_responder_timeout_seconds INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE monitor_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      outcome TEXT NOT NULL,
      scan_results TEXT,
      escalation_reason TEXT,
      first_responder_needed INTEGER DEFAULT 0,
      first_responder_agent TEXT,
      first_responder_actions TEXT,
      first_responder_report TEXT,
      action_results TEXT,
      error TEXT
    );

    CREATE TABLE monitor_remediation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      anomaly_fingerprint TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'attempted'
    );

    CREATE TABLE monitor_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      project_path TEXT,
      anomaly_fingerprint TEXT,
      message TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
  `);

  db.prepare(
    `INSERT INTO monitor_config (
      id, enabled, interval_seconds, first_responder_agents, response_preset,
      custom_prompt, escalation_rules, first_responder_timeout_seconds, updated_at
    ) VALUES (1, 1, 60, ?, ?, NULL, ?, 900, ?)`
  ).run(
    JSON.stringify([{ provider: 'claude', model: 'sonnet' }]),
    responsePreset,
    JSON.stringify({ min_severity: 'warning' }),
    Date.now(),
  );

  return db;
}

function latestRun(): any {
  return currentDb.prepare('SELECT * FROM monitor_runs ORDER BY id DESC LIMIT 1').get();
}

describe('monitor loop response-mode behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentScanResult = {
      timestamp: Date.now(),
      projectCount: 1,
      summary: '1 critical anomaly',
      anomalies: [
        {
          type: 'blocked_task',
          severity: 'critical',
          projectPath: '/tmp/project',
          projectName: 'project',
          taskId: 'task-1',
          details: 'Task blocked',
          context: {},
        },
      ],
    };
    mockSpawn.mockReturnValue({ unref: jest.fn() });
    mockResolveCliEntrypoint.mockReturnValue('/mock/entry.js');
  });

  afterEach(() => {
    currentDb?.close();
  });

  it('records anomalies without dispatching when configured as monitor_only', async () => {
    currentDb = createMonitorDb('monitor_only');

    await monitorCheck();

    const row = latestRun();
    expect(row.outcome).toBe('anomalies_found');
    expect(row.first_responder_needed).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('allows an explicit manual fix override from monitor_only', async () => {
    currentDb = createMonitorDb('monitor_only');

    const result = await runMonitorCycle({
      manual: true,
      preset: 'fix_and_monitor',
      forceDispatch: true,
    });

    const row = latestRun();
    expect(result.outcome).toBe('first_responder_dispatched');
    expect(row.outcome).toBe('first_responder_dispatched');
    expect(row.first_responder_needed).toBe(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/mock/entry.js', 'monitor', 'respond', '--run-id', String(row.id), '--preset', 'fix_and_monitor'],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('marks the run as error instead of false-dispatched when the CLI entrypoint is missing', async () => {
    currentDb = createMonitorDb('fix_and_monitor');
    mockResolveCliEntrypoint.mockReturnValue(null);

    const result = await runMonitorCycle({
      manual: true,
      forceDispatch: true,
    });

    const row = latestRun();
    expect(result.outcome).toBe('error');
    expect(result.error).toBe('CLI entrypoint not found');
    expect(row.outcome).toBe('error');
    expect(row.error).toBe('CLI entrypoint not found');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
