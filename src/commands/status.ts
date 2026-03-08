/**
 * steroids status - Comprehensive project status overview
 */

import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { colors } from '../cli/colors.js';
import { getRegisteredProjects } from '../runners/projects.js';
import { listRunners } from '../runners/daemon.js';
import { existsSync } from 'node:fs';
import { withDatabase } from '../database/connection.js';
import { listTasks, listSections } from '../database/queries.js';
import { generateHelp } from '../cli/help.js';

const HELP = generateHelp({
  command: 'status',
  description: 'Comprehensive project status overview',
  details: `Shows a comprehensive overview of the current project including tasks, sections, runners, and system status.
This command provides a quick snapshot of what's happening in your Steroids project.`,
  usage: [
    'steroids status [options]',
    'steroids status --json',
  ],
  options: [
    { long: 'json', description: 'Output structured JSON for programmatic consumption' },
  ],
  examples: [
    { command: 'steroids status', description: 'Show human-readable status overview' },
    { command: 'steroids status --json', description: 'Show structured JSON status' },
  ],
  related: [
    { command: 'steroids tasks', description: 'Manage tasks' },
    { command: 'steroids sections', description: 'Manage sections' },
    { command: 'steroids runners', description: 'Manage runners' },
  ],
});

export async function statusCommand(
  args: string[],
  flags: GlobalFlags
): Promise<void> {
  const out = createOutput({ command: 'status', flags });

  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      json: { type: 'boolean', short: 'j', default: false },
    },
    allowPositionals: true,
  });

  if (values.help || flags.help) {
    out.log(HELP);
    return;
  }

  // JSON output mode
  if (values.json) {
    const statusData = await getStatusJson();
    out.success(statusData);
    return;
  }

  // Human-readable output
  await getStatusHumanReadable(out);
}

