import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids dispute - Manage disputes
 *
 * Commands for creating, viewing, and resolving coder/reviewer disputes.
 */

import { parseArgs } from 'node:util';
import { openDatabase } from '../database/connection.js';
import { getTask, getTaskByTitle } from '../database/queries.js';
import {
  createDispute,
  createCoderDispute,
  createReviewerDispute,
  createMajorDispute,
  createMinorDispute,
  logMinorDisagreement,
  resolve,
  getDispute,
  listDisputesWithTasks,
  getStaleDisputes,
  checkStaleDisputes,
  getStaleDisputeSummary,
  formatDisputeAge,
  writeDisputeFile,
  updateDisputeFile,
  isDisputeType,
  isDisputeReason,
  isResolutionDecision,
  DISPUTE_TYPES,
  DISPUTE_REASONS,
  DISPUTE_REASON_DESCRIPTIONS,
  DEFAULT_TIMEOUT_DAYS,
  type DisputeType,
  type DisputeReason,
} from '../disputes/index.js';
import { generateHelp } from '../cli/help.js';

const HELP = generateHelp({
  command: 'dispute',
  description: 'Manage coder/reviewer disputes',
  details: `Create, view, and resolve disputes when coder and reviewer disagree.
Disputes can be major (blocking) or minor (logged for reference).
Use this when automation needs human decision on architectural or approach disagreements.`,
  usage: [
    'steroids dispute [options]',
    'steroids dispute <subcommand> [args] [options]',
  ],
  subcommands: [
    { name: '(default)', description: 'List open disputes' },
    { name: 'list', description: 'List disputes with filters' },
    { name: 'create', args: '<task-id>', description: 'Create a new dispute' },
    { name: 'show', args: '<id>', description: 'Show dispute details' },
    { name: 'resolve', args: '<id>', description: 'Resolve a dispute' },
    { name: 'log', args: '<task-id>', description: 'Log minor disagreement without blocking' },
  ],
  options: [
    { long: 'reason', description: 'Dispute reason (create)', values: 'architecture | specification | approach | requirements | style | security | scope | other' },
    { long: 'type', description: 'Dispute type (create)', values: 'major | minor | coder | reviewer', default: 'coder' },
    { long: 'position', description: 'Your position/argument (create)', values: '<text>' },
    { long: 'model', description: 'Model identifier (create)', values: '<model>' },
    { long: 'stale', description: 'Show only stale disputes (list)' },
    { long: 'all', description: 'Include resolved disputes (list)' },
    { long: 'status', description: 'Filter by status (list)', values: 'open | resolved | all' },
    { long: 'decision', description: 'Resolution decision (resolve)', values: 'coder | reviewer | custom' },
    { long: 'notes', description: 'Notes or comments', values: '<text>' },
    { long: 'minor', description: 'Log as minor disagreement (log)' },
  ],
  examples: [
    { command: 'steroids dispute', description: 'List open disputes' },
    { command: 'steroids dispute list --stale', description: 'Show disputes older than timeout' },
    { command: 'steroids dispute create abc123 --type coder --reason architecture --position "JWT is better"', description: 'Create coder dispute' },
    { command: 'steroids dispute show abc123', description: 'View dispute details' },
    { command: 'steroids dispute resolve abc123 --decision coder --notes "JWT is acceptable"', description: 'Resolve in favor of coder' },
    { command: 'steroids dispute log abc123 --minor --notes "Style preference logged"', description: 'Log minor disagreement' },
  ],
  related: [
    { command: 'steroids tasks', description: 'Manage tasks' },
    { command: 'steroids loop', description: 'Run automated development loop' },
  ],
  sections: [
    {
      title: 'DISPUTE TYPES',
      content: `major     Serious disagreement, can block loop if configured
minor     Logged disagreement, continues with coder's implementation
coder     Coder disputes reviewer's rejection
reviewer  Reviewer raises concern`,
    },
    {
      title: 'DISPUTE REASONS',
      content: `architecture   Architectural disagreement
specification  Spec ambiguity or conflict
approach       Different valid approaches
requirements   Unclear requirements
style          Style/convention disagreement
security       Security concern
scope          Scope disagreement
other          Other reason (custom text)`,
    },
  ],
});

export async function disputeCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag first
  if (flags.help) {
    console.log(HELP);
    return;
  }

  if (args.length === 0) {
    // Default: list open disputes
    await listDisputes([], flags);
    return;
  }

  const subcommand = args[0];

  if (subcommand.startsWith('-')) {
    // It's a flag, so this is a list command
    await listDisputes(args, flags);
    return;
  }

  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'create':
      await createDisputeCmd(subArgs, flags);
      break;
    case 'list':
      await listDisputes(subArgs, flags);
      break;
    case 'show':
      await showDispute(subArgs, flags);
      break;
    case 'resolve':
      await resolveDisputeCmd(subArgs, flags);
      break;
    case 'log':
      await logDisputeCmd(subArgs, flags);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function createDisputeCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      reason: { type: 'string' },
      type: { type: 'string', default: 'coder' },
      position: { type: 'string' },
      model: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
