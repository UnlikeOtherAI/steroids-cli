/**
 * Workspace pool types — mirrors the workspace_pool_slots DB table.
 */

import type Database from 'better-sqlite3';

export type SlotStatus =
  | 'idle'
  | 'coder_active'
  | 'awaiting_review'
  | 'review_active'
  | 'merging';

export interface PoolSlot {
  id: number;
  project_id: string;
  slot_index: number;
  slot_path: string;
  remote_url: string | null;
  runner_id: string | null;
  task_id: string | null;
  base_branch: string | null;
  task_branch: string | null;
  starting_sha: string | null;
  status: SlotStatus;
  claimed_at: number | null;
  heartbeat_at: number | null;
}

export interface PoolSlotContext {
  globalDb: Database.Database;
  slot: PoolSlot;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  localOnly: boolean;
}
