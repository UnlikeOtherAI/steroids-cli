/**
 * Workspace pool manager — DB-backed slot claiming, release, and clone management.
 *
 * Pool slots live in the global database (`workspace_pool_slots`).
 * Each slot is a full git clone at `~/.steroids/workspaces/<projectHash>/pool-<index>/`.
 */

import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { PoolSlot, SlotStatus } from './types.js';
import { isShallowRepository, execGit } from './git-helpers.js';
import {
  getProjectHash,
  getDefaultWorkspaceRoot,
  ensureWorkspaceSteroidsSymlink,
} from '../parallel/clone.js';

/**
 * Resolve the remote URL for a project.
 * Returns null for local-only projects (no remote or local filesystem path).
 */
export function resolveRemoteUrl(projectPath: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!url) return null;

    // If it's a local filesystem path (not https://, ssh://, git@), treat as local-only
    if (url.startsWith('/') || url.startsWith('.') || url.startsWith('~')) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

/**
 * Build the slot path for a given project and index.
 */
function buildSlotPath(projectPath: string, slotIndex: number): string {
  const workspaceRoot = getDefaultWorkspaceRoot();
  const projectHash = getProjectHash(projectPath);
  return join(workspaceRoot, projectHash, `pool-${slotIndex}`);
}

/**
 * Claim a pool slot for a task. Creates a new slot if none are idle.
 * Uses BEGIN IMMEDIATE for serialised access.
 */
export function claimSlot(
  globalDb: Database.Database,
  projectId: string,
  runnerId: string,
  taskId: string
): PoolSlot {
  const now = Date.now();

  const claim = globalDb.transaction(() => {
    // Try to find an idle slot
    let slot = globalDb
      .prepare(
        `SELECT * FROM workspace_pool_slots
         WHERE project_id = ? AND status = 'idle'
         LIMIT 1`
      )
      .get(projectId) as PoolSlot | undefined;

    if (slot) {
      globalDb
        .prepare(
          `UPDATE workspace_pool_slots
           SET runner_id = ?, task_id = ?, status = 'coder_active',
               claimed_at = ?, heartbeat_at = ?
           WHERE id = ?`
        )
        .run(runnerId, taskId, now, now, slot.id);

      return globalDb
        .prepare('SELECT * FROM workspace_pool_slots WHERE id = ?')
        .get(slot.id) as PoolSlot;
    }

    // No idle slot — create a new one
    const maxIndex = globalDb
      .prepare(
        'SELECT MAX(slot_index) as max_idx FROM workspace_pool_slots WHERE project_id = ?'
      )
      .get(projectId) as { max_idx: number | null } | undefined;

    const nextIndex = (maxIndex?.max_idx ?? -1) + 1;

    try {
      globalDb
        .prepare(
          `INSERT INTO workspace_pool_slots
           (project_id, slot_index, slot_path, runner_id, task_id, status, claimed_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?, 'coder_active', ?, ?)`
        )
        .run(
          projectId,
          nextIndex,
          '', // slot_path set after we know the project path
          runnerId,
          taskId,
          now,
          now
        );
    } catch (error: any) {
      if (error.message?.includes('UNIQUE constraint')) {
        // Race condition: another runner created a slot — retry idle search
        slot = globalDb
          .prepare(
            `SELECT * FROM workspace_pool_slots
             WHERE project_id = ? AND status = 'idle'
             LIMIT 1`
          )
          .get(projectId) as PoolSlot | undefined;

        if (slot) {
          globalDb
            .prepare(
              `UPDATE workspace_pool_slots
               SET runner_id = ?, task_id = ?, status = 'coder_active',
                   claimed_at = ?, heartbeat_at = ?
               WHERE id = ?`
            )
            .run(runnerId, taskId, now, now, slot.id);

          return globalDb
            .prepare('SELECT * FROM workspace_pool_slots WHERE id = ?')
            .get(slot.id) as PoolSlot;
        }
      }
      throw error;
    }

    const newSlotId = globalDb
      .prepare(
        `SELECT id FROM workspace_pool_slots
         WHERE project_id = ? AND slot_index = ?`
      )
      .get(projectId, nextIndex) as { id: number };

    return globalDb
      .prepare('SELECT * FROM workspace_pool_slots WHERE id = ?')
      .get(newSlotId.id) as PoolSlot;
  });

  return claim.immediate();
}

/**
 * Finalize the slot path and remote_url after claiming. Call once after claimSlot()
 * when you know the projectPath.
 */