steroids dispute create <task-id> - Create a new dispute

USAGE:
  steroids dispute create <task-id> [options]

OPTIONS:
  --reason <reason>   Reason (required): ${DISPUTE_REASONS.join(', ')}
  --type <type>       Type: ${DISPUTE_TYPES.join(', ')} (default: coder)
  --position <text>   Your position/argument (required)
  --model <model>     Model that raised the dispute
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  if (positionals.length === 0) {
    console.error('Error: task ID required');
    console.error('Usage: steroids dispute create <task-id> --reason <reason> --position <text>');
    process.exit(2);
  }

  if (!values.reason) {
    console.error('Error: --reason required');
    console.error(`Valid reasons: ${DISPUTE_REASONS.join(', ')}`);
    process.exit(2);
  }

  if (!values.position) {
    console.error('Error: --position required');
    console.error('Provide your position/argument for the dispute.');
    process.exit(2);
  }

  const taskIdentifier = positionals[0];
  const disputeType = values.type as string;

  if (!isDisputeType(disputeType)) {
    console.error(`Error: invalid type "${disputeType}"`);
    console.error(`Valid types: ${DISPUTE_TYPES.join(', ')}`);
    process.exit(2);
  }

  const { db, close } = openDatabase();
  try {
    // Find task by ID or title
    let task = getTask(db, taskIdentifier);
    if (!task) {
      task = getTaskByTitle(db, taskIdentifier);
    }

    if (!task) {
      console.error(`Task not found: ${taskIdentifier}`);
      process.exit(1);
    }

    const createdBy = values.model ? `model:${values.model}` : 'human:cli';

    const result = createDispute(db, {
      taskId: task.id,
      type: disputeType as DisputeType,
      reason: values.reason,
      position: values.position,
      createdBy,
    });

    if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    // Update dispute.md
    updateDisputeFile(db);

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Dispute created: ${result.disputeId.substring(0, 8)}`);
      console.log(`  Task: ${task.title}`);
      console.log(`  Type: ${disputeType}`);
      console.log(`  Reason: ${values.reason}`);
      if (result.taskStatusUpdated) {
        console.log(`  Task status: disputed`);
      }
      console.log('');
      console.log('dispute.md has been updated.');
    }
  } finally {
    close();
  }
}

async function listDisputes(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      stale: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      status: { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`
steroids dispute list - List disputes

USAGE:
  steroids dispute list [options]

OPTIONS:
  --stale             Show only stale disputes (open > ${DEFAULT_TIMEOUT_DAYS} days)
  --all               Include resolved disputes
  --status <status>   Filter: open, resolved, all
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const { db, close } = openDatabase();
  try {
    if (values.stale) {
      // Show stale disputes
      const summary = getStaleDisputeSummary(db, DEFAULT_TIMEOUT_DAYS);
      console.log(summary);
      return;
    }

    const status = values.all ? 'all' : (values.status as 'open' | 'resolved' | 'all') ?? 'open';
    const disputes = listDisputesWithTasks(db, { status });

    if (values.json) {
      console.log(JSON.stringify(disputes, null, 2));
      return;
    }

    if (disputes.length === 0) {
      console.log(`No ${status === 'all' ? '' : status + ' '}disputes found.`);
      return;
    }

    console.log('DISPUTES');
    console.log('-'.repeat(90));
    console.log('ID         TASK                                     TYPE      STATUS     REASON');
    console.log('-'.repeat(90));

    for (const dispute of disputes) {
      const shortId = dispute.id.substring(0, 8);
      const taskTitle = dispute.task_title.length > 40
        ? dispute.task_title.substring(0, 37) + '...'
        : dispute.task_title.padEnd(40);
      const type = dispute.type.padEnd(9);
      const status = dispute.status.padEnd(10);
      const reason = dispute.reason.length > 15
        ? dispute.reason.substring(0, 12) + '...'
        : dispute.reason;

      console.log(`${shortId}   ${taskTitle} ${type} ${status} ${reason}`);
    }

    console.log('-'.repeat(90));
    console.log(`Total: ${disputes.length} disputes`);
  } finally {
    close();
  }
}

