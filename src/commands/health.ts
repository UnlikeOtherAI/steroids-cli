import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids health - Project health checking with scoring
 *
 * Checks:
 * - Git status (clean/dirty)
 * - Dependencies installed
 * - Tests passing
 * - Lint passing
 * - Task completion percentage
 */

import { parseArgs } from 'node:util';
import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, isInitialized } from '../database/connection.js';
import { listTasks } from '../database/queries.js';
import { hasUncommittedChanges, isGitRepo } from '../git/status.js';

// Health check weights (must sum to 100)
const WEIGHTS = {
  git: 20,
  deps: 20,
  tests: 25,
  lint: 15,
  tasks: 20,
} as const;

type CheckName = keyof typeof WEIGHTS;

interface CheckResult {
  name: CheckName;
  passed: boolean;
  message: string;
  score: number;
  fixable: boolean;
  fixCommand?: string;
}

interface HealthResult {
  score: number;
  checks: CheckResult[];
  passed: boolean;
}

const HELP = `
steroids health - Check project health

USAGE:
  steroids health [options]

OPTIONS:
  --threshold <n>   Exit with code 7 if score below threshold
  --fix             Attempt auto-fixes for failing checks
  --watch           Continuously monitor health (Ctrl+C to stop)
  --check <name>    Run specific check: git, deps, tests, lint, tasks
  -j, --json        Output as JSON
  -h, --help        Show help

CHECKS:
  git (20%)         No uncommitted changes
  deps (20%)        Dependencies installed
  tests (25%)       All tests pass
  lint (15%)        No lint errors
  tasks (20%)       Task completion percentage

EXIT CODES:
  0                 Success (or health above threshold)
  1                 General error
  7                 Health score below threshold

EXAMPLES:
  steroids health
  steroids health --threshold 80
  steroids health --fix
  steroids health --watch
  steroids health --check tests
`;

export async function healthCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      threshold: { type: 'string' },
      fix: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      check: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.watch) {
    await runWatchMode(values.json ?? false, values.threshold);
    return;
  }

  const result = await runHealthChecks(values.check as CheckName | undefined);

  if (values.fix) {
    await attemptFixes(result.checks);
    // Re-run checks after fixes
    const newResult = await runHealthChecks(values.check as CheckName | undefined);
    outputResult(newResult, values.json ?? false);
    checkThreshold(newResult.score, values.threshold);
    return;
  }

  outputResult(result, values.json ?? false);
  checkThreshold(result.score, values.threshold);
}

async function runHealthChecks(specificCheck?: CheckName): Promise<HealthResult> {
  const checks: CheckResult[] = [];
  const checksToRun: CheckName[] = specificCheck
    ? [specificCheck]
    : ['git', 'deps', 'tests', 'lint', 'tasks'];

  for (const checkName of checksToRun) {
    const result = await runCheck(checkName);
    checks.push(result);
  }

  // Calculate overall score
  let totalWeight = 0;
  let weightedScore = 0;

  for (const check of checks) {
    totalWeight += WEIGHTS[check.name];
    weightedScore += check.score;
  }

  // Normalize if running subset of checks
  const score = specificCheck
    ? Math.round((weightedScore / totalWeight) * 100)
    : Math.round(weightedScore);

  return {
    score,
    checks,
    passed: score >= 80, // Default passing threshold
  };
}

async function runCheck(name: CheckName): Promise<CheckResult> {
  switch (name) {
    case 'git':
      return checkGit();
    case 'deps':
      return checkDeps();
    case 'tests':
      return checkTests();
    case 'lint':
      return checkLint();
    case 'tasks':
      return checkTasks();
    default:
      return {
        name,
        passed: false,
        message: `Unknown check: ${name}`,
        score: 0,
        fixable: false,
      };
  }
}

function checkGit(): CheckResult {
  const projectPath = process.cwd();

  if (!isGitRepo(projectPath)) {
    return {
      name: 'git',
      passed: false,
      message: 'Not a git repository',
      score: 0,
      fixable: false,
    };
  }

  const hasChanges = hasUncommittedChanges(projectPath);

  return {
    name: 'git',
    passed: !hasChanges,
    message: hasChanges ? 'Uncommitted changes' : 'Clean',
    score: hasChanges ? 0 : WEIGHTS.git,
    fixable: false, // Changes must be committed manually
  };
}

function checkDeps(): CheckResult {
  const projectPath = process.cwd();

  // Check for node_modules
  const nodeModulesPath = join(projectPath, 'node_modules');
  const packageJsonPath = join(projectPath, 'package.json');

  if (!existsSync(packageJsonPath)) {
    // Not a Node.js project, check other project types
    return checkOtherProjectDeps(projectPath);
  }

  if (!existsSync(nodeModulesPath)) {
    return {
      name: 'deps',
      passed: false,
      message: 'Dependencies not installed',
      score: 0,
      fixable: true,
      fixCommand: 'npm install',
    };
  }

  // Check if package-lock.json matches package.json (basic check)
  try {
    execSync('npm ls --depth=0', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      name: 'deps',
      passed: true,
      message: 'Installed',
      score: WEIGHTS.deps,
      fixable: false,
    };
  } catch {
    return {
      name: 'deps',
      passed: false,
      message: 'Missing or outdated dependencies',
      score: WEIGHTS.deps / 2, // Partial credit
      fixable: true,
      fixCommand: 'npm install',
    };
  }
}

