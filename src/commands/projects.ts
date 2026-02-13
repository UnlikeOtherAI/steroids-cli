/**
 * steroids projects - Manage global project registry
 */

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { colors, markers } from '../cli/colors.js';
import {
  getRegisteredProjects,
  registerProject,
  unregisterProject,
  enableProject,
  disableProject,
  pruneProjects,
  getRegisteredProject,
  isPathAllowed,
} from '../runners/projects.js';
import { generateHelp } from '../cli/help.js';

const HELP = generateHelp({
  command: 'projects',
  description: 'Manage global project registry',
  details: `The global project registry tracks all steroids projects on your system.
The runner wakeup system uses this registry to monitor and restart runners
for projects with pending work.

When multiple projects are registered, a warning is displayed reminding
LLM agents to only work on their own project and not modify other projects.`,
  usage: [
    'steroids projects <subcommand> [args] [options]',
  ],
  subcommands: [
    { name: 'list', description: 'List all registered projects' },
    { name: 'add', args: '[path]', description: 'Register a project (defaults to current dir)' },
    { name: 'remove', args: '[path]', description: 'Unregister a project (defaults to current dir)' },
    { name: 'enable', args: '[path]', description: 'Enable a project (defaults to current dir)' },
    { name: 'disable', args: '[path]', description: 'Disable a project (defaults to current dir)' },
    { name: 'prune', description: 'Remove projects that no longer exist' },
  ],
  options: [],
  examples: [
    { command: 'steroids projects list', description: 'List all registered projects' },
    { command: 'steroids projects add', description: 'Register current directory' },
    { command: 'steroids projects add ~/code/my-app', description: 'Register a specific project' },
    { command: 'steroids projects remove', description: 'Unregister current directory' },
    { command: 'steroids projects disable', description: 'Disable current project' },
    { command: 'steroids projects enable', description: 'Re-enable current project' },
    { command: 'steroids projects prune', description: 'Remove stale entries' },
  ],
  related: [
    { command: 'steroids runners wakeup', description: 'Check and start runners' },
    { command: 'steroids scan', description: 'Scan for projects' },
  ],
});

export async function projectsCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'projects', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      all: { type: 'boolean', short: 'a', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    out.log(HELP);
    return;
  }

  if (positionals.length === 0) {
    out.log(HELP);
    return;
  }

  const subcommand = positionals[0];

  switch (subcommand) {
    case 'list':
      await listProjects(out, values.all as boolean, flags);
      break;

    case 'add':
      await addProject(out, positionals[1] ?? process.cwd(), flags);
      break;

    case 'remove':
      await removeProject(out, positionals[1] ?? process.cwd(), flags);
      break;

    case 'enable':
      await enableProjectCmd(out, positionals[1] ?? process.cwd(), flags);
      break;

    case 'disable':
      await disableProjectCmd(out, positionals[1] ?? process.cwd(), flags);
      break;

    case 'prune':
      await pruneProjectsCmd(out, flags);
      break;

    default:
      out.error('INVALID_ARGUMENTS', `Unknown subcommand: ${subcommand}`);
      out.log('Run "steroids projects --help" for usage information.');
      process.exit(1);
  }
}

