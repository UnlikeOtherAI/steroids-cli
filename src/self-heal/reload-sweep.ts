import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { openDatabase } from '../database/connection.js';
import { recoverStuckTasks } from '../health/stuck-task-recovery.js';
import { cleanupAbandonedRunners } from '../runners/abandoned-runners.js';
import { openGlobalDatabase } from '../runners/global-db-connection.js';
import { getRegisteredProjects } from '../runners/projects.js';

export type ReloadSelfHealSource = 'runners_page' | 'task_page' | 'project_tasks_page';

export interface ReloadSelfHealOptions {
  source: ReloadSelfHealSource;
  projectPath?: string;
}

export interface ReloadSelfHealProjectResult {
  projectPath: string;
  recoveredActions: number;
  skippedRecoveryDueToSafetyLimit: boolean;
  error?: string;
}

export interface ReloadSelfHealResult {
  cleanedRunnerCount: number;
  projects: ReloadSelfHealProjectResult[];
}

export interface ReloadSelfHealScheduleResult {
  scheduled: boolean;
  reason: 'scheduled' | 'already_running' | 'cooldown';
}

export const RELOAD_SELF_HEAL_COOLDOWN_MS = 5_000;

let activeSweep: Promise<ReloadSelfHealResult> | null = null;
let lastCompletedAt = 0;

function projectDbExists(projectPath: string): boolean {
  return existsSync(join(projectPath, '.steroids', 'steroids.db'));
}

function resolveProjectPaths(projectPath?: string): string[] {
  if (!projectPath) {
    return getRegisteredProjects(false).map((project) => project.path);
  }

  const registeredProjects = getRegisteredProjects(false);
  const isEnabled = registeredProjects.some((project) => project.path === projectPath);
  return isEnabled ? [projectPath] : [];
}

async function recoverProject(globalDb: any, projectPath: string): Promise<ReloadSelfHealProjectResult> {
  if (!existsSync(projectPath) || !projectDbExists(projectPath)) {
    return {
      projectPath,
      recoveredActions: 0,
      skippedRecoveryDueToSafetyLimit: false,
    };
  }

  try {
    const config = loadConfig(projectPath);
    const { db: projectDb, close } = openDatabase(projectPath);
    try {
      const recovery = await recoverStuckTasks({
        projectPath,
        projectDb,
        globalDb,
        config,
        dryRun: false,
      });
      return {
        projectPath,
        recoveredActions: recovery.actions.length,
        skippedRecoveryDueToSafetyLimit: recovery.skippedDueToSafetyLimit,
      };
    } finally {
      close();
    }
  } catch (error) {
    return {
      projectPath,
      recoveredActions: 0,
      skippedRecoveryDueToSafetyLimit: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runReloadSelfHealNow(
  options: ReloadSelfHealOptions,
): Promise<ReloadSelfHealResult> {
  const { db: globalDb, close } = openGlobalDatabase();
  try {
    const cleanupResults = cleanupAbandonedRunners(globalDb, {
      dryRun: false,
      log: () => {},
    });
    const cleanedRunnerCount = cleanupResults.reduce(
      (count, result) => count + (result.staleRunners ?? 0),
      0,
    );

    const projects: ReloadSelfHealProjectResult[] = [];
    for (const projectPath of resolveProjectPaths(options.projectPath)) {
      projects.push(await recoverProject(globalDb, projectPath));
    }

    return {
      cleanedRunnerCount,
      projects,
    };
  } finally {
    close();
  }
}

export function scheduleReloadSelfHeal(
  options: ReloadSelfHealOptions,
): ReloadSelfHealScheduleResult {
  if (activeSweep) {
    return { scheduled: false, reason: 'already_running' };
  }

  if (Date.now() - lastCompletedAt < RELOAD_SELF_HEAL_COOLDOWN_MS) {
    return { scheduled: false, reason: 'cooldown' };
  }

  activeSweep = runReloadSelfHealNow(options)
    .catch(() => ({
      cleanedRunnerCount: 0,
      projects: [],
    }))
    .finally(() => {
      lastCompletedAt = Date.now();
      activeSweep = null;
    });

  return { scheduled: true, reason: 'scheduled' };
}

export function resetReloadSelfHealStateForTests(): void {
  activeSweep = null;
  lastCompletedAt = 0;
}