function checkOtherProjectDeps(projectPath: string): CheckResult {
  // Python
  if (existsSync(join(projectPath, 'pyproject.toml')) ||
      existsSync(join(projectPath, 'requirements.txt'))) {
    // Check for virtual environment
    if (existsSync(join(projectPath, '.venv')) ||
        existsSync(join(projectPath, 'venv'))) {
      return {
        name: 'deps',
        passed: true,
        message: 'Python venv found',
        score: WEIGHTS.deps,
        fixable: false,
      };
    }
    return {
      name: 'deps',
      passed: false,
      message: 'Python venv not found',
      score: 0,
      fixable: true,
      fixCommand: 'python -m venv .venv && .venv/bin/pip install -r requirements.txt',
    };
  }

  // Rust
  if (existsSync(join(projectPath, 'Cargo.toml'))) {
    if (existsSync(join(projectPath, 'target'))) {
      return {
        name: 'deps',
        passed: true,
        message: 'Cargo dependencies built',
        score: WEIGHTS.deps,
        fixable: false,
      };
    }
    return {
      name: 'deps',
      passed: false,
      message: 'Cargo not built',
      score: 0,
      fixable: true,
      fixCommand: 'cargo build',
    };
  }

  // Go
  if (existsSync(join(projectPath, 'go.mod'))) {
    return {
      name: 'deps',
      passed: true,
      message: 'Go module',
      score: WEIGHTS.deps,
      fixable: false,
    };
  }

  // No recognizable project type
  return {
    name: 'deps',
    passed: true,
    message: 'No package manager detected',
    score: WEIGHTS.deps,
    fixable: false,
  };
}

function checkTests(): CheckResult {
  const projectPath = process.cwd();
  const packageJsonPath = join(projectPath, 'package.json');

  // Try to run tests
  try {
    if (existsSync(packageJsonPath)) {
      execSync('npm test 2>&1', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000, // 2 minute timeout
      });
      return {
        name: 'tests',
        passed: true,
        message: 'All tests pass',
        score: WEIGHTS.tests,
        fixable: false,
      };
    }

    // Python
    if (existsSync(join(projectPath, 'pyproject.toml')) ||
        existsSync(join(projectPath, 'pytest.ini'))) {
      execSync('pytest 2>&1', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      });
      return {
        name: 'tests',
        passed: true,
        message: 'All tests pass',
        score: WEIGHTS.tests,
        fixable: false,
      };
    }

    // Rust
    if (existsSync(join(projectPath, 'Cargo.toml'))) {
      execSync('cargo test 2>&1', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      });
      return {
        name: 'tests',
        passed: true,
        message: 'All tests pass',
        score: WEIGHTS.tests,
        fixable: false,
      };
    }

    // Go
    if (existsSync(join(projectPath, 'go.mod'))) {
      execSync('go test ./... 2>&1', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000,
      });
      return {
        name: 'tests',
        passed: true,
        message: 'All tests pass',
        score: WEIGHTS.tests,
        fixable: false,
      };
    }

    return {
      name: 'tests',
      passed: true,
      message: 'No test runner detected',
      score: WEIGHTS.tests,
      fixable: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tests failing';
    // Try to extract failure count
    const failMatch = message.match(/(\d+)\s*(failing|failed)/i);
    const failCount = failMatch ? failMatch[1] : 'some';

    return {
      name: 'tests',
      passed: false,
      message: `${failCount} tests failing`,
      score: 0,
      fixable: false,
    };
  }
}

