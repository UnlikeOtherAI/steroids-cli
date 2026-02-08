/**
 * steroids hooks - Manage event hooks
 */

import { parseArgs } from 'node:util';
import type { GlobalFlags } from '../cli/flags.js';
import { outputJson, outputJsonError } from '../cli/output.js';
import { ErrorCode, getExitCode } from '../cli/errors.js';
import { generateHelp } from '../cli/help.js';
import { loadConfigFile, getProjectConfigPath, getGlobalConfigPath } from '../config/loader.js';
import {
  HOOK_EVENTS,
  EVENT_DESCRIPTIONS,
  isValidHookEvent,
  type HookEvent,
} from '../hooks/events.js';
import {
  mergeHooks,
  filterHooksByEvent,
  type HookConfig,
} from '../hooks/merge.js';
import { HookOrchestrator } from '../hooks/orchestrator.js';
import {
  createTaskCompletedPayload,
  type TaskData,
  type ProjectContext,
} from '../hooks/payload.js';
import { basename } from 'node:path';

const HELP = generateHelp({
  command: 'hooks',
  description: 'Manage event hooks for automation',
  details: `Hooks trigger scripts or webhooks when events occur.
Configure hooks in config.yaml (both global ~/.steroids/config.yaml and project .steroids/config.yaml).
Project hooks can override or disable global hooks by name.`,
  usage: [
    'steroids hooks [options]',
    'steroids hooks <subcommand> [args] [options]',
  ],
  subcommands: [
    { name: 'list', description: 'List all hooks (merged from global and project)' },
    { name: 'validate', description: 'Validate hook configuration' },
    { name: 'test', args: '<event>', description: 'Test hooks for an event (dry run)' },
    { name: 'run', args: '<event>', description: 'Manually trigger hooks for an event' },
  ],
  options: [
    { short: 'e', long: 'event', description: 'Filter hooks by event', values: '<event>' },
    { long: 'global', description: 'Show only global hooks (~/.steroids/config.yaml)' },
    { long: 'project', description: 'Show only project hooks (.steroids/config.yaml)' },
    { short: 't', long: 'type', description: 'Filter by hook type', values: 'script | webhook' },
    { short: 'v', long: 'verbose', description: 'Show detailed execution output' },
  ],
  examples: [
    { command: 'steroids hooks list', description: 'List all hooks (global + project merged)' },
    { command: 'steroids hooks list --event task.completed', description: 'Show hooks for task completion' },
    { command: 'steroids hooks validate', description: 'Validate all hook configurations' },
    { command: 'steroids hooks test task.completed', description: 'Test task completion hooks' },
    { command: 'steroids hooks run project.completed', description: 'Manually trigger project completion hooks' },
  ],
  related: [
    { command: 'steroids config browse', description: 'Edit hook configuration' },
    { command: 'steroids tasks', description: 'Task commands that trigger hooks' },
  ],
  sections: [
    {
      title: 'HOOK EVENTS',
      content: Object.entries(EVENT_DESCRIPTIONS)
        .map(([event, desc]) => `${event.padEnd(20)} ${desc}`)
        .join('\n'),
    },
  ],
});

export async function hooksCommand(args: string[], flags: GlobalFlags): Promise<void> {
  if (flags.help || args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const subcommand = args[0];

  try {
    switch (subcommand) {
      case 'list':
        await listHooks(args.slice(1), flags);
        break;
      case 'validate':
        await validateHooks(args.slice(1), flags);
        break;
      case 'test':
        await testHooks(args.slice(1), flags);
        break;
      case 'run':
        await runHooks(args.slice(1), flags);
        break;
      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        console.error('Run "steroids hooks --help" for usage');
        process.exit(getExitCode(ErrorCode.INVALID_ARGUMENTS));
    }
  } catch (error) {
    if (flags.json) {
      outputJsonError(
        'hooks',
        subcommand,
        ErrorCode.INTERNAL_ERROR,
        error instanceof Error ? error.message : String(error)
      );
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(getExitCode(ErrorCode.INTERNAL_ERROR));
  }
}

async function listHooks(args: string[], flags: GlobalFlags): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      event: { type: 'string', short: 'e' },
      global: { type: 'boolean' },
      project: { type: 'boolean' },
      type: { type: 'string', short: 't' },
    },
    allowPositionals: false,
  });

  const projectPath = process.cwd();
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

  let hooksToShow: HookConfig[];
  if (parsed.values.global) {
    hooksToShow = globalHooks;
  } else if (parsed.values.project) {
    hooksToShow = projectHooks;
  } else {
    hooksToShow = mergeHooks(globalHooks, projectHooks);
  }

  if (parsed.values.event) {
    const event = parsed.values.event;
    if (!isValidHookEvent(event)) {
      throw new Error(`Invalid event: ${event}`);
    }
    hooksToShow = filterHooksByEvent(hooksToShow, event as HookEvent);
  }

  if (parsed.values.type) {
    const type = parsed.values.type;
    if (type !== 'script' && type !== 'webhook') {
      throw new Error(`Invalid type: ${type}. Must be 'script' or 'webhook'`);
    }
    hooksToShow = hooksToShow.filter((h) => h.type === type);
  }

  if (flags.json) {
    outputJson('hooks', 'list', {
      hooks: hooksToShow,
      total: hooksToShow.length,
    });
    return;
  }

  if (hooksToShow.length === 0) {
    console.log('No hooks configured');
    return;
  }

  console.log(`\nHooks (${parsed.values.global ? 'Global' : parsed.values.project ? 'Project' : 'Merged'})`);
  console.log('─'.repeat(80));

  for (const hook of hooksToShow) {
    const enabled = hook.enabled !== false ? '✓' : '✗';
    console.log(`${enabled} ${hook.name}`);
    console.log(`  Event:  ${hook.event}`);
    console.log(`  Type:   ${hook.type}`);
    console.log('');
  }

  console.log(`Total: ${hooksToShow.length} hook(s)`);
}

