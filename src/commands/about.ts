/**
 * About Command
 * Explains what Steroids is for LLMs discovering the tool
 */

import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { generateHelp } from '../cli/help.js';

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

PROJECT SETUP - HOW TO STRUCTURE WORK
-------------------------------------
Steroids works best when projects are structured correctly. Think of it like
building a house: sections are rooms, tasks are individual construction steps.

SECTIONS = Features or Functional Areas
  - Each section represents ONE cohesive piece of functionality
  - Sections should be independent enough to be worked on in isolation
  - Name sections clearly: "Phase 1: User Authentication", "Phase 2: Dashboard"
  - Sections have priorities and can depend on other sections

TASKS = Small, Atomic Implementation Steps
  - Each task should be completable in ONE focused session (15-60 min of AI work)
  - Tasks should do ONE thing well - if you say "and" you might need two tasks
  - Tasks must have a clear specification file explaining exactly what to build
  - Tasks are ordered within sections - earlier tasks may set up later ones

EXAMPLE FROM THIS PROJECT (steroids-cli):
  Section: "Phase 0.7: Section Focus"
  Tasks:
    1. Add --section flag to loop command
    2. Add sectionId parameter to TaskSelectionOptions
    3. Update task selection queries to filter by section
    4. Update loop display to show focused section
    5. Add section validation

  Each task is small and specific. Together they implement "section focus."

WRITING GOOD SPECIFICATIONS:
  - Create a specs/ directory with markdown files
  - Each spec should include: purpose, requirements, examples, edge cases
  - Reference existing code patterns the implementation should follow
  - Include acceptance criteria - how do we know it's done?

EXAMPLE SPEC STRUCTURE (specs/feature-name.md):
  # Feature Name

  ## Overview
  What this feature does and why.

  ## Requirements
  - Specific requirement 1
  - Specific requirement 2

  ## Implementation Notes
  - Follow pattern in src/existing/similar.ts
  - Use existing utility from src/utils/helper.ts

  ## Examples
  \`\`\`bash
  steroids command --flag value
  # Expected output...
  \`\`\`

  ## Acceptance Criteria
  - [ ] Command works as shown in examples
  - [ ] Tests pass
  - [ ] Documentation updated

ADDING TASKS
-----------
steroids tasks add <title> --section <id> --source <spec-file> [options]

Required:
  --section <id>    Section the task belongs to
  --source <file>   Specification markdown file for the coder/reviewer

Optional:
  --file <path>     Anchor task to a specific file (must be committed in git)
  --line <number>   Line number in the anchored file (requires --file)
  --feedback        Add to "Needs User Input" section (skips --section/--source)

When --file is used, Steroids validates the file is tracked and clean in git,
then auto-captures the commit SHA and content hash. The coder/reviewer prompts
will reference this exact file location.

When --feedback is used, the task goes to a special skipped section called
"Needs User Input" that the runner ignores. Use for advisory items, disputes,
or anything needing human review.

Examples:
  steroids tasks add "Implement login" --section abc123 --source specs/login.md
  steroids tasks add "Fix null check" --section abc123 --source spec.md --file src/utils.ts --line 42
  steroids tasks add "Review execSync usage" --feedback

INITIALIZING A PROJECT:
  1. steroids init                    # Creates .steroids/ directory
  2. Create specs/ with your specifications
  3. steroids sections add "Phase 1: Feature Name"
  4. steroids tasks add "Task title" --section <id> --source specs/spec.md
  5. steroids loop                    # Start processing

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

const HELP = generateHelp({
  command: 'about',
  description: 'Explains what Steroids is and how it works',
  details: `Designed for LLMs discovering this tool for the first time.
Provides comprehensive overview of architecture, workflow, and best practices.
Use --json for structured output optimized for LLM parsing.`,
  usage: ['steroids about [options]'],
  examples: [
    { command: 'steroids about', description: 'Human-readable explanation' },
    { command: 'steroids about --json', description: 'Structured JSON for LLM parsing' },
  ],
  related: [
    { command: 'steroids llm', description: 'Compact quick reference when context is lost' },
    { command: 'steroids --help', description: 'CLI help with all commands' },
  ],
  showGlobalOptions: true,
  showExitCodes: false,
  showEnvVars: false,
});

interface AboutOutput {
  name: string;
  description: string;
  version: string;
  concept: {
    roles: { name: string; purpose: string }[];
    workflow: string[];
    lifecycle: string[];
  };
  projectSetup: {
    sections: string;
    tasks: string;
    specifications: string;
    example: {
      section: string;
      tasks: string[];
    };
    steps: string[];
  };
  commands: { command: string; description: string }[];
  rules: string[];
}

export async function aboutCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'about', flags });

  if (flags.help) {
    out.log(HELP);
    return;
  }

  const data: AboutOutput = {
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
    projectSetup: {
      sections: 'Features or functional areas - each represents ONE cohesive piece of functionality',
      tasks: 'Small, atomic implementation steps - completable in 15-60 min, does ONE thing well',
      specifications: 'Markdown files in specs/ with purpose, requirements, examples, acceptance criteria',
      example: {
        section: 'Phase 0.7: Section Focus',
        tasks: [
          'Add --section flag to loop command',
          'Add sectionId parameter to TaskSelectionOptions',
          'Update task selection queries to filter by section',
          'Update loop display to show focused section',
          'Add section validation',
        ],
      },
      steps: [
        'steroids init - creates .steroids/ directory',
        'Create specs/ with your specifications',
        'steroids sections add "Phase 1: Feature Name"',
        'steroids tasks add "Task title" --section <id> --source specs/spec.md',
        'steroids tasks add "Task title" --section <id> --source spec.md --file src/foo.ts --line 42  (anchor to file)',
        'steroids tasks add "Advisory note" --feedback  (skipped section for human review)',
        'steroids loop - start processing',
      ],
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

  if (flags.json) {
    out.success(data);
  } else {
    out.log(ABOUT_TEXT);
  }
}
