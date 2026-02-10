import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids completion - Generate shell completion scripts
 *
 * Subcommands:
 * - bash: Generate bash completion
 * - zsh: Generate zsh completion
 * - fish: Generate fish completion
 * - install: Auto-install for current shell
 */

import { parseArgs } from 'node:util';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generateHelp } from '../cli/help.js';

const HELP = generateHelp({
  command: 'completion',
  description: 'Generate shell completion scripts',
  details: 'Auto-completion enables tab-completion for steroids commands and flags in your shell.',
  usage: [
    'steroids completion <shell>',
  ],
  subcommands: [
    { name: 'bash', description: 'Generate bash completion script' },
    { name: 'zsh', description: 'Generate zsh completion script' },
    { name: 'fish', description: 'Generate fish completion script' },
    { name: 'install', description: 'Auto-install for current shell' },
  ],
  examples: [
    { command: 'steroids completion bash >> ~/.bashrc', description: 'Add bash completion to .bashrc' },
    { command: 'steroids completion zsh >> ~/.zshrc', description: 'Add zsh completion to .zshrc' },
    { command: 'steroids completion fish > ~/.config/fish/completions/steroids.fish', description: 'Create fish completion file' },
    { command: 'steroids completion install', description: 'Auto-detect shell and install' },
  ],
  related: [
    { command: 'steroids --help', description: 'Show main help' },
  ],
  showGlobalOptions: false,
  showEnvVars: false,
  showExitCodes: false,
});

// All steroids commands and their subcommands for completion
const COMMANDS = {
  about: [],
  llm: [],
  init: [],
  sections: ['add', 'list', 'priority', 'depends-on', 'no-depends-on', 'graph'],
  tasks: ['stats', 'add', 'list', 'update', 'approve', 'reject', 'skip', 'audit'],
  loop: [],
  runners: ['list', 'start', 'stop', 'status', 'logs', 'wakeup', 'cron'],
  config: ['init', 'show', 'get', 'set', 'validate', 'path', 'edit', 'browse'],
  health: ['check', 'incidents'],
  scan: [],
  backup: ['create', 'restore', 'list', 'clean'],
  logs: ['show', 'list', 'tail', 'purge'],
  cleanup: ['logs'],
  gc: [],
  disputes: ['create', 'list', 'show', 'resolve', 'log'],
  purge: ['tasks', 'ids', 'logs', 'all'],
  git: ['status', 'push', 'retry', 'log'],
  projects: ['list', 'add', 'remove', 'enable', 'disable', 'prune'],
  locks: ['list', 'show', 'release', 'cleanup'],
  completion: ['bash', 'zsh', 'fish', 'install'],
};

const GLOBAL_FLAGS = [
  '--help', '-h',
  '--json', '-j',
  '--quiet', '-q',
  '--verbose', '-v',
  '--version',
  '--no-color',
  '--dry-run',
  '--config',
  '--timeout',
  '--no-hooks',
];

export async function completionCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag
  if (flags.help || args.length === 0 || args[0] === '-h' || args[0] === '--help') {
    console.log(HELP);
    return;
  }

  const shell = args[0];

  switch (shell) {
    case 'bash':
      console.log(generateBashCompletion());
      break;
    case 'zsh':
      console.log(generateZshCompletion());
      break;
    case 'fish':
      console.log(generateFishCompletion());
      break;
    case 'install':
      await installCompletion();
      break;
    default:
      console.error(`Unknown shell: ${shell}`);
      console.log('Supported shells: bash, zsh, fish');
      process.exit(1);
  }
}

function generateBashCompletion(): string {
  const commands = Object.keys(COMMANDS).join(' ');
  const subcommands = Object.entries(COMMANDS)
    .filter(([, subs]) => subs.length > 0)
    .map(([cmd, subs]) => `      ${cmd}) COMPREPLY=($(compgen -W "${subs.join(' ')}" -- "\${cur}")) ;;`)
    .join('\n');

  return `# Steroids CLI bash completion
# Add this to ~/.bashrc or source it directly

_steroids_completion() {
  local cur prev words cword
  _init_completion || return

  local commands="${commands}"
  local global_flags="${GLOBAL_FLAGS.join(' ')}"

  # Handle first argument (command)
  if [[ \${cword} -eq 1 ]]; then
    COMPREPLY=($(compgen -W "\${commands}" -- "\${cur}"))
    return
  fi

  local cmd="\${words[1]}"

  # Handle subcommands
  case "\${cmd}" in
${subcommands}
    esac

  # Handle flags
  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=($(compgen -W "\${global_flags}" -- "\${cur}"))
    return
  fi

  # Default to file completion
  _filedir
}

complete -F _steroids_completion steroids
`;
}

