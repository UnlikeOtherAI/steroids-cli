/**
 * Tests for landing-verification fixes:
 *  Fix 1: clone.ts — one-hop origin resolution when seeding from prior workstream
 *  Fix 2: pool.ts — ensureSlotClone clones local but sets origin to real remote
 *  Fix 3: git-lifecycle.ts — prepareForTask self-heals poisoned slots
 */

import { afterEach, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { resolveRemoteUrl, ensureSlotClone } from '../src/workspace/pool.js';
import { createWorkspaceClone } from '../src/parallel/clone.js';
import { prepareForTask } from '../src/workspace/git-lifecycle.js';
import { mergeToBase } from '../src/workspace/git-lifecycle-merge.js';
import { GLOBAL_SCHEMA_V19_SQL } from '../src/runners/global-db-schema.js';
import type { PoolSlot } from '../src/workspace/types.js';

// ─── helpers ────────────────────────────────────────────────────────────────

const tempPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `lv-${prefix}-`));
  tempPaths.push(dir);
  return dir;
}

function gitRun(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function gitInit(dir: string): void {
  try { execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' }); } catch { /* ignore */ }
  try { execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' }); } catch { /* ignore */ }
}

function gitInitNew(dir: string, branch = 'main'): void {
  execFileSync('git', ['init', '-b', branch, dir], { stdio: 'pipe' });
  gitInit(dir);
}

function gitCommit(dir: string, message = 'initial commit'): void {
  writeFileSync(join(dir, 'README.md'), message);
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-m', message], { stdio: 'pipe' });
}

function makeSteroidsDir(projectPath: string): void {
  const d = join(projectPath, '.steroids');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'steroids.db'), '');
}

function makeGlobalDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA_V19_SQL);
  return db;
}

function makeSlot(slotPath: string, remoteUrl: string | null): PoolSlot {
  return {
    id: 1,
    project_id: 'test-project',
    slot_index: 0,
    slot_path: slotPath,
    remote_url: remoteUrl,
    runner_id: 'runner-1',
    task_id: 'task-1',
    base_branch: null,
    task_branch: null,
    starting_sha: null,
    status: 'coder_active',
    claimed_at: Date.now(),
    heartbeat_at: Date.now(),
  };
}

afterEach(() => {
  while (tempPaths.length > 0) {
    const p = tempPaths.pop()!;
    rmSync(p, { recursive: true, force: true });
  }
});

// ─── resolveRemoteUrl ────────────────────────────────────────────────────────

describe('resolveRemoteUrl', () => {
  it('returns null for a local filesystem origin', () => {
    const remote = makeTempDir('bare');
    execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'pipe' });
    const project = makeTempDir('proj-local');
    gitInitNew(project);
    gitRun(project, ['remote', 'add', 'origin', remote]);
    expect(resolveRemoteUrl(project)).toBeNull();
  });

  it('returns the URL for an https origin', () => {
    const project = makeTempDir('proj-https');
    gitInitNew(project);
    const httpsUrl = 'https://github.com/example/repo.git';
    gitRun(project, ['remote', 'add', 'origin', httpsUrl]);
    expect(resolveRemoteUrl(project)).toBe(httpsUrl);
  });

  it('returns null when there is no remote', () => {
    const project = makeTempDir('proj-no-remote');
    gitInitNew(project);
    expect(resolveRemoteUrl(project)).toBeNull();
  });
});

// ─── Fix 1: createWorkspaceClone one-hop origin resolution ──────────────────

describe('Fix 1: createWorkspaceClone one-hop origin resolution', () => {
  it('sets origin to real remote URL when seeding from a prior workstream', () => {
    const bareRemote = makeTempDir('bare-fix1');
    execFileSync('git', ['init', '--bare', '-b', 'main', bareRemote], { stdio: 'pipe' });
    // Use file:// so the origin URL is treated as "real" (not a plain filesystem path)
    const bareRemoteUrl = `file://${bareRemote}`;

    const project = makeTempDir('proj-fix1');
    execFileSync('git', ['clone', bareRemoteUrl, project], { stdio: 'pipe' });
    gitInit(project);
    gitCommit(project, 'initial');
    execFileSync('git', ['-C', project, 'push', 'origin', 'main'], { stdio: 'pipe' });
    makeSteroidsDir(project);

    // Prior workstream cloned from project — origin = local project path (the bug)
    const priorWs = makeTempDir('prior-ws-fix1');
    execFileSync('git', ['clone', project, priorWs], { stdio: 'pipe' });
    expect(gitRun(priorWs, ['remote', 'get-url', 'origin'])).toBe(project);

    const workspaceRoot = makeTempDir('ws-root-fix1');
    const result = createWorkspaceClone({
      projectPath: project,
      workstreamId: 'ws-fix1-test',
      branchName: 'steroids/fix1-test',
      workspaceRoot,
      fromPath: priorWs,
    });

    // New workspace origin must be the bare remote URL, NOT the prior workstream path
    const newOrigin = gitRun(result.workspacePath, ['remote', 'get-url', 'origin']);
    expect(newOrigin).toBe(bareRemoteUrl);
    expect(newOrigin).not.toBe(priorWs);
    expect(newOrigin).not.toBe(project);
  });

  it('falls back to projectPath origin when project has no real remote', () => {
    const project = makeTempDir('proj-fix1-local');
    gitInitNew(project);
    gitCommit(project, 'initial');
    makeSteroidsDir(project);

    const priorWs = makeTempDir('prior-ws-fix1-local');
    execFileSync('git', ['clone', project, priorWs], { stdio: 'pipe' });

    const workspaceRoot = makeTempDir('ws-root-fix1-local');
    const result = createWorkspaceClone({
      projectPath: project,
      workstreamId: 'ws-fix1-local',
      branchName: 'steroids/fix1-local',
      workspaceRoot,
      fromPath: priorWs,
    });

    // No real remote → origin falls back to projectPath
    const newOrigin = gitRun(result.workspacePath, ['remote', 'get-url', 'origin']);
    expect(newOrigin).toBe(project);
  });
});