export function finalizeSlotPath(
  globalDb: Database.Database,
  slotId: number,
  projectPath: string,
  remoteUrl: string | null
): PoolSlot {
  const slotPath = buildSlotPath(projectPath, getSlot(globalDb, slotId)!.slot_index);

  globalDb
    .prepare(
      `UPDATE workspace_pool_slots
       SET slot_path = ?, remote_url = ?
       WHERE id = ?`
    )
    .run(slotPath, remoteUrl, slotId);

  return globalDb
    .prepare('SELECT * FROM workspace_pool_slots WHERE id = ?')
    .get(slotId) as PoolSlot;
}

/**
 * Release a slot back to idle, clearing task fields.
 */
export function releaseSlot(globalDb: Database.Database, slotId: number): void {
  globalDb
    .prepare(
      `UPDATE workspace_pool_slots
       SET status = 'idle', runner_id = NULL, task_id = NULL,
           task_branch = NULL, starting_sha = NULL,
           claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ?`
    )
    .run(slotId);
}

/**
 * Partially release a slot back to idle, preserving workspace fields
 * (task_branch, base_branch, starting_sha) so the reviewer phase can pick
 * them up in the next loop iteration without needing to re-run prepareForTask.
 *
 * Only clears runner-tracking fields (runner_id, claimed_at, heartbeat_at).
 */
export function partialReleaseSlot(globalDb: Database.Database, slotId: number): void {
  globalDb
    .prepare(
      `UPDATE workspace_pool_slots
       SET status = 'idle', runner_id = NULL,
           claimed_at = NULL, heartbeat_at = NULL
       WHERE id = ?`
    )
    .run(slotId);
}

/**
 * Update slot status and optional fields.
 */
export function updateSlotStatus(
  globalDb: Database.Database,
  slotId: number,
  status: SlotStatus,
  fields?: Partial<Pick<PoolSlot, 'task_id' | 'task_branch' | 'base_branch' | 'starting_sha'>>
): void {
  const sets = ['status = ?'];
  const params: unknown[] = [status];

  if (fields?.task_id !== undefined) { sets.push('task_id = ?'); params.push(fields.task_id); }
  if (fields?.task_branch !== undefined) { sets.push('task_branch = ?'); params.push(fields.task_branch); }
  if (fields?.base_branch !== undefined) { sets.push('base_branch = ?'); params.push(fields.base_branch); }
  if (fields?.starting_sha !== undefined) { sets.push('starting_sha = ?'); params.push(fields.starting_sha); }

  params.push(slotId);

  globalDb
    .prepare(`UPDATE workspace_pool_slots SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
}

/**
 * Refresh the heartbeat timestamp for a slot.
 */
export function refreshSlotHeartbeat(globalDb: Database.Database, slotId: number): void {
  globalDb
    .prepare('UPDATE workspace_pool_slots SET heartbeat_at = ? WHERE id = ?')
    .run(Date.now(), slotId);
}

/**
 * Get a single slot by ID.
 */
export function getSlot(globalDb: Database.Database, slotId: number): PoolSlot | null {
  return (
    (globalDb
      .prepare('SELECT * FROM workspace_pool_slots WHERE id = ?')
      .get(slotId) as PoolSlot | undefined) ?? null
  );
}

/**
 * List all slots for a project.
 */
export function listProjectSlots(globalDb: Database.Database, projectId: string): PoolSlot[] {
  return globalDb
    .prepare('SELECT * FROM workspace_pool_slots WHERE project_id = ? ORDER BY slot_index')
    .all(projectId) as PoolSlot[];
}

/**
 * Ensure the slot directory exists as a full clone.
 * - If missing: full clone from remoteUrl (or projectPath for local-only).
 * - If shallow: `git fetch --unshallow`.
 * - Always ensure .steroids symlink.
 */
export function ensureSlotClone(
  slot: PoolSlot,
  remoteUrl: string | null,
  projectPath: string
): void {
  const slotPath = slot.slot_path;

  if (!existsSync(slotPath) || !existsSync(join(slotPath, '.git'))) {
    // Remove any partial directory
    if (existsSync(slotPath)) {
      rmSync(slotPath, { recursive: true, force: true });
    }

    // Create parent directories
    mkdirSync(resolve(slotPath, '..'), { recursive: true });

    // Full clone — no --depth, no --single-branch
    const cloneSource = remoteUrl ?? projectPath;
    execFileSync('git', ['clone', '--no-tags', cloneSource, slotPath], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000, // 5 min for large repos
    });
  }

  // If shallow, unshallow it
  if (isShallowRepository(slotPath)) {
    execGit(slotPath, ['fetch', '--unshallow'], { timeoutMs: 300_000 });
  }

  // Ensure .steroids symlink points to the source project
  ensureWorkspaceSteroidsSymlink(slotPath, projectPath);
}