function generateZshCompletion(): string {
  const commandList = Object.entries(COMMANDS)
    .map(([cmd, subs]) => {
      if (subs.length > 0) {
        return `    '${cmd}:${getCommandDescription(cmd)}'`;
      }
      return `    '${cmd}:${getCommandDescription(cmd)}'`;
    })
    .join('\n');

  const subcommandCases = Object.entries(COMMANDS)
    .filter(([, subs]) => subs.length > 0)
    .map(([cmd, subs]) => {
      const subList = subs.map(s => `'${s}:${getSubcommandDescription(cmd, s)}'`).join(' ');
      return `      ${cmd})
        _arguments "1: :(${subList})"
        ;;`;
    })
    .join('\n');

  return `#compdef steroids
# Steroids CLI zsh completion
# Add this to a file in your $fpath or source it

_steroids() {
  local curcontext="\$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '1: :->command' \\
    '*: :->args'

  case \$state in
    command)
      local commands=(
${commandList}
      )
      _describe 'command' commands
      ;;
    args)
      case \$line[1] in
${subcommandCases}
      esac
      ;;
  esac
}

_steroids "\$@"
`;
}

function generateFishCompletion(): string {
  const commandCompletions = Object.entries(COMMANDS)
    .map(([cmd, subs]) => {
      const desc = getCommandDescription(cmd);
      let result = `complete -c steroids -n "__fish_use_subcommand" -a "${cmd}" -d "${desc}"`;

      if (subs.length > 0) {
        result += '\n' + subs.map(sub => {
          const subDesc = getSubcommandDescription(cmd, sub);
          return `complete -c steroids -n "__fish_seen_subcommand_from ${cmd}" -a "${sub}" -d "${subDesc}"`;
        }).join('\n');
      }

      return result;
    })
    .join('\n');

  const flagCompletions = GLOBAL_FLAGS
    .filter(f => f.startsWith('--'))
    .map(flag => {
      const desc = getFlagDescription(flag);
      return `complete -c steroids -l "${flag.slice(2)}" -d "${desc}"`;
    })
    .join('\n');

  return `# Steroids CLI fish completion
# Save to ~/.config/fish/completions/steroids.fish

# Disable file completion by default
complete -c steroids -f

# Commands
${commandCompletions}

# Global flags
${flagCompletions}

# Short flags
complete -c steroids -s h -d "Show help"
complete -c steroids -s j -d "Output as JSON"
complete -c steroids -s q -d "Quiet output"
complete -c steroids -s v -d "Verbose output"
`;
}

async function installCompletion(): Promise<void> {
  const shell = process.env.SHELL || '';
  const home = homedir();

  if (shell.includes('zsh')) {
    const zshrc = join(home, '.zshrc');
    const completion = generateZshCompletion();
    const marker = '# steroids completion';

    if (existsSync(zshrc)) {
      const content = readFileSync(zshrc, 'utf-8');
      if (content.includes(marker)) {
        console.log('Steroids completion already installed in ~/.zshrc');
        return;
      }
    }

    appendFileSync(zshrc, `\n${marker}\n${completion}\n`);
    console.log('Installed zsh completion to ~/.zshrc');
    console.log('Restart your shell or run: source ~/.zshrc');
  } else if (shell.includes('bash')) {
    const bashrc = join(home, '.bashrc');
    const completion = generateBashCompletion();
    const marker = '# steroids completion';

    if (existsSync(bashrc)) {
      const content = readFileSync(bashrc, 'utf-8');
      if (content.includes(marker)) {
        console.log('Steroids completion already installed in ~/.bashrc');
        return;
      }
    }

    appendFileSync(bashrc, `\n${marker}\n${completion}\n`);
    console.log('Installed bash completion to ~/.bashrc');
    console.log('Restart your shell or run: source ~/.bashrc');
  } else if (shell.includes('fish')) {
    const fishDir = join(home, '.config', 'fish', 'completions');
    const fishFile = join(fishDir, 'steroids.fish');
    const completion = generateFishCompletion();

    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(fishDir, { recursive: true });
    writeFileSync(fishFile, completion);

    console.log('Installed fish completion to ~/.config/fish/completions/steroids.fish');
  } else {
    console.error(`Unknown shell: ${shell}`);
    console.log('Please manually install completion for your shell.');
    console.log('Available: steroids completion bash|zsh|fish');
    process.exit(1);
  }
}

