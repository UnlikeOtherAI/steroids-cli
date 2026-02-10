/**
 * steroids web - Launch and manage the Steroids web dashboard
 * Auto-clones the repo on first run, then launches WebUI + API
 */

import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { generateHelp } from '../cli/help.js';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';

// Get CLI version from package.json (relative to dist/commands/)
function getCLIVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0'; // Fallback
  }
}
const CLI_VERSION = getCLIVersion();

const WEB_DIR = join(homedir(), '.steroids', 'webui');
const LOGS_DIR = join(homedir(), '.steroids', 'logs');
const REPO_URL = 'https://github.com/UnlikeOtherAI/steroids-cli.git';
const API_PORT = 3501;
const WEBUI_PORT = 3500;

const HELP = generateHelp({
  command: 'web',
  description: 'Launch and manage the Steroids web dashboard',
  details: `On first run, clones the Steroids repo to ~/.steroids/webui/ and installs dependencies.
Subsequent runs launch the WebUI and API from the local clone.
Use 'update' to pull the latest version, 'stop' to kill running processes.`,
  usage: [
    'steroids web [subcommand]',
  ],
  subcommands: [
    { name: 'launch', description: 'Clone (if needed) and start WebUI + API (default)' },
    { name: 'update', description: 'Pull latest code and reinstall dependencies' },
    { name: 'stop', description: 'Stop running WebUI and API processes' },
    { name: 'status', description: 'Check if WebUI and API are running' },
  ],
  examples: [
    { command: 'steroids web', description: 'Launch the web dashboard' },
    { command: 'steroids web update', description: 'Pull latest changes' },
    { command: 'steroids web stop', description: 'Stop the dashboard' },
    { command: 'steroids web status', description: 'Check if running' },
  ],
  related: [
    { command: 'steroids runners', description: 'Manage runner daemons' },
    { command: 'steroids tasks', description: 'Manage tasks' },
  ],
});

/**
 * Check if a port has a listener
 */
