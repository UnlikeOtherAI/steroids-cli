// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockApplyApprovedOutcome = jest.fn().mockImplementation(async (db, task, outcome) => {
  if (outcome.kind === 'complete') {
    db.prepare(
      `UPDATE tasks
       SET status = 'completed',
           rejection_count = 0,
           failure_count = 0,
           merge_failure_count = 0,
           merge_phase = NULL,
           approved_sha = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(task.id);
    return;
  }

  db.prepare(
    `UPDATE tasks
     SET status = 'merge_pending',
         merge_phase = 'queued',
         approved_sha = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(outcome.approvedSha, task.id);
});
const mockDeriveApprovedOutcome = jest.fn();
const mockLoadSubmissionContext = jest.fn();
const mockResolveApprovalSafety = jest.fn();
const mockHandleUnsafeApprovalSubmission = jest.fn().mockImplementation((db, task) => {
  db.prepare(`UPDATE tasks SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`).run(task.id);
  return { ok: false };
});
const mockLoadConfig = jest.fn().mockReturnValue({ git: { branch: 'main' } });

jest.unstable_mockModule('../src/orchestrator/reviewer-approval-outcome.js', () => ({
  applyApprovedOutcome: mockApplyApprovedOutcome,
  deriveApprovedOutcome: mockDeriveApprovedOutcome,
}));

jest.unstable_mockModule('../src/orchestrator/submission-context.js', () => ({
  loadSubmissionContext: mockLoadSubmissionContext,
  resolveApprovalSafety: mockResolveApprovalSafety,
  handleUnsafeApprovalSubmission: mockHandleUnsafeApprovalSubmission,
}));

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
  loadConfigFile: jest.fn(),
  getProjectConfigPath: jest.fn().mockReturnValue('/project/.steroids.yml'),
  getGlobalConfigPath: jest.fn().mockReturnValue('/global/.steroids.yml'),
  mergeConfigs: jest.fn(),
  applyEnvOverrides: jest.fn(),
  pruneConfigToSchema: jest.fn(),
  saveConfig: jest.fn(),
  getConfigValue: jest.fn(),
  setConfigValue: jest.fn(),
  DEFAULT_CONFIG: {},
}));

const { recoverOrphanedInvocation } = await import('../src/runners/wakeup-sanitise-recovery.js');

function createProjectDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      auto_pr INTEGER DEFAULT 0,
      branch TEXT,
      pr_number INTEGER,
      pr_labels TEXT,
      pr_draft INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      section_id TEXT,
      source_file TEXT,
      rejection_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      merge_failure_count INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      merge_phase TEXT,
      approved_sha TEXT,
      rebase_attempts INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT DEFAULT 'human',
      model TEXT,
      category TEXT,
      error_code TEXT,
      metadata TEXT,
      notes TEXT,
      commit_sha TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_invocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      runner_id TEXT,
      role TEXT NOT NULL,
      status TEXT,
      success INTEGER DEFAULT 0,
      timed_out INTEGER DEFAULT 0,
      exit_code INTEGER DEFAULT 0,
      completed_at_ms INTEGER,
      duration_ms INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at_ms INTEGER
    );
  `);
  return db;
}

function insertReviewHistory(
  db: Database.Database,
  taskId: string,
  options: { commitSha?: string; notes?: string } = {},
): void {
  db.prepare(
    `INSERT INTO audit (task_id, from_status, to_status, actor, notes)
     VALUES (?, 'pending', 'in_progress', 'orchestrator', 'start attempt')`
  ).run(taskId);
  db.prepare(
    `INSERT INTO audit (task_id, from_status, to_status, actor, notes, commit_sha)
     VALUES (?, 'in_progress', 'review', 'orchestrator', ?, ?)`
  ).run(taskId, options.notes ?? 'submission', options.commitSha ?? null);
}

function createProjectDir(logBody: string): string {
  const projectPath = mkdtempSync(join(tmpdir(), 'steroids-sanitise-recovery-'));
  mkdirSync(join(projectPath, '.steroids', 'invocations'), { recursive: true });
  writeFileSync(join(projectPath, '.steroids', 'invocations', '1.log'), logBody);
  return projectPath;
}

describe('recoverOrphanedInvocation', () => {
  let db: Database.Database;
  let projectPath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    db = createProjectDb();
    mockLoadSubmissionContext.mockReturnValue({
      isNoOp: false,
      latestReviewNotes: 'submission',
      approvalCandidateShas: ['scoped-sha'],
    });
    mockResolveApprovalSafety.mockReturnValue({ ok: true, approvalSha: 'scoped-sha' });
    mockDeriveApprovedOutcome.mockImplementation((context, approvalSafety) =>
      context.isNoOp
        ? { kind: 'complete', commitSha: approvalSafety.approvalSha }
        : { kind: 'queue_merge', approvedSha: approvalSafety.approvalSha }
    );
  });

  afterEach(() => {
    db.close();
    if (projectPath) {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it('restores approved_sha from the scoped submission chain for recovered approve decisions', async () => {
    projectPath = createProjectDir('DECISION: APPROVE');
    db.prepare(
      `INSERT INTO tasks (id, title, status, section_id, source_file, merge_phase, approved_sha)
       VALUES (?, ?, 'review', ?, ?, NULL, NULL)`
    ).run('t1', 'Task 1', 'section-1', 'docs/spec.md');
    insertReviewHistory(db, 't1', { commitSha: 'scoped-sha', notes: 'normal submission' });
    db.prepare(
      `INSERT INTO task_invocations (id, task_id, role, status, started_at_ms)
       VALUES (1, ?, 'reviewer', 'running', ?)`
    ).run('t1', Date.now() - 1000);

    const summary = {
      ran: true,
      reason: 'ok',
      recoveredApprovals: 0,
      recoveredRejects: 0,
      closedStaleInvocations: 0,
      releasedTaskLocks: 0,
      releasedSectionLocks: 0,
      recoveredDisputedTasks: 0,
      recoveredFailedTasks: 0,
    };

    await recoverOrphanedInvocation(
      db,
      projectPath,
      {
        id: 1,
        task_id: 't1',
        role: 'reviewer',
        started_at_ms: Date.now() - 1000,
        runner_id: null,
        task_status: 'review',
      },
      false,
      summary,
      'test',
    );

    const task = db.prepare('SELECT status, merge_phase, approved_sha FROM tasks WHERE id = ?').get('t1') as any;
    expect(task.status).toBe('merge_pending');
    expect(task.merge_phase).toBe('queued');
    expect(task.approved_sha).toBe('scoped-sha');
    expect(mockApplyApprovedOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 't1' }),
      { kind: 'queue_merge', approvedSha: 'scoped-sha' },
      expect.any(Object),
    );
    expect(summary.recoveredApprovals).toBe(1);
  });

  it('preserves no-op approvals by completing directly and running automated effects', async () => {
    projectPath = createProjectDir('DECISION: APPROVE');
    db.prepare(
      `INSERT INTO tasks (id, title, status, section_id, source_file, rejection_count, failure_count, merge_failure_count)
       VALUES (?, ?, 'review', ?, ?, 2, 1, 3)`
    ).run('t1', 'Task 1', 'section-1', 'docs/spec.md');
    insertReviewHistory(db, 't1', {
      commitSha: 'noop-sha',
      notes: '[NO_OP_SUBMISSION] No new commits in pool workspace — reviewer to verify pre-existing work',
    });
    mockLoadSubmissionContext.mockReturnValue({
      isNoOp: true,
      latestReviewNotes: '[NO_OP_SUBMISSION]',
      approvalCandidateShas: ['noop-sha'],
    });
    mockResolveApprovalSafety.mockReturnValue({ ok: true, approvalSha: 'noop-sha' });
    db.prepare(
      `INSERT INTO task_invocations (id, task_id, role, status, started_at_ms)
       VALUES (1, ?, 'reviewer', 'running', ?)`
    ).run('t1', Date.now() - 1000);

    const summary = {
      ran: true,
      reason: 'ok',
      recoveredApprovals: 0,
      recoveredRejects: 0,
      closedStaleInvocations: 0,
      releasedTaskLocks: 0,
      releasedSectionLocks: 0,
      recoveredDisputedTasks: 0,
      recoveredFailedTasks: 0,
    };

    await recoverOrphanedInvocation(
      db,
      projectPath,
      {
        id: 1,
        task_id: 't1',
        role: 'reviewer',
        started_at_ms: Date.now() - 1000,
        runner_id: null,
        task_status: 'review',
      },
      false,
      summary,
      'test',
    );

    const task = db.prepare('SELECT status, rejection_count, failure_count, merge_failure_count FROM tasks WHERE id = ?').get('t1') as any;
    expect(task.status).toBe('completed');
    expect(task.rejection_count).toBe(0);
    expect(task.failure_count).toBe(0);
    expect(task.merge_failure_count).toBe(0);
    expect(mockApplyApprovedOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 't1', section_id: 'section-1' }),
      { kind: 'complete', commitSha: 'noop-sha' },
      expect.objectContaining({ projectPath, intakeProjectPath: projectPath }),
    );
    expect(summary.recoveredApprovals).toBe(1);
  });

  it('fails closed when no scoped submission SHA exists', async () => {
    projectPath = createProjectDir('DECISION: APPROVE');
    db.prepare(
      `INSERT INTO tasks (id, title, status, section_id, source_file)
       VALUES (?, ?, 'review', ?, ?)`
    ).run('t1', 'Task 1', 'section-1', 'docs/spec.md');
    db.prepare(
      `INSERT INTO task_invocations (id, task_id, role, status, started_at_ms)
       VALUES (1, ?, 'reviewer', 'running', ?)`
    ).run('t1', Date.now() - 1000);
    mockResolveApprovalSafety.mockReturnValue({
      ok: false,
      reason: 'missing_latest_submission',
      attempts: [],
    });

    const summary = {
      ran: true,
      reason: 'ok',
      recoveredApprovals: 0,
      recoveredRejects: 0,
      closedStaleInvocations: 0,
      releasedTaskLocks: 0,
      releasedSectionLocks: 0,
      recoveredDisputedTasks: 0,
      recoveredFailedTasks: 0,
    };

    await recoverOrphanedInvocation(
      db,
      projectPath,
      {
        id: 1,
        task_id: 't1',
        role: 'reviewer',
        started_at_ms: Date.now() - 1000,
        runner_id: null,
        task_status: 'review',
      },
      false,
      summary,
      'test',
    );

    const task = db.prepare('SELECT status, merge_phase, approved_sha FROM tasks WHERE id = ?').get('t1') as any;
    expect(task.status).toBe('in_progress');
    expect(task.merge_phase).toBeNull();
    expect(task.approved_sha).toBeNull();
    expect(mockApplyApprovedOutcome).not.toHaveBeenCalled();
    expect(mockHandleUnsafeApprovalSubmission).toHaveBeenCalled();
  });
});