function checkLint(): CheckResult {
  const projectPath = process.cwd();
  const packageJsonPath = join(projectPath, 'package.json');

  try {
    if (existsSync(packageJsonPath)) {
      // Check if lint script exists
      const pkg = JSON.parse(
        execSync(`cat "${packageJsonPath}"`, { encoding: 'utf-8' })
      );
      if (!pkg.scripts?.lint) {
        return {
          name: 'lint',
          passed: true,
          message: 'No lint script',
          score: WEIGHTS.lint,
          fixable: false,
        };
      }

      execSync('npm run lint 2>&1', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      });
      return {
        name: 'lint',
        passed: true,
        message: 'No errors',
        score: WEIGHTS.lint,
        fixable: false,
      };
    }

    // Python - check for ruff or flake8
    if (existsSync(join(projectPath, 'pyproject.toml'))) {
      try {
        execSync('ruff check . 2>&1', {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return {
          name: 'lint',
          passed: true,
          message: 'No errors',
          score: WEIGHTS.lint,
          fixable: false,
        };
      } catch {
        return {
          name: 'lint',
          passed: false,
          message: 'Lint errors found',
          score: 0,
          fixable: true,
          fixCommand: 'ruff check --fix .',
        };
      }
    }

    // Rust
    if (existsSync(join(projectPath, 'Cargo.toml'))) {
      execSync('cargo clippy 2>&1', {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return {
        name: 'lint',
        passed: true,
        message: 'No warnings',
        score: WEIGHTS.lint,
        fixable: false,
      };
    }

    return {
      name: 'lint',
      passed: true,
      message: 'No linter detected',
      score: WEIGHTS.lint,
      fixable: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lint errors';
    const errorMatch = message.match(/(\d+)\s*errors?/i);
    const errorCount = errorMatch ? errorMatch[1] : 'some';

    return {
      name: 'lint',
      passed: false,
      message: `${errorCount} lint errors`,
      score: 0,
      fixable: true,
      fixCommand: 'npm run lint -- --fix',
    };
  }
}

function checkTasks(): CheckResult {
  const projectPath = process.cwd();

  if (!isInitialized(projectPath)) {
    return {
      name: 'tasks',
      passed: true,
      message: 'Steroids not initialized',
      score: WEIGHTS.tasks,
      fixable: false,
    };
  }

  const { db, close } = openDatabase(projectPath);
  try {
    const allTasks = listTasks(db, { status: 'all' });
    const completedTasks = allTasks.filter(t => t.status === 'completed');

    if (allTasks.length === 0) {
      return {
        name: 'tasks',
        passed: true,
        message: 'No tasks',
        score: WEIGHTS.tasks,
        fixable: false,
      };
    }

    const completionRate = completedTasks.length / allTasks.length;
    const score = Math.round(completionRate * WEIGHTS.tasks);

    return {
      name: 'tasks',
      passed: completionRate >= 0.8,
      message: `${Math.round(completionRate * 100)}% complete (${completedTasks.length}/${allTasks.length})`,
      score,
      fixable: false,
    };
  } finally {
    close();
  }
}

async function attemptFixes(checks: CheckResult[]): Promise<void> {
  console.log('Attempting fixes...');

  for (const check of checks) {
    if (!check.passed && check.fixable && check.fixCommand) {
      console.log(`  Fixing ${check.name}...`);
      try {
        execSync(check.fixCommand, {
          cwd: process.cwd(),
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log(`    Fixed ${check.name}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        console.log(`    Failed to fix ${check.name}: ${msg}`);
      }
    }
  }
}

async function runWatchMode(json: boolean, threshold?: string): Promise<void> {
  console.log('Watching project health... (Ctrl+C to stop)\n');

  const runOnce = async () => {
    // Clear console in terminal mode
    if (!json) {
      process.stdout.write('\x1B[2J\x1B[0f');
      console.log(`Health Check - ${new Date().toLocaleTimeString()}\n`);
    }

    const result = await runHealthChecks();
    outputResult(result, json);

    if (threshold) {
      const thresholdNum = parseInt(threshold, 10);
      if (result.score < thresholdNum) {
        console.log(`\nWarning: Score ${result.score} is below threshold ${thresholdNum}`);
      }
    }
  };

  // Initial run
  await runOnce();

  // Watch for changes
  const interval = setInterval(runOnce, 5000);

  // Handle SIGINT
  process.on('SIGINT', () => {
    clearInterval(interval);
    console.log('\nStopped watching.');
    process.exit(0);
  });

  // Keep process running
  await new Promise(() => {});
}

function outputResult(result: HealthResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      success: true,
      command: 'health',
      data: {
        score: result.score,
        passed: result.passed,
        checks: Object.fromEntries(
          result.checks.map(c => [c.name, {
            passed: c.passed,
            message: c.message,
            score: c.score,
            fixable: c.fixable,
          }])
        ),
      },
      error: null,
    }, null, 2));
    return;
  }

  console.log(`Health Score: ${result.score}/100\n`);
  console.log('Checks:');

  for (const check of result.checks) {
    const marker = check.passed ? '\u2713' : '\u2717';
    const weight = `(${WEIGHTS[check.name]}%)`;
    console.log(`  ${marker} ${check.name.padEnd(6)} ${weight.padEnd(6)} ${check.message}`);
  }
}

function checkThreshold(score: number, threshold?: string): void {
  if (!threshold) return;

  const thresholdNum = parseInt(threshold, 10);
  if (isNaN(thresholdNum)) {
    console.error(`Invalid threshold: ${threshold}`);
    process.exit(1);
  }

  if (score < thresholdNum) {
    console.error(`\nError: Health score ${score} is below threshold ${thresholdNum}`);
    process.exit(7);
  }
}