async function validateHooks(args: string[], flags: GlobalFlags): Promise<void> {
  const projectPath = process.cwd();
  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = getProjectConfigPath(projectPath);

  let globalHooks: HookConfig[] = [];
  let projectHooks: HookConfig[] = [];

  try {
    const globalConfig = loadConfigFile(globalConfigPath);
    globalHooks = (globalConfig.hooks as HookConfig[]) || [];
  } catch {
    // Ignore
  }

  try {
    const projectConfig = loadConfigFile(projectConfigPath);
    projectHooks = (projectConfig.hooks as HookConfig[]) || [];
  } catch {
    // Ignore
  }

  const mergedHooks = mergeHooks(globalHooks, projectHooks);
  const orchestrator = new HookOrchestrator(mergedHooks);
  const results = orchestrator.validateAllHooks();

  const invalid = results.filter((r) => !r.valid);

  if (flags.json) {
    outputJson('hooks', 'validate', {
      valid: invalid.length === 0,
      total: results.length,
      invalid: invalid.length,
      results,
    });
    return;
  }

  if (invalid.length === 0) {
    console.log(`✓ All ${results.length} hook(s) are valid`);
  } else {
    console.error(`✗ ${invalid.length} invalid hook(s) found:`);
    for (const result of invalid) {
      console.error(`  ${result.hook}:`);
      for (const error of result.errors) {
        console.error(`    - ${error}`);
      }
    }
    process.exit(getExitCode(ErrorCode.VALIDATION_ERROR));
  }
}

async function testHooks(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.length === 0) {
    throw new Error('Event name required. Usage: steroids hooks test <event>');
  }

  const event = args[0];
  if (!isValidHookEvent(event)) {
    throw new Error(`Invalid event: ${event}`);
  }

  const projectPath = process.cwd();
  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = getProjectConfigPath(projectPath);

  let globalHooks: HookConfig[] = [];
  let projectHooks: HookConfig[] = [];

  try {
    const globalConfig = loadConfigFile(globalConfigPath);
    globalHooks = (globalConfig.hooks as HookConfig[]) || [];
  } catch {
    // Ignore
  }

  try {
    const projectConfig = loadConfigFile(projectConfigPath);
    projectHooks = (projectConfig.hooks as HookConfig[]) || [];
  } catch {
    // Ignore
  }

  const mergedHooks = mergeHooks(globalHooks, projectHooks);
  const matchingHooks = filterHooksByEvent(mergedHooks, event as HookEvent);

  if (flags.json) {
    outputJson('hooks', 'test', {
      event,
      hooks: matchingHooks,
      count: matchingHooks.length,
    });
    return;
  }

  console.log(`\nTest hooks for event: ${event}`);
  console.log('(Dry run - hooks will not be executed)\n');

  if (matchingHooks.length === 0) {
    console.log('No hooks configured for this event');
    return;
  }

  for (const hook of matchingHooks) {
    console.log(`✓ ${hook.name} (${hook.type})`);
  }

  console.log(`\n${matchingHooks.length} hook(s) would be triggered`);
}

async function runHooks(args: string[], flags: GlobalFlags): Promise<void> {
  if (args.length === 0) {
    throw new Error('Event name required. Usage: steroids hooks run <event>');
  }

  const event = args[0];
  if (!isValidHookEvent(event)) {
    throw new Error(`Invalid event: ${event}`);
  }

  const projectPath = process.cwd();
  const projectName = basename(projectPath);
  const globalConfigPath = getGlobalConfigPath();
  const projectConfigPath = getProjectConfigPath(projectPath);

  let globalHooks: HookConfig[] = [];
  let projectHooks: HookConfig[] = [];

  try {
    const globalConfig = loadConfigFile(globalConfigPath);
    globalHooks = (globalConfig.hooks as HookConfig[]) || [];
  } catch {
    // Ignore
  }

  try {
    const projectConfig = loadConfigFile(projectConfigPath);
    projectHooks = (projectConfig.hooks as HookConfig[]) || [];
  } catch {
    // Ignore
  }

  const mergedHooks = mergeHooks(globalHooks, projectHooks);
  const orchestrator = new HookOrchestrator(mergedHooks, {
    verbose: flags.verbose,
    continueOnError: true,
  });

  const project: ProjectContext = {
    name: projectName,
    path: projectPath,
  };

  const task: TaskData = {
    id: 'manual-trigger',
    title: 'Manual hook trigger',
    status: 'completed',
  };

  const payload = createTaskCompletedPayload(task, project);
  const results = await orchestrator.executeHooksForEvent(event as HookEvent, payload);

  if (flags.json) {
    outputJson('hooks', 'run', {
      event,
      results,
      success: results.every((r) => r.success),
    });
    return;
  }

  console.log(`\nRunning hooks for event: ${event}\n`);

  if (results.length === 0) {
    console.log('No hooks configured for this event');
    return;
  }

  for (const result of results) {
    const status = result.success ? '✓' : '✗';
    console.log(`${status} ${result.hookName} (${result.duration}ms)`);
    if (result.error) {
      console.error(`  Error: ${result.error}`);
    }
  }

  const failed = results.filter((r) => !r.success).length;
  if (failed > 0) {
    process.exit(getExitCode(ErrorCode.HOOK_FAILED));
  }
}
