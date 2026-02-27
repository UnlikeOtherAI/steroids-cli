import { afterEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';

import { GLOBAL_SCHEMA_V19_SQL } from '../src/runners/global-db-schema.js';
import { claimSlot, partialReleaseSlot } from '../src/workspace/pool.js';
import type { PoolSlot } from '../src/workspace/types.js';

const openDbs: Database.Database[] = [];

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA_V19_SQL);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    db?.close();
  }
});

describe('workspace pool slot claiming affinity', () => {
  it('reclaims the same slot after partial release for the same task ID', () => {
    const db = makeDb();
    const projectId = 'project-1';
    const taskId = 'task-1';

    const first = claimSlot(db, projectId, 'runner-1', taskId);
    partialReleaseSlot(db, first.id);

    const reclaimed = claimSlot(db, projectId, 'runner-2', taskId);

    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.task_id).toBe(taskId);
    expect(reclaimed.runner_id).toBe('runner-2');
    expect(reclaimed.status).toBe('coder_active');
  });

  it('keeps two task-specific idle slots isolated by task ID affinity', () => {
    const db = makeDb();
    const projectId = 'project-2';
    const taskA = 'task-a';
    const taskB = 'task-b';

    const slotA = claimSlot(db, projectId, 'runner-1', taskA);
    const slotB = claimSlot(db, projectId, 'runner-2', taskB);
    partialReleaseSlot(db, slotA.id);
    partialReleaseSlot(db, slotB.id);

    const reclaimedA = claimSlot(db, projectId, 'runner-3', taskA);
    partialReleaseSlot(db, reclaimedA.id);
    const reclaimedB = claimSlot(db, projectId, 'runner-4', taskB);

    expect(reclaimedA.id).toBe(slotA.id);
    expect(reclaimedB.id).toBe(slotB.id);
  });

  it('falls back to FIFO by slot ID when there is no matching task affinity', () => {
    const db = makeDb();
    const projectId = 'project-3';

    const first = claimSlot(db, projectId, 'runner-1', 'task-a');
    const second = claimSlot(db, projectId, 'runner-2', 'task-b');
    partialReleaseSlot(db, first.id);
    partialReleaseSlot(db, second.id);

    const claimed = claimSlot(db, projectId, 'runner-3', 'task-fresh');

    expect(claimed.id).toBe(first.id);
  });

  it('uses the task-affine idle selection in the UNIQUE-retry path', () => {
    const projectId = 'project-4';
    const runnerId = 'runner-4';
    const taskId = 'task-sticky';
    const stickySlot: PoolSlot = {
      id: 41,
      project_id: projectId,
      slot_index: 2,
      slot_path: '',
      remote_url: null,
      runner_id: null,
      task_id: taskId,
      base_branch: null,
      task_branch: null,
      starting_sha: null,
      status: 'idle',
      claimed_at: null,
      heartbeat_at: null,
    };

    let idleSelectCalls = 0;
    let updateArgs: unknown[] = [];

    const fakeDb = {
      transaction<T>(fn: () => T) {
        return { immediate: () => fn() };
      },
      prepare(sql: string) {
        const normalized = sql.replace(/\s+/g, ' ').trim();

        if (
          normalized.startsWith('SELECT * FROM workspace_pool_slots') &&
          normalized.includes("WHERE project_id = ? AND status = 'idle'")
        ) {
          return {
            get: (...args: unknown[]) => {
              expect(args).toEqual([projectId, taskId]);
              idleSelectCalls += 1;
              return idleSelectCalls === 1 ? undefined : stickySlot;
            },
          };
        }

        if (normalized.startsWith('SELECT MAX(slot_index) as max_idx')) {
          return { get: () => ({ max_idx: 0 }) };
        }

        if (normalized.startsWith('INSERT INTO workspace_pool_slots')) {
          return {
            run: () => {
              throw new Error('UNIQUE constraint failed: workspace_pool_slots.project_id, workspace_pool_slots.slot_index');
            },
          };
        }

        if (normalized.startsWith('UPDATE workspace_pool_slots')) {
          return {
            run: (...args: unknown[]) => {
              updateArgs = args;
            },
          };
        }

        if (normalized === 'SELECT * FROM workspace_pool_slots WHERE id = ?') {
          return {
            get: (slotId: number) => ({
              ...stickySlot,
              id: slotId,
              runner_id: runnerId,
              task_id: taskId,
              status: 'coder_active' as const,
            }),
          };
        }

        if (normalized.startsWith('SELECT id FROM workspace_pool_slots')) {
          return { get: () => ({ id: 999 }) };
        }

        throw new Error(`Unexpected SQL in fake db: ${normalized}`);
      },
    } as unknown as Database.Database;

    const claimed = claimSlot(fakeDb, projectId, runnerId, taskId);

    expect(idleSelectCalls).toBe(2);
    expect(updateArgs[0]).toBe(runnerId);
    expect(updateArgs[1]).toBe(taskId);
    expect(updateArgs[4]).toBe(stickySlot.id);
    expect(claimed.id).toBe(stickySlot.id);
    expect(claimed.task_id).toBe(taskId);
  });
});
