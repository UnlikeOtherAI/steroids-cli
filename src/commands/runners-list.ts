import type { GlobalFlags } from '../cli/flags.js';
import { parseArgs } from 'node:util';
import { getRegisteredProjects } from '../runners/projects.js';
import { listRunners, type Runner } from '../runners/daemon.js';
import { openDatabase } from '../database/connection.js';
import {
  getSection,
  getTask,
  listSections,
  listTasks,
  type Task,
} from '../database/queries.js';
import { isProcessAlive } from '../runners/lock.js';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';

export async function runList(args: string[], flags: GlobalFlags): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      tree: { type: 'boolean', short: 't', default: false },
    },
    allowPositionals: false,
  });

  if (values.help || flags.help) {
    console.log(`
steroids runners list - List all runners

USAGE:
  steroids runners list [options]

OPTIONS:
  -t, --tree          Show tree view with tasks
  -j, --json          Output as JSON
  -h, --help          Show help
`);
    return;
  }

  // Tree view mode
  if (values.tree) {
    await runListTree(flags.json);
    return;
  }

  const runners = listRunners();

  if (flags.json) {
    // For JSON output, enrich with section names if available
    const enrichedRunners = runners.map((runner) => {
      if (!runner.section_id || !runner.project_path) {
        return runner;
      }
      try {
        const { db, close } = openDatabase(runner.project_path);
        try {
          const section = getSection(db, runner.section_id);
          return { ...runner, section_name: section?.name };
        } finally {
          close();
        }
      } catch {
        return runner;
      }
    });
    console.log(JSON.stringify({ runners: enrichedRunners }, null, 2));
    return;
  }

  if (runners.length === 0) {
    console.log('No runners registered');
    return;
  }

  console.log('RUNNERS');
  console.log('─'.repeat(120));
  console.log('ID        STATUS      PID       PROJECT                           SECTION                           HEARTBEAT');
  console.log('─'.repeat(120));

  for (const runner of runners) {
    const shortId = runner.id.substring(0, 8);
    const status = runner.status.padEnd(10);
    const pid = (runner.pid?.toString() ?? '-').padEnd(9);
    const project = (runner.project_path ?? '-').substring(0, 30).padEnd(30);

    // Fetch section name if available
    let sectionDisplay = '-';
    if (runner.section_id && runner.project_path) {
      try {
        const { db, close } = openDatabase(runner.project_path);
        try {
          const section = getSection(db, runner.section_id);
          if (section) {
            sectionDisplay = section.name.substring(0, 30);
          }
        } finally {
          close();
        }
      } catch {
        // If we can't fetch the section name, just show the ID prefix
        sectionDisplay = runner.section_id.substring(0, 8);
      }
    }
    const section = sectionDisplay.padEnd(30);

    const heartbeat = runner.heartbeat_at.substring(11, 19);
    const alive = runner.pid && isProcessAlive(runner.pid) ? '' : ' (dead)';
    console.log(`${shortId}  ${status}  ${pid}  ${project}    ${section}    ${heartbeat}${alive}`);
  }

  // Check if there are multiple projects
  const uniqueProjects = new Set(runners.map(r => r.project_path).filter(Boolean));
  if (uniqueProjects.size > 1) {
    const currentProject = process.cwd();
    console.log('');
    console.log('─'.repeat(120));
    console.log(`⚠️  MULTI-PROJECT WARNING: ${uniqueProjects.size} different projects have runners.`);
    console.log(`   Your current project: ${currentProject}`);
    console.log('   DO NOT modify files in other projects. Each runner works only on its own project.');
    console.log('─'.repeat(120));
  }
}

/**
 * Tree view of runners grouped by project with their current tasks
 */
