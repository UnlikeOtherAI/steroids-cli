/**
 * About Command
 * Explains what Steroids is for LLMs discovering the tool
 */

const ABOUT_TEXT = `
STEROIDS - Automated Task Execution System
===========================================

Steroids is an AI-powered task orchestration system that manages software
development tasks through a coder/reviewer loop. It enables LLMs to work
autonomously on codebases while maintaining quality through automated review.

CORE CONCEPT
------------
Tasks are organized into sections and processed by two AI roles:

1. CODER: Implements tasks by writing code, running builds, and tests
2. REVIEWER: Reviews completed work, approves or rejects with feedback

When rejected, tasks return to the coder with notes. This loop continues
until approval or a dispute is raised (after 15 rejections).

HOW IT WORKS
------------
1. Human creates tasks with specifications in markdown files
2. Runner daemon picks up pending tasks in priority order
3. Coder AI implements the task following the specification
4. Reviewer AI evaluates the implementation
5. On approval: task marked complete, next task starts
6. On rejection: task returns to coder with feedback
7. After 15 rejections: dispute raised for human resolution

KEY COMMANDS FOR LLMs
---------------------
steroids tasks list              List pending tasks
steroids tasks list --status all Show all tasks with status
steroids sections list           Show task sections
steroids tasks update <id> --status review   Submit work for review
steroids tasks approve <id>      Approve as reviewer
steroids tasks reject <id> --notes "..."     Reject with feedback
steroids dispute create          Raise a dispute

TASK LIFECYCLE
--------------
pending -> in_progress -> review -> completed
                  ^          |
                  |          v (rejected)
                  +----------+

SPECIFICATIONS
--------------
Each task has a sourceFile pointing to a markdown specification.
The coder MUST follow this specification exactly.
The reviewer MUST verify the implementation matches the spec.

IMPORTANT RULES
---------------
- Always run build AND tests before submitting for review
- Read the task specification thoroughly before implementing
- Make small, focused commits
- Never modify code outside the task scope
- If stuck, create a dispute rather than guessing

For full documentation:
- CLI: steroids --help
- Tasks: steroids tasks --help
- Config: steroids config show
`;

const HELP = `
Usage: steroids about [options]

Explains what Steroids is and how it works, designed for LLMs
that are discovering this tool for the first time.

Options:
  -j, --json    Output as JSON (structured for LLM parsing)
  -h, --help    Show this help

Examples:
  steroids about              # Human-readable explanation
  steroids about --json       # Structured JSON for LLM parsing
`;

interface AboutOutput {
  name: string;
  description: string;
  version: string;
  concept: {
    roles: { name: string; purpose: string }[];
    workflow: string[];
    lifecycle: string[];
  };
  commands: { command: string; description: string }[];
  rules: string[];
}

export async function aboutCommand(args: string[]): Promise<void> {
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  if (args.includes('-j') || args.includes('--json')) {
    const output: AboutOutput = {
      name: 'Steroids',
      description: 'AI-powered task orchestration with coder/reviewer loop',
      version: process.env.npm_package_version ?? '0.0.0',
      concept: {
        roles: [
          { name: 'coder', purpose: 'Implements tasks by writing code, running builds and tests' },
          { name: 'reviewer', purpose: 'Reviews completed work, approves or rejects with feedback' },
        ],
        workflow: [
          'Human creates tasks with specifications',
          'Runner picks up pending tasks',
          'Coder implements following specification',
          'Reviewer evaluates implementation',
          'Approved: task complete, next starts',
          'Rejected: returns to coder with notes',
          'After 15 rejections: dispute raised',
        ],
        lifecycle: ['pending', 'in_progress', 'review', 'completed'],
      },
      commands: [
        { command: 'steroids tasks list', description: 'List pending tasks' },
        { command: 'steroids tasks list --status all', description: 'Show all tasks' },
        { command: 'steroids sections list', description: 'Show task sections' },
        { command: 'steroids tasks update <id> --status review', description: 'Submit for review' },
        { command: 'steroids tasks approve <id>', description: 'Approve as reviewer' },
        { command: 'steroids tasks reject <id> --notes "..."', description: 'Reject with feedback' },
        { command: 'steroids dispute create', description: 'Raise a dispute' },
      ],
      rules: [
        'Always run build AND tests before submitting for review',
        'Read the task specification thoroughly before implementing',
        'Make small, focused commits',
        'Never modify code outside the task scope',
        'If stuck, create a dispute rather than guessing',
      ],
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(ABOUT_TEXT);
}
