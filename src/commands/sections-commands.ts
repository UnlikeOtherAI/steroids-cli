/**
 * Sections subcommand implementations
 */

import { parseArgs } from 'node:util';
import { openDatabase, withDatabase } from '../database/connection.js';
import {
  createSection,
  getSection,
  setSectionBranch,
  setSectionAutoPr,
  setSectionPrNumber,
  setSectionPriority,
  addSectionDependency,
  removeSectionDependency,
} from '../database/queries.js';
import { isGhAvailable } from '../git/section-pr.js';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { invalidArgumentsError, sectionNotFoundError } from '../cli/errors.js';

export async function addSection(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'add', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      position: { type: 'string', short: 'p' },
      branch: { type: 'string', short: 'b' },
      'auto-pr': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections add <name> - Add a new section

USAGE:
  steroids sections add <name> [options]

OPTIONS:
  -p, --position <n>    Position in list (default: end)
  -b, --branch <name>   Target git branch for tasks in this section
  --auto-pr             Create a GitHub PR when section completes (requires gh CLI)

GLOBAL OPTIONS:
  -j, --json            Output as JSON
  -h, --help            Show help
`);
    return;
  }

  if (positionals.length === 0) {
    throw invalidArgumentsError('Section name required');
  }

  const name = positionals.join(' ');
  const position = values.position ? parseInt(values.position, 10) : undefined;
  const branch = values.branch ?? null;
  const autoPr = values['auto-pr'] ?? false;

  if (branch !== null && !/^[a-zA-Z0-9/_.-]+$/.test(branch)) {
    throw invalidArgumentsError('Branch name may only contain letters, numbers, /, _, ., and -');
  }

  if (autoPr && !isGhAvailable()) {
    out.log('Warning: --auto-pr set but gh CLI not found on PATH. PR creation will be skipped at completion time.');
  }

  if (flags.dryRun) {
    out.log(`Would create section: ${name}`);
    if (position !== undefined) {
      out.log(`  Position: ${position}`);
    }
    if (branch !== null) {
      out.log(`  Branch: ${branch}`);
    }
    if (autoPr) {
      out.log('  Auto-PR: enabled');
    }
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const section = db.transaction(() => {
      const s = createSection(db, name, position);
      if (branch !== null) {
        setSectionBranch(db, s.id, branch);
      }
      if (autoPr) {
        setSectionAutoPr(db, s.id, true);
      }
      return s;
    })();

    if (flags.json) {
      out.success({
        section: {
          id: section.id,
          name: section.name,
          position: section.position,
          priority: section.priority,
          branch: branch,
          auto_pr: autoPr ? 1 : 0,
          created_at: section.created_at,
        },
      });
    } else {
      out.log(`Section created: ${section.name}`);
      out.log(`  ID: ${section.id}`);
      out.log(`  Position: ${section.position}`);
      if (branch !== null) {
        out.log(`  Branch: ${branch}`);
      }
      if (autoPr) {
        out.log('  Auto-PR: enabled');
      }
    }
  });
}

export async function setPriority(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'priority', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections priority <section-id> <priority> - Set section priority

USAGE:
  steroids sections priority <section-id> <priority>

ARGUMENTS:
  section-id    Section ID or prefix (min 4 chars)
  priority      Priority value (0-100) or preset (high=10, medium=50, low=90)

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections priority abc123 high
  steroids sections priority abc123 25
  steroids sections priority abc123 low
`);
    return;
  }

  if (positionals.length < 2) {
    throw invalidArgumentsError('Section ID and priority required');
  }

  const [sectionIdInput, priorityInput] = positionals;

  // Parse priority
  let priority: number;
  if (priorityInput === 'high') {
    priority = 10;
  } else if (priorityInput === 'medium') {
    priority = 50;
  } else if (priorityInput === 'low') {
    priority = 90;
  } else {
    priority = parseInt(priorityInput, 10);
    if (isNaN(priority) || priority < 0 || priority > 100) {
      throw invalidArgumentsError('Priority must be 0-100 or high/medium/low');
    }
  }

  if (flags.dryRun) {
    out.log(`Would set priority to ${priority} for section: ${sectionIdInput}`);
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    setSectionPriority(db, section.id, priority);

    if (flags.json) {
      out.success({
        section: {
          id: section.id,
          name: section.name,
          priority,
        },
      });
    } else {
      out.log(`Priority set to ${priority} for section: ${section.name}`);
    }
  });
}

