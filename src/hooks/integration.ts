/**
 * Hook Integration
 *
 * Helper functions to trigger hooks from CLI commands.
 * Loads and merges global/project hooks, then executes them.
 */

import { basename } from 'node:path';
import { loadConfigFile, getProjectConfigPath, getGlobalConfigPath } from '../config/loader.js';
import { mergeHooks, type HookConfig } from './merge.js';
import { HookOrchestrator, type HookExecutionResult } from './orchestrator.js';
import type { HookEvent } from './events.js';
import type { HookPayload, TaskData, ProjectContext, SectionData, IntakeData } from './payload.js';
import {
  createTaskCreatedPayload,
  createTaskUpdatedPayload,
  createTaskCompletedPayload,
  createTaskFailedPayload,
  createIntakeReceivedPayload,
  createIntakeTriagedPayload,
  createIntakePRCreatedPayload,
  createSectionCompletedPayload,
  createProjectCompletedPayload,
  createCreditExhaustedPayload,
  createCreditResolvedPayload,
  type TaskSummary,
  type ProjectSummary,
  type CreditData,
} from './payload.js';
import type { Task } from '../database/queries.js';
import type { StoredIntakeReport } from '../database/intake-queries.js';

/**
 * Load and merge hooks from global and project configs
 */
async function loadHooks(projectPath: string): Promise<HookConfig[]> {
  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = getProjectConfigPath(projectPath);

  let globalHooks: HookConfig[] = [];
  let projectHooks: HookConfig[] = [];

  try {
    const globalConfig = loadConfigFile(globalConfigPath);
    globalHooks = (globalConfig.hooks as HookConfig[]) || [];
  } catch {
    // Global config might not exist
  }

  try {
    const projectConfig = loadConfigFile(projectConfigPath);
    projectHooks = (projectConfig.hooks as HookConfig[]) || [];
  } catch {
    // Project config might not exist
  }

  return mergeHooks(globalHooks, projectHooks);
}

/**
 * Get project context for current directory
 */
function getProjectContext(projectPath?: string): ProjectContext {
  const path = projectPath || process.cwd();
  return {
    name: basename(path),
    path,
  };
}

/**
 * Convert database task to payload task data
 */
function taskToPayloadData(task: Task): TaskData {
  return {
    id: task.id,
    title: task.title,
    status: task.status as TaskData['status'],
    section: null, // Task interface doesn't have section_name
    sectionId: task.section_id || null,
    sourceFile: task.source_file || null,
    rejectionCount: task.rejection_count || 0,
  };
}

/**
 * Convert stored intake report to payload intake data
 */
function intakeReportToPayloadData(
  report: StoredIntakeReport,
  overrides: Pick<IntakeData, 'linkedTaskId' | 'prNumber'> = {}
): IntakeData {
  return {
    source: report.source,
    externalId: report.externalId,
    url: report.url,
    fingerprint: report.fingerprint,
    title: report.title,
    summary: report.summary,
    severity: report.severity,
    status: report.status,
    linkedTaskId: Object.prototype.hasOwnProperty.call(overrides, 'linkedTaskId')
      ? overrides.linkedTaskId
      : report.linkedTaskId,
    prNumber: overrides.prNumber,
  };
}

/**
 * Execute hooks for an event
 */
async function executeHooks(
  event: HookEvent,
  payload: HookPayload,
  options: { verbose?: boolean; continueOnError?: boolean } = {}
): Promise<HookExecutionResult[]> {
  const hooks = await loadHooks(payload.project.path);

  const orchestrator = new HookOrchestrator(hooks, {
    verbose: options.verbose ?? false,
    continueOnError: options.continueOnError ?? true,
  });

  return await orchestrator.executeHooksForEvent(event, payload);
}

/**
 * Trigger task.created hooks
 */
export async function triggerTaskCreated(
  task: Task,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const taskData = taskToPayloadData(task);
  const payload = createTaskCreatedPayload(taskData, project);

  return await executeHooks('task.created', payload, options);
}

/**
 * Trigger task.updated hooks
 */
