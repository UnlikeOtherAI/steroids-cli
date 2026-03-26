import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let currentDb: Database.Database;

const mockOpenGlobalDatabase = jest.fn(() => ({
  db: currentDb,
  close: jest.fn(),
}));
const mockRunFirstResponder = jest.fn<any>();
const mockRunMonitorCycle = jest.fn<any>().mockResolvedValue({ outcome: 'clean', anomalyCount: 0 });

jest.unstable_mockModule('../src/runners/global-db-connection.js', () => ({
  openGlobalDatabase: mockOpenGlobalDatabase,
}));

jest.unstable_mockModule('../src/monitor/investigator-agent.js', () => ({
  runFirstResponder: mockRunFirstResponder,
}));

jest.unstable_mockModule('../src/monitor/loop.js', () => ({
  runMonitorCycle: mockRunMonitorCycle,
}));

const { runRespondCmd } = await import('../src/commands/monitor-respond.js');

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

  db.prepare(
    `INSERT INTO monitor_runs (
      started_at, completed_at, outcome, scan_results, escalation_reason, first_responder_needed
    ) VALUES (?, NULL, 'anomalies_found', ?, 'needs attention', 0)`
  ).run(
    Date.now(),
    JSON.stringify({
      timestamp: Date.now(),
      projectCount: 1,
      summary: '1 anomaly',
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
    }),
  );

  return db;
}

function latestRun(): any {
  return currentDb.prepare('SELECT * FROM monitor_runs ORDER BY id DESC LIMIT 1').get();
}

describe('monitor respond command', () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(
      ((code?: string | number | null | undefined) => {
        throw new Error(`process.exit(${code})`);
      }) as (code?: string | number | null | undefined) => never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    currentDb?.close();
  });

  it('rejects a manual investigate without explicit override when config is monitor_only', async () => {
    currentDb = createMonitorDb('monitor_only');

    await expect(runRespondCmd(['--run-id', '1'], { help: false } as any)).rejects.toThrow('process.exit(2)');

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(latestRun().error).toContain('requires an explicit override');
    expect(mockRunFirstResponder).not.toHaveBeenCalled();
  });

  it('allows an explicit triage override from monitor_only', async () => {
    currentDb = createMonitorDb('monitor_only');
    mockRunFirstResponder.mockResolvedValue({
      success: true,
      agentUsed: 'claude/sonnet',
      diagnosis: 'Diagnosed',
      actions: [{ action: 'report_only', diagnosis: 'Diagnosed' }],
      actionResults: [],
    });

    await runRespondCmd(['--run-id', '1', '--preset', 'triage_only'], { help: false } as any);

    expect(mockRunFirstResponder).toHaveBeenCalledWith(
      [{ provider: 'claude', model: 'sonnet' }],
      expect.any(Object),
      'triage_only',
      null,
    );
    expect(latestRun().outcome).toBe('first_responder_complete');
  });
});