async function listProjects(
  out: ReturnType<typeof createOutput>,
  _includeDisabled: boolean,  // Ignored - always show all projects
  flags: GlobalFlags
): Promise<void> {
  // Always show all projects (disabled ones are clearly marked)
  const projects = getRegisteredProjects(true);

  if (flags.json) {
    out.success({
      projects: projects.map((p) => ({
        path: p.path,
        name: p.name,
        enabled: p.enabled,
        registered_at: p.registered_at,
        last_seen_at: p.last_seen_at,
      })),
      count: projects.length,
    });
    return;
  }

  if (projects.length === 0) {
    out.log('No registered projects.');
    out.log('');
    out.log('Run "steroids init" in a project directory to register it.');
    return;
  }

  out.log('');
  out.log(colors.bold('Registered Projects:'));
  out.log('');

  for (const project of projects) {
    const status = project.enabled ? colors.green('✓ enabled') : colors.dim('○ disabled');
    const name = project.name ? colors.cyan(project.name) : colors.dim('(unnamed)');

    out.log(`  ${status}  ${name}`);
    out.log(`     ${colors.dim(project.path)}`);
    out.log(`     ${colors.dim(`Last seen: ${formatDate(project.last_seen_at)}`)}`);
    out.log('');
  }

  out.log(colors.dim(`Total: ${projects.length} project(s)`));

  // Multi-project warning for LLMs
  if (projects.length > 1) {
    const currentProject = process.cwd();
    out.log('');
    out.log(colors.yellow('─'.repeat(70)));
    out.log(colors.yellow('⚠️  MULTI-PROJECT ENVIRONMENT'));
    out.log(colors.yellow(`   Your current project: ${currentProject}`));
    out.log(colors.yellow('   DO NOT modify files in other projects.'));
    out.log(colors.yellow('   Each runner/coder works ONLY on its own project.'));
    out.log(colors.yellow('─'.repeat(70)));
  }
}

async function addProject(
  out: ReturnType<typeof createOutput>,
  pathArg: string,
  flags: GlobalFlags
): Promise<void> {
  const projectPath = resolve(pathArg);

  // Validate project exists
  if (!existsSync(projectPath)) {
    out.error('PROJECT_NOT_FOUND', `Directory does not exist: ${projectPath}`);
    process.exit(1);
  }

  // Check if it's a steroids project
  const steroidsDbPath = `${projectPath}/.steroids/steroids.db`;
  if (!existsSync(steroidsDbPath)) {
    out.error('NOT_STEROIDS_PROJECT', `Not a steroids project: ${projectPath}`);
    out.log('');
    out.log('Run "steroids init" in that directory first.');
    process.exit(1);
  }

  if (flags.dryRun) {
    out.log(colors.yellow('Dry run: Would register project'));
    out.log(`Path: ${projectPath}`);
    return;
  }

  // Check if already registered
  const existing = getRegisteredProject(projectPath);
  if (existing) {
    if (flags.json) {
      out.success({
        message: 'Project already registered',
        path: projectPath,
        name: existing.name,
        alreadyRegistered: true,
      });
    } else {
      out.log(markers.info('Project already registered'));
      out.log(`Path: ${colors.cyan(projectPath)}`);
      if (existing.name) {
        out.log(`Name: ${colors.cyan(existing.name)}`);
      }
    }
    return;
  }

  // Check whitelist/blacklist
  const pathCheck = isPathAllowed(projectPath);
  if (!pathCheck.allowed) {
    out.error('PATH_NOT_ALLOWED', pathCheck.reason ?? 'Path not allowed by project registration rules');
    out.log('');
    out.log('Configure allowed/blocked paths in global config:');
    out.log(`  ${colors.dim('steroids config set projects.allowedPaths \'["~/Projects"]\' --global')}`);
    out.log(`  ${colors.dim('steroids config set projects.blockedPaths \'["/tmp"]\' --global')}`);
    process.exit(1);
  }

  // Register the project
  registerProject(projectPath);

  if (flags.json) {
    out.success({
      message: 'Project registered successfully',
      path: projectPath,
    });
  } else {
    out.log('');
    out.log(markers.success('Project registered successfully!'));
    out.log(`Path: ${colors.cyan(projectPath)}`);
    out.log('');
    out.log('The runner wakeup system will now monitor this project.');
  }
}