async function runListTree(json: boolean): Promise<void> {
  const runners = listRunners();
  const projects = getRegisteredProjects(false);

  // Build project info map
  interface ProjectInfo {
    path: string;
    name: string;
    runners: Runner[];
    activeTasks: Task[];
  }

  const projectMap = new Map<string, ProjectInfo>();

  // Initialize with all registered projects
  for (const project of projects) {
    projectMap.set(project.path, {
      path: project.path,
      name: project.name || basename(project.path),
      runners: [],
      activeTasks: [],
    });
  }

  // Add runners to their projects
  for (const runner of runners) {
    const projectPath = runner.project_path;
    if (!projectPath) continue;

    if (!projectMap.has(projectPath)) {
      projectMap.set(projectPath, {
        path: projectPath,
        name: basename(projectPath),
        runners: [],
        activeTasks: [],
      });
    }

    const info = projectMap.get(projectPath)!;
    info.runners.push(runner);
  }

  // Fetch active tasks for each project
  for (const [projectPath, info] of projectMap) {
    const dbPath = `${projectPath}/.steroids/steroids.db`;
    if (!existsSync(dbPath)) continue;

    try {
      const { db, close } = openDatabase(projectPath);
      try {
        const inProgress = listTasks(db, { status: 'in_progress' });
        const review = listTasks(db, { status: 'review' });
        info.activeTasks = [...inProgress, ...review];
      } finally {
        close();
      }
    } catch {
      // Skip inaccessible projects
    }
  }

  // JSON output
  if (json) {
    const output = Array.from(projectMap.values()).map((info) => ({
      project: info.path,
      name: info.name,
      runners: info.runners.map((r) => ({
        id: r.id,
        status: r.status,
        pid: r.pid,
        currentTaskId: r.current_task_id,
        alive: r.pid ? isProcessAlive(r.pid) : false,
      })),
      activeTasks: info.activeTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
    }));
    console.log(JSON.stringify({ projects: output }, null, 2));
    return;
  }

  // Text tree view
  const projectList = Array.from(projectMap.values());
  const currentProject = process.cwd();

  if (projectList.length === 0) {
    console.log('No registered projects.');
    return;
  }

  console.log('');
  console.log('RUNNERS TREE');
  console.log('═'.repeat(80));

  for (let i = 0; i < projectList.length; i++) {
    const info = projectList[i];
    const isLast = i === projectList.length - 1;
    const isCurrent = info.path === currentProject;
    const currentMarker = isCurrent ? ' ← (current)' : '';

    console.log('');
    console.log(`📁 ${info.name}${currentMarker}`);
    console.log(`   ${info.path}`);

    if (info.runners.length === 0) {
      console.log('   └─ (no runners)');
    } else {
      for (let j = 0; j < info.runners.length; j++) {
        const runner = info.runners[j];
        const isLastRunner = j === info.runners.length - 1;
        const runnerPrefix = isLastRunner ? '└─' : '├─';
        const childPrefix = isLastRunner ? '   ' : '│  ';

        const alive = runner.pid && isProcessAlive(runner.pid);
        const statusIcon = alive ? '🟢' : '🔴';
        const statusText = alive ? runner.status : 'dead';
        const pidText = runner.pid ? ` PID ${runner.pid}` : '';

        console.log(`   ${runnerPrefix} ${statusIcon} Runner ${runner.id.substring(0, 8)} (${statusText}${pidText})`);

        // Show section if focused
        if (runner.section_id && runner.project_path) {
          try {
            const { db, close } = openDatabase(runner.project_path);
            try {
              const section = getSection(db, runner.section_id);
              if (section) {
                console.log(`   ${childPrefix}    Section: ${section.name}`);
              }
            } finally {
              close();
            }
          } catch {
            // Ignore section fetch errors
          }
        }

        // Show current task if available
        if (runner.current_task_id && runner.project_path) {
          try {
            const { db, close } = openDatabase(runner.project_path);
            try {
              const task = getTask(db, runner.current_task_id);
              if (task) {
                const statusMarker = task.status === 'in_progress' ? '🔧' : '👁️';
                console.log(`   ${childPrefix}    ${statusMarker} ${task.title.substring(0, 50)}`);
                console.log(`   ${childPrefix}       [${task.status}] ${task.id.substring(0, 8)}`);
              }
            } finally {
              close();
            }
          } catch {
            console.log(`   ${childPrefix}    Task: ${runner.current_task_id.substring(0, 8)}`);
          }
        } else if (alive) {
          console.log(`   ${childPrefix}    (idle - no task)`);
        }
      }
    }

    // Show other active tasks not being worked on by runners
    const runnerTaskIds = new Set(info.runners.map((r) => r.current_task_id).filter(Boolean));
    const unassignedTasks = info.activeTasks.filter((t) => !runnerTaskIds.has(t.id));

    if (unassignedTasks.length > 0) {
      console.log('   │');
      console.log('   └─ 📋 Queued active tasks:');
      for (const task of unassignedTasks.slice(0, 5)) {
        const statusIcon = task.status === 'in_progress' ? '🔧' : '👁️';
        console.log(`      ${statusIcon} ${task.title.substring(0, 45)} [${task.status}]`);
      }
      if (unassignedTasks.length > 5) {
        console.log(`      ... and ${unassignedTasks.length - 5} more`);
      }
    }
  }

  console.log('');
  console.log('═'.repeat(80));

  // Multi-project warning
  const activeProjects = projectList.filter((p) => p.runners.length > 0);
  if (activeProjects.length > 1) {
    console.log('');
    console.log('⚠️  MULTI-PROJECT: Multiple projects have active runners.');
    console.log('   Each runner works ONLY on its own project.');
  }
}