async function getStatusJson(): Promise<any> {
  const projects = getRegisteredProjects(false);
  const runners = listRunners();
  const activeRunners = runners.filter(r => r.status === 'running');

  const projectData = [];
  for (const project of projects) {
    const dbPath = `${project.path}/.steroids/steroids.db`;
    if (!existsSync(dbPath)) {
      continue;
    }

    try {
      const projectInfo: any = {
        path: project.path,
        name: project.name || basename(project.path),
        enabled: project.enabled,
        runners: [],
        sections: [],
        tasks: {
          total: 0,
          byStatus: {
            pending: 0,
            in_progress: 0,
            review: 0,
            completed: 0,
            disputed: 0,
            failed: 0,
            skipped: 0,
            partial: 0,
          },
        },
      };

      // Get runner info for this project
      const projectRunners = runners.filter(r => r.project_path === project.path);
      projectInfo.runners = projectRunners.map(r => ({
        id: r.id,
        pid: r.pid,
        status: r.status,
        startedAt: r.started_at,
        heartbeatAt: r.heartbeat_at,
      }));

      // Get database info
      /* REFACTOR_MANUAL */ withDatabase(project.path, (db: any) => {
        // Get sections
        const sections = listSections(db);
        projectInfo.sections = sections.map(s => ({
          id: s.id,
          name: s.name,
          branch: s.branch,
          priority: s.priority,
          skipped: s.skipped,
          createdAt: s.created_at,
        }));

        // Get tasks by status
        const allTasks = listTasks(db);
        projectInfo.tasks.total = allTasks.length;
        
        for (const task of allTasks) {
          const status = task.status as keyof typeof projectInfo.tasks.byStatus;
          if (projectInfo.tasks.byStatus[status] !== undefined) {
            projectInfo.tasks.byStatus[status]++;
          }
        }
      });

      projectData.push(projectInfo);
    } catch (error) {
      // Skip inaccessible projects
      console.error(`Error accessing project ${project.path}: ${(error as Error).message}`);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    projects: projectData,
    system: {
      activeRunners: activeRunners.length,
      totalProjects: projects.length,
    },
  };
}

async function getStatusHumanReadable(out: ReturnType<typeof createOutput>): Promise<void> {
  const projects = getRegisteredProjects(false);
  const runners = listRunners();
  const activeRunners = runners.filter(r => r.status === 'running');

  out.log('');
  out.log(colors.bold('STEROIDS PROJECT STATUS'));
  out.log('');

  // Basic system overview
  out.log(`Active runners: ${activeRunners.length}`);
  out.log(`Registered projects: ${projects.length}`);
  out.log('');

  // Project-by-project status
  if (projects.length === 0) {
    out.log(colors.dim('No projects registered.'));
    out.log('');
    return;
  }

  for (const project of projects) {
    const dbPath = `${project.path}/.steroids/steroids.db`;
    if (!existsSync(dbPath)) {
      out.log(colors.yellow(`⚠️  ${project.path} (no database)`));
      out.log('');
      continue;
    }

    const projectName = project.name || basename(project.path);

    out.log(colors.cyan(`📋 ${projectName}`));
    out.log(colors.dim(`   Path: ${project.path}`));

    // Get runner info for this project
    const projectRunners = runners.filter(r => r.project_path === project.path);
    if (projectRunners.length > 0) {
      out.log(`   Runners: ${projectRunners.length} active`);
      for (const runner of projectRunners) {
        const statusColor = runner.status === 'running' ? colors.green('RUNNING') : colors.red(runner.status);
        out.log(`     - ${runner.id.slice(0, 8)} ${statusColor} (PID ${runner.pid})`);
      }
    } else {
      out.log('   Runners: none');
    }

    // Get database info
    try {
      /* REFACTOR_MANUAL */ withDatabase(project.path, (db: any) => {
        // Get sections
        const sections = listSections(db);
        if (sections.length > 0) {
          out.log(`   Sections: ${sections.length}`);
          for (const section of sections) {
            const statusSymbol = section.skipped ? '⏸' : '▶';
            const priority = section.priority !== undefined ? 
              (section.priority <= 33 ? colors.red('HIGH') :
               section.priority <= 66 ? colors.yellow('MED') : colors.green('LOW')) :
              colors.dim('N/A');
            out.log(`     ${statusSymbol} ${section.name} (${priority})`);
          }
        } else {
          out.log('   Sections: none');
        }

        // Get tasks by status
        const allTasks = listTasks(db);
        if (allTasks.length > 0) {
          const taskCounts: Record<string, number> = {
            pending: 0,
            in_progress: 0,
            review: 0,
            completed: 0,
            disputed: 0,
            failed: 0,
            skipped: 0,
            partial: 0,
          };

          for (const task of allTasks) {
            const status = task.status;
            if (taskCounts.hasOwnProperty(status)) {
              taskCounts[status]++;
            }
          }

          out.log(`   Tasks: ${allTasks.length} total`);
          for (const [status, count] of Object.entries(taskCounts)) {
            if (count > 0) {
              const symbol = getTaskSymbol(status);
              out.log(`     ${symbol} ${status.replace('_', ' ')}: ${count}`);
            }
          }
        } else {
          out.log('   Tasks: none');
        }
      });
    } catch (error) {
      out.log(colors.red(`   Error accessing database: ${(error as Error).message}`));
    }

    out.log('');
  }

  // System-wide metrics
  if (activeRunners.length > 0) {
    out.log(colors.bold('SYSTEM METRICS'));
    out.log(`Active runners: ${activeRunners.length}`);
    out.log('');
  }
}

function getTaskSymbol(status: string): string {
  switch (status) {
    case 'pending': return '○';
    case 'in_progress': return '●';
    case 'review': return '⟳';
    case 'completed': return '✓';
    case 'disputed': return '!';
    case 'failed': return '✗';
    case 'skipped': return '⊘';
    case 'partial': return '◐';
    default: return '?';
  }
}