/**
 * steroids init - Initialize steroids in current directory
 */

import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { initDatabase, isInitialized, getDbPath } from '../database/connection.js';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { colors, markers } from '../cli/colors.js';
import { ErrorCode } from '../cli/errors.js';
import { registerProject } from '../runners/projects.js';
import { generateHelp } from '../cli/help.js';
import { runAISetup } from '../config/ai-setup.js';
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  loadConfigFile,
  saveConfig,
} from '../config/loader.js';

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

/**
 * Detect the default branch for the git repository (main, master, or other).
 * Tries in order: remote HEAD symref → probe origin/main → probe origin/master →
 * current local branch. Returns null if not in a git repo or all attempts fail.
 */
function detectDefaultBranch(cwd: string): string | null {
  // 1. Ask git for the canonical remote default via symbolic-ref
  try {
    const out = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd,
      stdio: 'pipe',
    }).toString().trim();
    // e.g. "refs/remotes/origin/main" → "main"
    const match = out.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  } catch {
    // origin/HEAD not set — common in freshly cloned or local-only repos
  }

  // 2. Probe whether origin/main or origin/master exist
  for (const candidate of ['main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', `origin/${candidate}`], {
        cwd,
        stdio: 'pipe',
      });
      return candidate;
    } catch {
      // not found, try next
    }
  }

  // 3. Fall back to the current local branch name
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: 'pipe',
    }).toString().trim();
    if (branch && branch !== 'HEAD') return branch;
  } catch {
    // detached HEAD or not a repo
  }

  return null;
}

/**
 * Return the list of remote names, or an empty array if none are configured.
 */
function getRemotes(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['remote'], { cwd, stdio: 'pipe' }).toString().trim();
    return out ? out.split('\n').map(s => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Return true if the given remote has at least one branch ref.
 */
function remoteHasBranches(cwd: string, remote: string): boolean {
  try {
    const out = execFileSync('git', ['ls-remote', '--heads', remote], { cwd, stdio: 'pipe' }).toString().trim();
    return out.length > 0;
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
      reviewers: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    out.log(HELP);
    return;
  }

  const cwd = process.cwd();
  const dbPath = getDbPath(cwd);

  // ── Git prerequisites ──────────────────────────────────────────────────────
  // Check 1: Must be inside a git repository.
  if (!isInsideGitRepo(cwd)) {
    out.error(
      ErrorCode.CONFIG_ERROR,
      'Not a git repository. Steroids requires git for task branch management.',
      { suggestion: 'git init && git add . && git commit -m "Initial commit"' },
    );
    process.exit(1);
  }

  // Check 2: If a remote is configured, it must have branches on it.
  // Local-only repos (no remote) are fine — steroids supports them.
  const remotes = getRemotes(cwd);
  if (remotes.length > 0) {
    const primary = remotes.includes('origin') ? 'origin' : remotes[0];
    if (!remoteHasBranches(cwd, primary)) {
      const localBranch = detectDefaultBranch(cwd) ?? 'main';
      out.error(
        ErrorCode.CONFIG_ERROR,
        `Remote '${primary}' exists but has no branches. Push your base branch before initializing.`,
        { suggestion: `git push -u ${primary} ${localBranch}` },
      );
      process.exit(1);
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

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

  // Auto-detect default git branch and persist to project config (only in git repos)
  if (inGitRepo) {
    const detectedBranch = detectDefaultBranch(cwd);
    if (detectedBranch) {
      try {
        const projectConfigPath = getProjectConfigPath(cwd);
        const projectConfig = loadConfigFile(projectConfigPath);
        if (!projectConfig.git?.branch) {
          if (!projectConfig.git) projectConfig.git = {};
          projectConfig.git.branch = detectedBranch;
          saveConfig(projectConfig, projectConfigPath);
          out.verbose(`Detected git base branch: ${detectedBranch}`);
        }
      } catch (error) {
        // Don't fail init if branch detection config write fails
        out.verbose(`Warning: Failed to write detected branch to config: ${error}`);
      }
    }
  }

  // Run AI setup wizard (unless --yes or --skip-ai-setup is used, or JSON output)
  const skipAISetup = values.yes || values['skip-ai-setup'] || flags.json;

  // Handle non-interactive reviewers flag
  if (values.reviewers) {
    const configPath = getGlobalConfigPath(); // Default to global for init
    const reviewers = values.reviewers.split(',').map(s => {
      const [provider, model] = s.split(':');
      return { provider: provider as any, model };
    });
    const config = loadConfigFile(configPath);
    if (!config.ai) config.ai = {};
    config.ai.reviewers = reviewers;
    saveConfig(config, configPath);
    out.log(markers.success(`Configured ${reviewers.length} reviewers.`));
  }

  if (!skipAISetup) {
    out.log('');
    out.log(markers.info('AI Provider Configuration'));
    out.log('Configure AI providers for orchestrator, coder, and reviewer roles.');
    out.log(`${colors.dim('(You can skip this and configure later with "steroids config ai")')}`);
    out.log('');

    try {
      // Run wizard for coder role first (most important)
      await runAISetup({ role: 'coder', global: true });

      // Run wizard for reviewer role
      await runAISetup({ role: 'reviewer', global: true });

      // Ask if user wants to configure other roles
      out.log('');
      out.log(`${colors.dim('Tip: Run "steroids config ai orchestrator" to configure the orchestrator role')}`);
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