function isPortInUse(port: number): boolean {
  try {
    const result = execSync(`lsof -ti:${port}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Kill processes on a port
 */
function killPort(port: number): void {
  try {
    execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // No process on port, that's fine
  }
}

/**
 * Run a shell command with inherited stdio (shows output)
 */
function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

/**
 * Ensure the web repo is cloned
 */
function ensureRepo(out: ReturnType<typeof createOutput>): boolean {
  if (existsSync(join(WEB_DIR, '.git'))) {
    return false; // Already cloned
  }

  out.log(`Cloning Steroids repository (v${CLI_VERSION})...`);
  const parentDir = join(homedir(), '.steroids');
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // hardcoded command, no user input - clone specific version tag
  const tag = `v${CLI_VERSION}`;
  execSync(`git clone --depth 1 --branch ${tag} ${REPO_URL} "${WEB_DIR}"`, { stdio: 'inherit' });
  out.log(`Repository cloned (${tag}).`);
  return true;
}

/**
 * Install dependencies and build
 */
function installAndBuild(out: ReturnType<typeof createOutput>): void {
  const apiDir = join(WEB_DIR, 'API');
  const webUiDir = join(WEB_DIR, 'WebUI');

  if (!existsSync(apiDir) || !existsSync(webUiDir)) {
    out.log('Error: API/ or WebUI/ directory not found in the cloned repository.');
    process.exit(1);
  }

  // Install root dependencies first (needed for ../src/ imports in API)
  out.log('Installing root dependencies...');
  run('npm install', WEB_DIR);

  // Build main project (creates dist/ files needed by API)
  out.log('Building main project...');
  run('npm run build', WEB_DIR);

  out.log('Installing API dependencies...');
  run('npm install', apiDir);

  out.log('Building API...');
  run('npm run build', apiDir);

  out.log('Installing WebUI dependencies...');
  run('npm install', webUiDir);
}

/**
 * Launch API and WebUI as background processes
 */
function launchProcesses(out: ReturnType<typeof createOutput>): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }

  // Kill existing processes on these ports
  killPort(API_PORT);
  killPort(WEBUI_PORT);

  const apiDir = join(WEB_DIR, 'API');
  const webUiDir = join(WEB_DIR, 'WebUI');

  // Start API
  const apiLogPath = join(LOGS_DIR, 'api.log');
  const apiLog = openSync(apiLogPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC);
  const apiProcess = spawn('node', ['dist/API/src/index.js'], {
    cwd: apiDir,
    detached: true,
    stdio: ['ignore', apiLog, apiLog],
  });
  apiProcess.unref();

  // Start WebUI
  const webUiLogPath = join(LOGS_DIR, 'webui.log');
  const webUiLog = openSync(webUiLogPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC);
  const webUiProcess = spawn('npm', ['run', 'dev', '--', '--port', String(WEBUI_PORT)], {
    cwd: webUiDir,
    detached: true,
    stdio: ['ignore', webUiLog, webUiLog],
  });
  webUiProcess.unref();

  out.log('');
  out.log(`Web UI:  http://localhost:${WEBUI_PORT}`);
  out.log(`API:     http://localhost:${API_PORT}`);
  out.log('');
  out.log(`Logs:    ${apiLogPath}`);
  out.log(`         ${webUiLogPath}`);
  out.log('');
  out.log('Run "steroids web stop" to stop the dashboard.');
}

export async function webCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'web', flags });

  if (flags.help || args.includes('-h') || args.includes('--help')) {
    out.log(HELP);
    return;
  }

  const subcommand = args[0] || 'launch';

  switch (subcommand) {
    case 'launch': {
      const freshClone = ensureRepo(out);
      if (freshClone) {
        installAndBuild(out);
      } else {
        // Check if we need to update to match CLI version
        out.log('Checking version...');
        try {
          const currentTag = execSync('git describe --tags --exact-match', {
            cwd: WEB_DIR,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
          }).trim();
          const expectedTag = `v${CLI_VERSION}`;

          if (currentTag === expectedTag) {
            out.log(`Already on ${expectedTag}.`);
          } else {
            out.log(`Updating from ${currentTag} to ${expectedTag}...`);
            execSync(`git fetch --depth 1 origin tag ${expectedTag}`, { cwd: WEB_DIR, stdio: 'inherit' });
            execSync(`git checkout ${expectedTag}`, { cwd: WEB_DIR, stdio: 'inherit' });
            installAndBuild(out);
          }
        } catch {
          out.log('Could not verify version. Launching with current code.');
        }
      }
      launchProcesses(out);
      break;
    }

    case 'update': {
      if (!existsSync(join(WEB_DIR, '.git'))) {
        out.log('Web dashboard not installed. Run "steroids web" first.');
        process.exit(1);
      }

      out.log('Pulling latest changes...');
      run('git pull', WEB_DIR);

      installAndBuild(out);

      out.log('');
      out.log('Updated. Restart with: steroids web stop && steroids web');
      break;
    }

    case 'stop': {
      const apiRunning = isPortInUse(API_PORT);
      const webUiRunning = isPortInUse(WEBUI_PORT);

      if (!apiRunning && !webUiRunning) {
        out.log('Web dashboard is not running.');
        return;
      }

      if (apiRunning) killPort(API_PORT);
      if (webUiRunning) killPort(WEBUI_PORT);
      out.log('Web dashboard stopped.');
      break;
    }

    case 'status': {
      const apiUp = isPortInUse(API_PORT);
      const webUiUp = isPortInUse(WEBUI_PORT);
      const installed = existsSync(join(WEB_DIR, '.git'));

      out.log(`Installed:  ${installed ? WEB_DIR : 'No (run "steroids web" to install)'}`);
      out.log(`API:        ${apiUp ? `Running on port ${API_PORT}` : 'Stopped'}`);
      out.log(`WebUI:      ${webUiUp ? `Running on port ${WEBUI_PORT}` : 'Stopped'}`);
      break;
    }

    default:
      out.log(`Unknown subcommand: ${subcommand}`);
      out.log('Run "steroids web --help" for usage.');
      process.exit(1);
  }
}