export async function triggerTaskUpdated(
  task: Task,
  previousStatus?: string,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const taskData = taskToPayloadData(task);

  if (previousStatus) {
    taskData.previousStatus = previousStatus as TaskData['status'];
  }

  const payload = createTaskUpdatedPayload(taskData, project);

  return await executeHooks('task.updated', payload, options);
}

/**
 * Trigger task.completed hooks
 */
export async function triggerTaskCompleted(
  task: Task,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const taskData = taskToPayloadData(task);
  const payload = createTaskCompletedPayload(taskData, project);

  return await executeHooks('task.completed', payload, options);
}

/**
 * Trigger task.failed hooks
 */
export async function triggerTaskFailed(
  task: Task,
  maxRejections: number,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const taskData = taskToPayloadData(task);
  const payload = createTaskFailedPayload(taskData, project, maxRejections);

  return await executeHooks('task.failed', payload, options);
}

/**
 * Trigger intake.received hooks
 */
export async function triggerIntakeReceived(
  report: StoredIntakeReport,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const intake = intakeReportToPayloadData(report);
  const payload = createIntakeReceivedPayload(intake, project);

  return await executeHooks('intake.received', payload, options);
}

/**
 * Trigger intake.triaged hooks
 */
export async function triggerIntakeTriaged(
  report: StoredIntakeReport,
  linkedTaskId: string | null,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const intake = intakeReportToPayloadData(report, { linkedTaskId, prNumber: undefined });
  const payload = createIntakeTriagedPayload(intake, project);

  return await executeHooks('intake.triaged', payload, options);
}

/**
 * Trigger intake.pr_created hooks
 */
export async function triggerIntakePRCreated(
  report: StoredIntakeReport,
  prNumber: number,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const intake = intakeReportToPayloadData(report, {
    linkedTaskId: report.linkedTaskId,
    prNumber,
  });
  const payload = createIntakePRCreatedPayload(intake, project);

  return await executeHooks('intake.pr_created', payload, options);
}

/**
 * Trigger section.completed hooks
 */
export async function triggerSectionCompleted(
  section: SectionData,
  tasks: TaskSummary[],
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const payload = createSectionCompletedPayload(section, tasks, project);

  return await executeHooks('section.completed', payload, options);
}

/**
 * Trigger project.completed hooks
 */
export async function triggerProjectCompleted(
  summary: ProjectSummary,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const payload = createProjectCompletedPayload(project, summary);

  return await executeHooks('project.completed', payload, options);
}

/**
 * Trigger credit.exhausted hooks
 */
export async function triggerCreditExhausted(
  credit: CreditData,
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const payload = createCreditExhaustedPayload(credit, project);

  return await executeHooks('credit.exhausted', payload, options);
}

/**
 * Trigger credit.resolved hooks
 */
export async function triggerCreditResolved(
  credit: CreditData,
  resolution: 'config_changed',
  options: { verbose?: boolean; projectPath?: string } = {}
): Promise<HookExecutionResult[]> {
  const project = getProjectContext(options.projectPath);
  const payload = createCreditResolvedPayload(credit, project, resolution);

  return await executeHooks('credit.resolved', payload, options);
}

/**
 * Check if hooks should be skipped
 *
 * Checks environment variable and CLI flags
 */
export function shouldSkipHooks(flags?: { noHooks?: boolean }): boolean {
  // Check flag
  if (flags?.noHooks) {
    return true;
  }

  // Check environment variable
  const envVar = process.env.STEROIDS_NO_HOOKS;
  if (envVar && (envVar === '1' || envVar.toLowerCase() === 'true')) {
    return true;
  }

  return false;
}

/**
 * Silently trigger hooks (don't throw on failure)
 *
 * Logs errors but doesn't block the main operation
 */
export async function triggerHooksSafely(
  triggerFn: () => Promise<HookExecutionResult[]>,
  options: { verbose?: boolean } = {}
): Promise<void> {
  try {
    const results = await triggerFn();

    // Log failures if verbose
    if (options.verbose) {
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        console.error(`Warning: ${failed.length} hook(s) failed:`);
        for (const result of failed) {
          console.error(`  - ${result.hookName}: ${result.error}`);
        }
      }
    }
  } catch (error) {
    // Silently fail - don't block main operation
    if (options.verbose) {
      console.error(`Warning: Hook execution failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
