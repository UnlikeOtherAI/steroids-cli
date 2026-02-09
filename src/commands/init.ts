/**
 * steroids init - Initialize steroids in current directory
 */

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { initDatabase, isInitialized, getDbPath } from '../database/connection.js';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { colors, markers } from '../cli/colors.js';
import { registerProject } from '../runners/projects.js';
import { generateHelp } from '../cli/help.js';
import { runAISetup } from '../config/ai-setup.js';

const HELP = generateHelp({
  command: 'init',
  description: 'Initialize Steroids in current directory',
  details: `Sets up Steroids task management system in the current directory.
Creates a .steroids directory with SQLite database for task tracking.
Projects are only registered globally if inside a git repository.
This prevents test/temporary directories from polluting the global registry.`,
  usage: ['steroids init [options]'],
  options: [
    { short: 'y', long: 'yes', description: 'Accept all defaults without prompts (skips AI setup wizard)' },
    { long: 'no-register', description: 'Skip global project registration' },
    { long: 'skip-ai-setup', description: 'Skip AI provider configuration wizard' },
  ],
  examples: [
    { command: 'steroids init', description: 'Initialize in current directory' },
    { command: 'steroids init --yes', description: 'Initialize with defaults' },
    { command: 'steroids init --no-register', description: 'Initialize without global registration' },
    { command: 'steroids init --dry-run', description: 'Preview initialization' },
  ],
  related: [
    { command: 'steroids sections add', description: 'Add task sections after init' },
    { command: 'steroids tasks add', description: 'Add tasks after init' },
    { command: 'steroids loop', description: 'Start automation after setup' },
  ],
  sections: [
    {
      title: 'CREATES',
      content: `.steroids/steroids.db    SQLite database with task schema
Registers project in global registry at ~/.steroids/steroids.db (if in git repo)`,
    },
  ],
});

/**
 * Try to extract project name from package.json if it exists
 * @param cwd - Current working directory
 * @returns Project name or null if not found
 */
function getProjectName(cwd: string): string | null {
  try {
    const packageJsonPath = join(cwd, 'package.json');
    if (existsSync(packageJsonPath)) {
      const content = readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);
      return pkg.name || null;
    }
  } catch {
    // Ignore errors - package.json might not exist or be invalid
  }
  return null;
}

/**
 * Check if the directory is inside a git repository
 * @param cwd - Current working directory
 * @returns true if inside a git repo
 */
function isInsideGitRepo(cwd: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export async function initCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'init', flags });

  const { values } = parseArgs({
    args,
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      'no-register': { type: 'boolean', default: false },
      'skip-ai-setup': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    out.log(HELP);
    return;
  }

  const cwd = process.cwd();
  const dbPath = getDbPath(cwd);

  if (isInitialized(cwd)) {
    if (flags.json) {
      out.success({
        message: 'Already initialized',
        database: dbPath,
        alreadyInitialized: true,
      });
    } else {
      out.log(markers.info('Steroids already initialized in this directory.'));
      out.log(`Database: ${colors.cyan(dbPath)}`);
    }
    return;
  }

  out.verbose('Initializing Steroids...');

  if (flags.dryRun) {
    if (flags.json) {
      out.success({
        message: 'Dry run: Would initialize Steroids',
        database: dbPath,
        dryRun: true,
      });
    } else {
      out.log(colors.yellow('Dry run: Would initialize Steroids'));
      out.log(`Database would be created at: ${dbPath}`);
    }
    return;
  }

  const { close } = initDatabase(cwd);
  close();

  // Register project in global registry (only if in a git repo and not --no-register)
  const noRegister = values['no-register'];
  const inGitRepo = isInsideGitRepo(cwd);

  if (noRegister) {
    out.verbose('Skipping global registration (--no-register flag)');
  } else if (!inGitRepo) {
    out.verbose('Skipping global registration (not inside a git repository)');
  } else {
    const projectName = getProjectName(cwd);
    try {
      registerProject(cwd, projectName || undefined);
      out.verbose(`Registered project globally${projectName ? ` as "${projectName}"` : ''}`);
    } catch (error) {
      // Don't fail init if registration fails - just log it
      out.verbose(`Warning: Failed to register project globally: ${error}`);
    }
  }

  // Run AI setup wizard (unless --yes or --skip-ai-setup is used, or JSON output)
  const skipAISetup = values.yes || values['skip-ai-setup'] || flags.json;

  if (!skipAISetup) {
    out.log('');
    out.log(markers.info('AI Provider Configuration'));
    out.log('Configure AI providers for orchestrator, coder, and reviewer roles.');
    out.log(`${colors.dim('(You can skip this and configure later with "steroids config ai")')}`);
    out.log('');

    try {
      // Run wizard for coder role first (most important)
      await runAISetup({ role: 'coder', global: true });

      // Ask if user wants to configure other roles
      out.log('');
      out.log(`${colors.dim('Tip: Run "steroids config ai" to configure other roles (orchestrator, reviewer)')}`);
    } catch (error) {
      // AI setup failed or was cancelled - don't fail init
      out.verbose(`AI setup skipped or cancelled: ${error}`);
    }
  }

  if (flags.json) {
    out.success({
      message: 'Initialized successfully',
      database: dbPath,
      nextSteps: [
        'steroids config ai',
        'steroids sections add "Phase 1"',
        'steroids tasks add "My first task" --section "Phase 1"',
        'steroids loop',
      ],
    });
  } else {
    out.log('');
    out.log(markers.success('Steroids initialized successfully!'));
    out.log(`Database: ${colors.cyan(dbPath)}`);
    out.log('');
    out.log(colors.bold('Next steps:'));
    if (skipAISetup) {
      out.log(`  ${colors.dim('$')} steroids config ai  ${colors.dim('# Configure AI providers')}`);
    }
    out.log(`  ${colors.dim('$')} steroids sections add "Phase 1"`);
    out.log(`  ${colors.dim('$')} steroids tasks add "My first task" --section "Phase 1"`);
    out.log(`  ${colors.dim('$')} steroids loop`);
  }
}