// ─── Fix 2: ensureSlotClone origin management ────────────────────────────────

describe('Fix 2: ensureSlotClone origin management', () => {
  it('clones from local projectPath but sets origin to remoteUrl', () => {
    const project = makeTempDir('proj-fix2');
    gitInitNew(project);
    gitCommit(project, 'initial');
    makeSteroidsDir(project);

    const fakeRemote = 'https://github.com/example/repo.git';
    const slotPath = join(makeTempDir('slots-fix2'), 'slot-0');

    ensureSlotClone(makeSlot(slotPath, fakeRemote), fakeRemote, project, project);

    expect(existsSync(join(slotPath, '.git'))).toBe(true);
    expect(gitRun(slotPath, ['remote', 'get-url', 'origin'])).toBe(fakeRemote);
  });

  it('repairs existing stale clone origin to remoteUrl', () => {
    const project = makeTempDir('proj-fix2-repair');
    gitInitNew(project);
    gitCommit(project, 'initial');
    makeSteroidsDir(project);

    // Poisoned clone: origin = local project path
    const slotPath = join(makeTempDir('slots-fix2-repair'), 'slot-0');
    execFileSync('git', ['clone', project, slotPath], { stdio: 'pipe' });
    expect(gitRun(slotPath, ['remote', 'get-url', 'origin'])).toBe(project);

    const fakeRemote = 'https://github.com/example/repaired.git';
    ensureSlotClone(makeSlot(slotPath, fakeRemote), fakeRemote, project, project);

    expect(gitRun(slotPath, ['remote', 'get-url', 'origin'])).toBe(fakeRemote);
  });
});

// ─── Fix 3 + merge-to-remote integration ─────────────────────────────────────

describe('Fix 3 + merge-to-remote integration', () => {
  it('self-heals poisoned slot (remote_url=NULL) and pushes commit to bare remote', () => {
    const bareRemote = makeTempDir('bare-integration');
    execFileSync('git', ['init', '--bare', '-b', 'main', bareRemote], { stdio: 'pipe' });
    // Use file:// so the origin URL is treated as "real" (not a plain filesystem path)
    const bareRemoteUrl = `file://${bareRemote}`;

    const project = makeTempDir('proj-integration');
    execFileSync('git', ['clone', bareRemoteUrl, project], { stdio: 'pipe' });
    gitInit(project);
    gitCommit(project, 'initial project commit');
    execFileSync('git', ['-C', project, 'push', 'origin', 'main'], { stdio: 'pipe' });
    makeSteroidsDir(project);

    // Poisoned slot: clone origin = project path (local), remote_url = NULL in DB
    const slotPath = join(makeTempDir('slot-integration'), 'slot-0');
    execFileSync('git', ['clone', project, slotPath], { stdio: 'pipe' });
    gitInit(slotPath);
    expect(gitRun(slotPath, ['remote', 'get-url', 'origin'])).toBe(project);

    // DB slot has remote_url = NULL (the pre-fix state)
    const globalDb = makeGlobalDb();
    globalDb.prepare(
      `INSERT INTO workspace_pool_slots
       (project_id, slot_index, slot_path, remote_url, runner_id, task_id, status, claimed_at, heartbeat_at)
       VALUES (?, ?, ?, NULL, ?, ?, 'coder_active', ?, ?)`
    ).run('test-project', 0, slotPath, 'runner-1', 'task-1', Date.now(), Date.now());

    const slot = globalDb.prepare('SELECT * FROM workspace_pool_slots WHERE id = 1').get() as PoolSlot;
    expect(slot.remote_url).toBeNull();

    // Fix 3: prepareForTask detects poisoned state and resolves upstream remote
    // The clone's origin (project) points to a repo whose origin = bareRemote
    // Self-heal sets the slot origin to bareRemote and updates DB
    const prepResult = prepareForTask(globalDb, slot, 'task-1', project, project);
    expect(prepResult.ok).toBe(true);
    if (!prepResult.ok) return;

    // Origin must be repaired to the bare remote URL
    expect(gitRun(slotPath, ['remote', 'get-url', 'origin'])).toBe(bareRemoteUrl);

    // DB must be updated too
    const healed = globalDb.prepare('SELECT remote_url FROM workspace_pool_slots WHERE id = 1').get() as { remote_url: string | null };
    expect(healed.remote_url).toBe(bareRemoteUrl);

    // Make a feature commit on the task branch
    writeFileSync(join(slotPath, 'feature.md'), 'new feature');
    gitRun(slotPath, ['add', '-A']);
    gitRun(slotPath, ['commit', '-m', 'feat: new feature from task']);

    // mergeToBase should push to the bare remote
    const updatedSlot = globalDb.prepare('SELECT * FROM workspace_pool_slots WHERE id = 1').get() as PoolSlot;
    const mergeResult = mergeToBase(globalDb, updatedSlot, 'task-1');
    expect(mergeResult.ok).toBe(true);

    // Verify the feature commit landed in the bare remote
    const remoteLog = execFileSync(
      'git',
      ['--git-dir', bareRemote, 'log', 'main', '--oneline'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    expect(remoteLog).toContain('feat: new feature from task');
  });
});