async function showDispute(args: string[], flags: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids dispute show <id> - Show dispute details

USAGE:
  steroids dispute show <id> [options]

OPTIONS:
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  const disputeId = positionals[0];

  const { db, close } = openDatabase();
  try {
    const dispute = getDispute(db, disputeId);

    if (!dispute) {
      console.error(`Dispute not found: ${disputeId}`);
      process.exit(1);
    }

    const task = getTask(db, dispute.task_id);

    if (values.json) {
      console.log(JSON.stringify({ dispute, task }, null, 2));
      return;
    }

    console.log('DISPUTE DETAILS');
    console.log('='.repeat(60));
    console.log(`ID:            ${dispute.id}`);
    console.log(`Status:        ${dispute.status.toUpperCase()}`);
    console.log(`Type:          ${dispute.type}`);
    console.log(`Reason:        ${dispute.reason}`);
    console.log('');
    console.log(`Task:          ${task?.title ?? 'Unknown'}`);
    console.log(`Task ID:       ${dispute.task_id}`);
    console.log(`Task Status:   ${task?.status ?? 'Unknown'}`);
    console.log('');
    console.log(`Created By:    ${dispute.created_by}`);
    console.log(`Created At:    ${dispute.created_at} (${formatDisputeAge(dispute)})`);
    console.log('');

    if (dispute.coder_position) {
      console.log('CODER POSITION:');
      console.log('-'.repeat(60));
      console.log(dispute.coder_position);
      console.log('');
    }

    if (dispute.reviewer_position) {
      console.log('REVIEWER POSITION:');
      console.log('-'.repeat(60));
      console.log(dispute.reviewer_position);
      console.log('');
    }

    if (dispute.status === 'resolved') {
      console.log('RESOLUTION:');
      console.log('-'.repeat(60));
      console.log(`Decision:      ${dispute.resolution}`);
      console.log(`Resolved By:   ${dispute.resolved_by ?? 'Unknown'}`);
      console.log(`Resolved At:   ${dispute.resolved_at ?? 'Unknown'}`);
      if (dispute.resolution_notes) {
        console.log(`Notes:         ${dispute.resolution_notes}`);
      }
    } else {
      console.log('STATUS: AWAITING HUMAN DECISION');
      console.log('-'.repeat(60));
      console.log(`Run: steroids dispute resolve ${dispute.id.substring(0, 8)} --decision <coder|reviewer>`);
    }
  } finally {
    close();
  }
}

async function resolveDisputeCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      decision: { type: 'string' },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids dispute resolve <id> - Resolve a dispute

USAGE:
  steroids dispute resolve <id> [options]

OPTIONS:
  --decision <decision>  Who wins: coder, reviewer, custom (required)
  --notes <text>         Resolution notes
  -j, --json             Output as JSON
  -h, --help             Show help

EXAMPLES:
  steroids dispute resolve abc123 --decision coder --notes "JWT is acceptable"
  steroids dispute resolve abc123 --decision reviewer --notes "Security is priority"
`);
    return;
  }

  if (!values.decision) {
    console.error('Error: --decision required');
    console.error('Valid decisions: coder, reviewer, custom');
    process.exit(2);
  }

  if (!isResolutionDecision(values.decision)) {
    console.error(`Error: invalid decision "${values.decision}"`);
    console.error('Valid decisions: coder, reviewer, custom');
    process.exit(2);
  }

  const disputeId = positionals[0];

  const { db, close } = openDatabase();
  try {
    const result = resolve(db, {
      disputeId,
      decision: values.decision,
      resolvedBy: 'human:cli',
      notes: values.notes,
    });

    if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    // Update dispute.md
    updateDisputeFile(db);

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Dispute resolved: ${result.disputeId.substring(0, 8)}`);
      console.log(`  Decision: ${result.decision}`);
      console.log(`  Task status: ${result.taskNewStatus}`);
      console.log('');
      console.log('dispute.md has been updated.');
    }
  } finally {
    close();
  }
}

async function logDisputeCmd(args: string[], flags: GlobalFlags): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
      minor: { type: 'boolean', default: false },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`
steroids dispute log <task-id> - Log minor disagreement

USAGE:
  steroids dispute log <task-id> [options]

OPTIONS:
  --minor             Log as minor disagreement (doesn't change task status)
  --notes <text>      Disagreement notes (required)
  -j, --json          Output as JSON
  -h, --help          Show help

EXAMPLES:
  steroids dispute log abc123 --minor --notes "Preferred camelCase but used snake_case"
`);
    return;
  }

  if (!values.notes) {
    console.error('Error: --notes required');
    console.error('Provide a description of the disagreement.');
    process.exit(2);
  }

  const taskIdentifier = positionals[0];

  const { db, close } = openDatabase();
  try {
    // Find task by ID or title
    let task = getTask(db, taskIdentifier);
    if (!task) {
      task = getTaskByTitle(db, taskIdentifier);
    }

    if (!task) {
      console.error(`Task not found: ${taskIdentifier}`);
      process.exit(1);
    }

    const result = logMinorDisagreement(db, task.id, values.notes, 'human:cli');

    if (!result.success) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }

    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Minor disagreement logged: ${result.disputeId.substring(0, 8)}`);
      console.log(`  Task: ${task.title}`);
      console.log(`  Notes: ${values.notes}`);
      console.log('');
      console.log('Task status unchanged. Work continues.');
    }
  } finally {
    close();
  }
}