function getCommandDescription(cmd: string): string {
  const descriptions: Record<string, string> = {
    about: 'Explain what Steroids is',
    llm: 'Compact instructions for LLM agents',
    init: 'Initialize steroids in current directory',
    sections: 'Manage task sections',
    tasks: 'Manage tasks',
    loop: 'Run the orchestrator loop',
    runners: 'Manage runner daemons',
    config: 'Manage configuration',
    health: 'Check project health',
    scan: 'Scan directory for projects',
    backup: 'Manage backups',
    logs: 'View invocation logs',
    gc: 'Garbage collection',
    disputes: 'Manage coder/reviewer disputes',
    purge: 'Purge old data',
    git: 'Git integration commands',
    projects: 'Manage global project registry',
    locks: 'Manage task and section locks',
    completion: 'Generate shell completions',
  };
  return descriptions[cmd] || cmd;
}

function getSubcommandDescription(cmd: string, sub: string): string {
  const descriptions: Record<string, Record<string, string>> = {
    sections: {
      add: 'Add a new section',
      list: 'List sections',
      priority: 'Set section priority',
      'depends-on': 'Add section dependency',
      'no-depends-on': 'Remove section dependency',
      graph: 'Show dependency graph',
    },
    tasks: {
      stats: 'Show task counts by status',
      add: 'Add a new task',
      list: 'List tasks',
      update: 'Update task status',
      approve: 'Approve a task',
      reject: 'Reject a task',
      skip: 'Skip external setup task',
      audit: 'View task audit trail',
    },
    runners: {
      list: 'List runners',
      start: 'Start a runner',
      stop: 'Stop a runner',
      status: 'Show runner status',
      logs: 'View runner logs',
      wakeup: 'Check and start runners for projects with work',
      cron: 'Manage cron job for auto-wakeup',
    },
    health: {
      check: 'Detect and recover stuck tasks/runners',
      incidents: 'View and manage stuck-task incident history',
    },
    config: {
      init: 'Create configuration file',
      show: 'Show configuration',
      get: 'Get configuration value',
      set: 'Set configuration value',
      validate: 'Validate configuration',
      path: 'Show config file paths',
      edit: 'Edit configuration file',
      browse: 'Open configuration browser',
    },
    backup: {
      create: 'Create a backup',
      restore: 'Restore from backup',
      list: 'List backups',
      clean: 'Clean old backups',
    },
    logs: {
      show: 'View logs for task',
      list: 'List log files',
      tail: 'Tail logs',
      purge: 'Purge old logs',
    },
    disputes: {
      create: 'Create a dispute',
      list: 'List disputes',
      show: 'Show dispute details',
      resolve: 'Resolve a dispute',
      log: 'Log minor disagreement',
    },
    purge: {
      tasks: 'Purge completed tasks',
      ids: 'Purge task ID history',
      logs: 'Purge old logs',
      all: 'Purge all purgeable data',
    },
    git: {
      status: 'Show git status',
      push: 'Push pending commits',
      retry: 'Retry failed pushes',
      log: 'View git push log',
    },
    projects: {
      list: 'List registered projects',
      add: 'Register a project',
      remove: 'Unregister a project',
      enable: 'Enable a project',
      disable: 'Disable a project',
      prune: 'Remove stale entries',
    },
    locks: {
      list: 'List active locks',
      show: 'Show lock details',
      release: 'Release a lock',
      cleanup: 'Clean stale locks',
    },
    completion: {
      bash: 'Generate bash completion',
      zsh: 'Generate zsh completion',
      fish: 'Generate fish completion',
      install: 'Auto-install completion',
    },
  };
  return descriptions[cmd]?.[sub] || sub;
}

function getFlagDescription(flag: string): string {
  const descriptions: Record<string, string> = {
    '--help': 'Show help',
    '--json': 'Output as JSON',
    '--quiet': 'Quiet output',
    '--verbose': 'Verbose output',
    '--version': 'Show version',
    '--no-color': 'Disable colored output',
    '--dry-run': 'Preview without making changes',
    '--config': 'Custom config path',
    '--timeout': 'Command timeout',
    '--no-hooks': 'Skip hook execution',
  };
  return descriptions[flag] || flag;
}