async function removeProject(
  out: ReturnType<typeof createOutput>,
  pathArg: string,
  flags: GlobalFlags
): Promise<void> {
  const projectPath = resolve(pathArg);

  // Check if project is registered
  const existing = getRegisteredProject(projectPath);
  if (!existing) {
    out.error('PROJECT_NOT_REGISTERED', `Project not registered: ${projectPath}`);
    process.exit(1);
  }

  if (flags.dryRun) {
    out.log(colors.yellow('Dry run: Would unregister project'));
    out.log(`Path: ${projectPath}`);
    return;
  }

  // Remove the project
  unregisterProject(projectPath);

  if (flags.json) {
    out.success({
      message: 'Project unregistered successfully',
      path: projectPath,
    });
  } else {
    out.log('');
    out.log(markers.success('Project unregistered successfully!'));
    out.log(`Path: ${colors.cyan(projectPath)}`);
    out.log('');
    out.log('The runner wakeup system will no longer monitor this project.');
  }
}

async function enableProjectCmd(
  out: ReturnType<typeof createOutput>,
  pathArg: string,
  flags: GlobalFlags
): Promise<void> {
  const projectPath = resolve(pathArg);

  // Check if project is registered
  const existing = getRegisteredProject(projectPath);
  if (!existing) {
    out.error('PROJECT_NOT_REGISTERED', `Project not registered: ${projectPath}`);
    out.log('');
    out.log('Run "steroids projects add <path>" to register it first.');
    process.exit(1);
  }

  if (existing.enabled) {
    if (flags.json) {
      out.success({
        message: 'Project already enabled',
        path: projectPath,
        alreadyEnabled: true,
      });
    } else {
      out.log(markers.info('Project already enabled'));
      out.log(`Path: ${colors.cyan(projectPath)}`);
    }
    return;
  }

  if (flags.dryRun) {
    out.log(colors.yellow('Dry run: Would enable project'));
    out.log(`Path: ${projectPath}`);
    return;
  }

  // Enable the project
  enableProject(projectPath);

  if (flags.json) {
    out.success({
      message: 'Project enabled successfully',
      path: projectPath,
    });
  } else {
    out.log('');
    out.log(markers.success('Project enabled successfully!'));
    out.log(`Path: ${colors.cyan(projectPath)}`);
    out.log('');
    out.log('The runner wakeup system will now monitor this project.');
  }
}

async function disableProjectCmd(
  out: ReturnType<typeof createOutput>,
  pathArg: string,
  flags: GlobalFlags
): Promise<void> {
  const projectPath = resolve(pathArg);

  // Check if project is registered
  const existing = getRegisteredProject(projectPath);
  if (!existing) {
    out.error('PROJECT_NOT_REGISTERED', `Project not registered: ${projectPath}`);
    out.log('');
    out.log('Run "steroids projects add <path>" to register it first.');
    process.exit(1);
  }

  if (!existing.enabled) {
    if (flags.json) {
      out.success({
        message: 'Project already disabled',
        path: projectPath,
        alreadyDisabled: true,
      });
    } else {
      out.log(markers.info('Project already disabled'));
      out.log(`Path: ${colors.cyan(projectPath)}`);
    }
    return;
  }

  if (flags.dryRun) {
    out.log(colors.yellow('Dry run: Would disable project'));
    out.log(`Path: ${projectPath}`);
    return;
  }

  // Disable the project
  disableProject(projectPath);

  if (flags.json) {
    out.success({
      message: 'Project disabled successfully',
      path: projectPath,
    });
  } else {
    out.log('');
    out.log(markers.success('Project disabled successfully!'));
    out.log(`Path: ${colors.cyan(projectPath)}`);
    out.log('');
    out.log('The runner wakeup system will skip this project until re-enabled.');
  }
}

async function pruneProjectsCmd(
  out: ReturnType<typeof createOutput>,
  flags: GlobalFlags
): Promise<void> {
  if (flags.dryRun) {
    out.log(colors.yellow('Dry run: Would prune stale projects'));
    return;
  }

  const removed = pruneProjects();

  if (flags.json) {
    out.success({
      message: `Pruned ${removed} project(s)`,
      removed,
    });
  } else {
    out.log('');
    if (removed === 0) {
      out.log(markers.success('No stale projects found.'));
    } else {
      out.log(markers.success(`Pruned ${removed} project(s) that no longer exist.`));
    }
  }
}

/**
 * Format a date string for display
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
}
