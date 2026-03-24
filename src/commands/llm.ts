/**
 * steroids llm - Compact instructions for LLM agents
 * Call this when context is lost to quickly understand the system
 */

import type { GlobalFlags } from '../cli/flags.js';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { getRegisteredProjects } from '../runners/projects.js';
import { listRunners } from '../runners/daemon.js';
import { openDatabase, withDatabase } from '../database/connection.js';
import { listTasks } from '../database/queries.js';
import { generateHelp } from '../cli/help.js';
import { createOutput } from '../cli/output.js';
import { LLM_INSTRUCTIONS } from './llm-content.js';

const HELP = generateHelp({
  command: 'llm',
  description: 'Quick reference for LLM agents (alias: steroids about)',
  details: 'Complete reference guide for AI agents working with Steroids. Shows key commands, task flow, bug-intake concepts, project setup, and current context.',
  usage: [
    'steroids llm',
    'steroids llm --context',
    'steroids llm --json',
    'steroids about            # alias for steroids llm',
  ],
  options: [
    { long: 'context', description: 'Include current project context (projects, runners, tasks)' },
    { short: 'j', long: 'json', description: 'Output structured JSON for LLM parsing' },
  ],
  examples: [
    { command: 'steroids llm', description: 'Show LLM quick reference' },
    { command: 'steroids llm --context', description: 'Show reference with current context' },
    { command: 'steroids about --json', description: 'Structured JSON output' },
  ],
  related: [
    { command: 'steroids tasks', description: 'Manage tasks' },
    { command: 'steroids sections', description: 'Manage sections' },
    { command: 'steroids config', description: 'Inspect intake connector settings' },
    { command: 'steroids hooks', description: 'Inspect intake hook automation' },
    { command: 'steroids runners wakeup', description: 'Poll intake connectors and restart stale runners' },
  ],
  showGlobalOptions: false,
  showEnvVars: false,
  showExitCodes: false,
});

export async function llmCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'llm', flags });

  // Check for help
  if (flags.help || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    return;
  }

  // JSON output mode
  if (flags.json) {
    out.success({
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
        intake: {
          connectors: ['github'],
          unsupportedConfiguredConnectors: ['sentry'],
          reportStatuses: ['open', 'triaged', 'in_progress', 'resolved', 'ignored'],
          hookEvents: ['intake.received', 'intake.triaged', 'intake.pr_created'],
          taskPrefixes: [
            'Triage intake report',
            'Reproduce intake report',
            'Fix intake report',
          ],
        },
      },
      taskSizing: 'PR-sized chunks — whole testable pieces of functionality, not individual classes',
      projectSetup: {
        sections: 'Features or functional areas — each represents ONE cohesive piece of functionality',
        tasks: 'PR-sized implementation units — reviewable, testable units of work',
        specifications: 'Markdown files in specs/ with purpose, requirements, examples, acceptance criteria',
      },
      commands: [
        { command: 'steroids init -y', description: 'Initialize new project (non-interactive; -y required for LLM agents)' },
        { command: 'steroids tasks list', description: 'List pending tasks' },
        { command: 'steroids tasks list --status all', description: 'Show all tasks' },
        { command: 'steroids sections list', description: 'Show task sections' },
        { command: 'steroids config show intake', description: 'Inspect merged bug-intake configuration' },
        { command: 'steroids config schema intake', description: 'Show intake JSON Schema' },
        { command: 'steroids hooks list --event intake.received', description: 'List hooks for first-seen intake reports' },
        { command: 'steroids runners wakeup', description: 'Poll due connectors and sync GitHub intake approvals' },
        { command: 'steroids web', description: 'Open the dashboard intake views' },
        { command: 'steroids tasks approve <id>', description: 'Approve as reviewer' },
        { command: 'steroids tasks reject <id> --notes "..."', description: 'Reject with feedback' },
      ],
      rules: [
        'Always run build AND tests before submitting for review',
        'Read the task specification thoroughly before implementing',
        'Make small, focused commits',
        'Never modify code outside the task scope',
        'If stuck, create a dispute rather than guessing',
      ],
    });
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

    // Global active tasks
    console.log('');
    console.log('Active tasks (all projects):');
    try {
      const projects = getRegisteredProjects(false);
      let totalActive = 0;
      for (const project of projects) {
        const dbPath = `${project.path}/.steroids/steroids.db`;
        if (!existsSync(dbPath)) continue;

        try {
          /* REFACTOR_MANUAL */ withDatabase(project.path, (db: any) => {
            const inProgress = listTasks(db, { status: 'in_progress' });
            const review = listTasks(db, { status: 'review' });
            const active = [...inProgress, ...review];
            const projName = project.name || basename(project.path);

            for (const task of active) {
              totalActive++;
              const status = task.status === 'in_progress' ? 'CODING' : 'REVIEW';
              console.log(`  [${status}] ${projName}: ${task.title.slice(0,50)} (${task.id.slice(0,8)})`);
            }
          });
        } catch {
          // Skip inaccessible projects
        }
      }
      if (totalActive === 0) {
        console.log('  (none)');
      }
    } catch {
      console.log('  (unknown)');
    }

    // Skipped tasks requiring manual action
    console.log('');
    console.log('Skipped tasks (need manual action):');
    try {
      const projects = getRegisteredProjects(false);
      let totalSkipped = 0;
      for (const project of projects) {
        const dbPath = `${project.path}/.steroids/steroids.db`;
        if (!existsSync(dbPath)) continue;

        try {
          /* REFACTOR_MANUAL */ withDatabase(project.path, (db: any) => {
            const skipped = listTasks(db, { status: 'skipped' });
            const partial = listTasks(db, { status: 'partial' });
            const allSkipped = [...skipped, ...partial];
            const projName = project.name || basename(project.path);

            for (const task of allSkipped) {
              totalSkipped++;
              const marker = task.status === 'skipped' ? '[S]' : '[s]';
              console.log(`  ${marker} ${projName}: ${task.title.slice(0,50)} (${task.id.slice(0,8)})`);
            }
          });
        } catch {
          // Skip inaccessible projects
        }
      }
      if (totalSkipped === 0) {
        console.log('  (none - all tasks are automated)');
      } else {
        console.log('');
        console.log('  [S] = Fully external (human must do entire task)');
        console.log('  [s] = Partial (some coded, rest needs human)');
        console.log('  Use: steroids tasks audit <id> to see what action is needed');
      }
    } catch {
      console.log('  (unknown)');
    }

    console.log('');
  }
}