export async function addDependency(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'depends-on', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections depends-on <section-id> <depends-on-id> - Add section dependency

USAGE:
  steroids sections depends-on <section-id> <depends-on-id>

ARGUMENTS:
  section-id       The section that depends on another
  depends-on-id    The section that must be completed first

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections depends-on abc123 def456
`);
    return;
  }

  if (positionals.length < 2) {
    throw invalidArgumentsError('Both section IDs required');
  }

  const [sectionIdInput, dependsOnIdInput] = positionals;

  if (flags.dryRun) {
    out.log(`Would add dependency: ${sectionIdInput} depends on ${dependsOnIdInput}`);
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    const dependsOnSection = getSection(db, dependsOnIdInput);
    if (!dependsOnSection) {
      throw sectionNotFoundError(dependsOnIdInput);
    }

    const dependency = addSectionDependency(db, section.id, dependsOnSection.id);

    if (flags.json) {
      out.success({
        dependency: {
          section_id: dependency.section_id,
          depends_on_section_id: dependency.depends_on_section_id,
          section_name: section.name,
          depends_on_name: dependsOnSection.name,
        },
      });
    } else {
      out.log(`Dependency added: ${section.name} depends on ${dependsOnSection.name}`);
    }
  });
}

export async function removeDependency(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'no-depends-on', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections no-depends-on <section-id> <depends-on-id> - Remove section dependency

USAGE:
  steroids sections no-depends-on <section-id> <depends-on-id>

ARGUMENTS:
  section-id       The dependent section
  depends-on-id    The dependency to remove

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections no-depends-on abc123 def456
`);
    return;
  }

  if (positionals.length < 2) {
    throw invalidArgumentsError('Both section IDs required');
  }

  const [sectionIdInput, dependsOnIdInput] = positionals;

  if (flags.dryRun) {
    out.log(`Would remove dependency: ${sectionIdInput} no longer depends on ${dependsOnIdInput}`);
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    const dependsOnSection = getSection(db, dependsOnIdInput);
    if (!dependsOnSection) {
      throw sectionNotFoundError(dependsOnIdInput);
    }

    removeSectionDependency(db, section.id, dependsOnSection.id);

    if (flags.json) {
      out.success({
        removed: {
          section_id: section.id,
          depends_on_section_id: dependsOnSection.id,
          section_name: section.name,
          depends_on_name: dependsOnSection.name,
        },
      });
    } else {
      out.log(`Dependency removed: ${section.name} no longer depends on ${dependsOnSection.name}`);
    }
  });
}

