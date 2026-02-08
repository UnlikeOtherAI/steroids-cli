/**
 * steroids llm - Compact instructions for LLM agents
 * Call this when context is lost to quickly understand the system
 */

import type { GlobalFlags } from '../cli/flags.js';
import { getRegisteredProjects } from '../runners/projects.js';
import { listRunners } from '../runners/daemon.js';

const LLM_INSTRUCTIONS = `# STEROIDS LLM QUICK REFERENCE

## SYSTEM OVERVIEW
Steroids=automated task execution with coder/reviewer loop.
Tasks: pending→in_progress(coder)→review(reviewer)→completed|rejected→pending
One runner per project. Multiple projects can run in parallel.

## YOUR ROLE
You are either CODER or REVIEWER (check task status).
CODER: implement task per spec, commit, submit for review.
REVIEWER: verify implementation matches spec, approve or reject.

## CRITICAL RULES
1. ONLY work on YOUR project (check current directory)
2. NEVER modify files in other projects
3. Read task spec before coding: steroids tasks audit <id>
4. Commit after completing work
5. Submit for review: steroids tasks update <id> --status review --actor model --model <your-model>

## KEY COMMANDS

### Tasks
steroids tasks                          # list pending (local)
steroids tasks --status active          # in_progress+review (local)
steroids tasks --status active --global # active across ALL projects
steroids tasks --status all             # all tasks
steroids tasks audit <id>               # view task spec+history

### Task Actions (CODER)
steroids tasks update <id> --status in_progress --actor model --model <m>
steroids tasks update <id> --status review --actor model --model <m>

### Task Actions (REVIEWER)
steroids tasks approve <id> --model <m>                    # approve
steroids tasks approve <id> --model <m> --notes "msg"      # approve with note
steroids tasks reject <id> --model <m> --notes "feedback"  # reject (be specific)

### Sections
steroids sections list                  # list sections (local project)
steroids sections skip <id>             # skip section
steroids sections unskip <id>           # unskip

### Runners
steroids runners list                   # all runners (all projects)
steroids runners start --detach         # start background runner
steroids runners start --section "X"    # focus on section
steroids runners stop --all             # stop all runners
steroids runners status                 # current runner status

### Projects
steroids projects list                  # all registered projects

## TASK LIFECYCLE
1. Pick task: steroids tasks (shows pending)
2. Claim: steroids tasks update <id> --status in_progress --actor model --model <m>
3. Read spec: steroids tasks audit <id>
4. Implement (write code, run tests)
5. Commit changes
6. Submit: steroids tasks update <id> --status review --actor model --model <m>

## REVIEW LIFECYCLE
1. Check review queue: steroids tasks --status review
2. Read spec: steroids tasks audit <id>
3. Verify implementation matches spec
4. Decision:
   - APPROVE: steroids tasks approve <id> --model <m>
   - REJECT: steroids tasks reject <id> --model <m> --notes "specific feedback"

## REJECTION RULES
- Be SPECIFIC in rejection notes (coder needs to fix)
- Max 15 rejections per task, then requires human intervention
- Don't reject for style preferences if it works

## MULTI-PROJECT SAFETY
- Check project: pwd (or see header in task listings)
- Each project has separate database in .steroids/steroids.db
- Runner is bound to ONE project
- NEVER cd to another project and modify files
`;

export async function llmCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check for help
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`
steroids llm - Compact instructions for LLM agents

USAGE:
  steroids llm              # Show LLM instructions
  steroids llm --context    # Include current context (project, runners, tasks)

OPTIONS:
  --context    Include current project context
  -h, --help   Show this help
`);
    return;
  }

  const includeContext = args.includes('--context');

  // Always print instructions
  console.log(LLM_INSTRUCTIONS);

  // Optionally include current context
  if (includeContext) {
    console.log('## CURRENT CONTEXT\n');

    // Current project
    console.log(`Project: ${process.cwd()}`);

    // Registered projects
    try {
      const projects = getRegisteredProjects(false);
      console.log(`Registered projects: ${projects.length}`);
      if (projects.length > 1) {
        console.log('WARNING: Multi-project environment. Only work on YOUR project.');
      }
    } catch {
      console.log('Registered projects: unknown');
    }

    // Active runners
    try {
      const runners = listRunners();
      const activeRunners = runners.filter(r => r.status === 'running');
      console.log(`Active runners: ${activeRunners.length}`);
      for (const r of activeRunners) {
        const proj = r.project_path ? r.project_path.split('/').pop() : 'unknown';
        console.log(`  - ${r.id.slice(0,8)} on ${proj} (PID ${r.pid})`);
      }
    } catch {
      console.log('Active runners: unknown');
    }

    console.log('');
  }
}