export async function updateSection(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'update', flags });

  const { values, positionals } = parseArgs({
    args,
    options: {
      branch: { type: 'string', short: 'b' },
      'auto-pr': { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections update <section-id> - Update section settings

USAGE:
  steroids sections update <section-id> [options]

ARGUMENTS:
  section-id    Section ID or prefix (min 4 chars)

OPTIONS:
  -b, --branch <name>   Set target git branch (use "default" to clear)
  --auto-pr             Enable auto-PR on section completion (requires gh CLI)
  --no-auto-pr          Disable auto-PR

GLOBAL OPTIONS:
  -j, --json            Output as JSON
  -h, --help            Show help

EXAMPLES:
  steroids sections update abc123 --branch feature/my-feature
  steroids sections update abc123 --branch default
  steroids sections update abc123 --auto-pr
  steroids sections update abc123 --no-auto-pr
`);
    return;
  }

  if (positionals.length === 0) {
    throw invalidArgumentsError('Section ID required');
  }

  const sectionIdInput = positionals[0];
  const branchInput = values.branch;
  const autoPrInput = values['auto-pr'];

  if (branchInput === undefined && autoPrInput === undefined) {
    throw invalidArgumentsError('At least one option required (e.g. --branch, --auto-pr)');
  }

  // "default" is a sentinel to clear the branch override
  const branch = branchInput === undefined ? undefined : (branchInput === 'default' ? null : branchInput);

  if (branch !== undefined && branch !== null && !/^[a-zA-Z0-9/_.-]+$/.test(branch)) {
    throw invalidArgumentsError('Branch name may only contain letters, numbers, /, _, ., and -');
  }

  if (autoPrInput === true && !isGhAvailable()) {
    out.log('Warning: --auto-pr set but gh CLI not found on PATH. PR creation will be skipped at completion time.');
  }

  if (flags.dryRun) {
    if (branch !== undefined) {
      const display = branch === null ? '(clear override — use project base)' : branch;
      out.log(`Would set branch to ${display} for section: ${sectionIdInput}`);
    }
    if (autoPrInput !== undefined) {
      out.log(`Would set auto-pr to ${autoPrInput ? 'enabled' : 'disabled'} for section: ${sectionIdInput}`);
    }
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    if (branch !== undefined) {
      setSectionBranch(db, section.id, branch);
    }
    if (autoPrInput !== undefined) {
      setSectionAutoPr(db, section.id, autoPrInput);
    }

    if (flags.json) {
      out.success({
        section: {
          id: section.id,
          name: section.name,
          branch: branch !== undefined ? branch : section.branch,
          auto_pr: autoPrInput !== undefined ? (autoPrInput ? 1 : 0) : section.auto_pr,
        },
      });
    } else {
      if (branch !== undefined) {
        if (branch === null) {
          out.log(`Branch override cleared for section: ${section.name}`);
          out.log('  Tasks will use the project base branch');
        } else {
          out.log(`Branch set to ${branch} for section: ${section.name}`);
        }
      }
      if (autoPrInput !== undefined) {
        out.log(`Auto-PR ${autoPrInput ? 'enabled' : 'disabled'} for section: ${section.name}`);
      }
    }
  });
}

export async function resetSectionPr(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'sections', subcommand: 'reset-pr', flags });

  const { positionals } = parseArgs({
    args,
    options: {},
    allowPositionals: true,
  });

  if (flags.help) {
    out.log(`
steroids sections reset-pr <section-id> - Clear PR number to allow re-triggering auto-PR

USAGE:
  steroids sections reset-pr <section-id>

ARGUMENTS:
  section-id    Section ID or prefix (min 4 chars)

GLOBAL OPTIONS:
  -j, --json    Output as JSON
  -h, --help    Show help

EXAMPLES:
  steroids sections reset-pr abc123
`);
    return;
  }

  if (positionals.length === 0) {
    throw invalidArgumentsError('Section ID required');
  }

  const sectionIdInput = positionals[0];

  if (flags.dryRun) {
    out.log(`Would clear PR number for section: ${sectionIdInput}`);
    return;
  }

  const projectPath = process.cwd();
  /* REFACTOR_MANUAL */ withDatabase(projectPath, (db: any) => {
    const section = getSection(db, sectionIdInput);
    if (!section) {
      throw sectionNotFoundError(sectionIdInput);
    }

    setSectionPrNumber(db, section.id, null);

    if (flags.json) {
      out.success({ section: { id: section.id, name: section.name, pr_number: null } });
    } else {
      out.log(`PR number cleared for section: ${section.name}`);
      out.log('  Auto-PR will be re-triggered on next task approval if conditions are met.');
    }
  });
}
