import type { GlobalFlags } from '../cli/flags.js';
/**
 * steroids scan - Scan directory for projects
 *
 * Detects project types and shows health scores.
 */

import { parseArgs } from 'node:util';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { openDatabase, isInitialized } from '../database/connection.js';
import { listTasks } from '../database/queries.js';

// Project type detection files
const PROJECT_MARKERS: Record<string, string[]> = {
  node: ['package.json'],
  python: ['pyproject.toml', 'setup.py', 'requirements.txt'],
  rust: ['Cargo.toml'],
  go: ['go.mod'],
  ruby: ['Gemfile'],
  elixir: ['mix.exs'],
  java: ['pom.xml', 'build.gradle'],
  dotnet: ['*.csproj', '*.sln'],
};

interface ProjectInfo {
  name: string;
  path: string;
  type: string;
  health: number | null;
  pendingTasks: number;
  totalTasks: number;
  hasSteroids: boolean;
}

const HELP = `
steroids scan - Scan directory for projects

USAGE:
  steroids scan [directory] [options]

ARGUMENTS:
  directory           Directory to scan (default: current directory)

OPTIONS:
  --filter <type>     Filter by project type: node, python, rust, go, ruby
  --sort <field>      Sort by: name, type, health, tasks (default: name)
  --limit <n>         Limit number of results
  --has-tasks         Only show projects with pending tasks
  --depth <n>         Scan depth (default: 1)
  -j, --json          Output as JSON
  -h, --help          Show help

PROJECT TYPES:
  node                package.json
  python              pyproject.toml, setup.py, requirements.txt
  rust                Cargo.toml
  go                  go.mod
  ruby                Gemfile
  elixir              mix.exs
  java                pom.xml, build.gradle
  dotnet              *.csproj, *.sln

EXAMPLES:
  steroids scan ~/Projects
  steroids scan ~/Projects --filter node --sort health
  steroids scan ~/Projects --has-tasks --limit 10
  steroids scan . --depth 2
`;

export async function scanCommand(args: string[], flags: GlobalFlags): Promise<void> {
  // Check global help flag first
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const { values, positionals } = parseArgs({
    args,
    options: {
      filter: { type: 'string' },
      sort: { type: 'string', default: 'name' },
      limit: { type: 'string' },
      'has-tasks': { type: 'boolean', default: false },
      depth: { type: 'string', default: '1' },
    },
    allowPositionals: true,
  });

  const directory = positionals[0] || process.cwd();
  const depth = parseInt(values.depth ?? '1', 10);

  if (!existsSync(directory)) {
    console.error(`Directory not found: ${directory}`);
    process.exit(1);
  }

  const stat = statSync(directory);
  if (!stat.isDirectory()) {
    console.error(`Not a directory: ${directory}`);
    process.exit(1);
  }

  let projects = scanDirectory(directory, depth);

  // Apply filter
  if (values.filter) {
    const filterType = values.filter.toLowerCase();
    projects = projects.filter(p => p.type === filterType);
  }

  // Apply has-tasks filter
  if (values['has-tasks']) {
    projects = projects.filter(p => p.pendingTasks > 0);
  }

  // Sort projects
  const sortField = values.sort || 'name';
  projects = sortProjects(projects, sortField);

  // Apply limit
  if (values.limit) {
    const limit = parseInt(values.limit, 10);
    if (!isNaN(limit) && limit > 0) {
      projects = projects.slice(0, limit);
    }
  }

  outputResults(projects, flags.json);
}

function scanDirectory(directory: string, depth: number): ProjectInfo[] {
  const projects: ProjectInfo[] = [];

  // Check if current directory is a project
  const projectType = detectProjectType(directory);
  if (projectType) {
    const info = getProjectInfo(directory, projectType);
    projects.push(info);
  }

  if (depth > 0) {
    try {
      const entries = readdirSync(directory, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Skip hidden directories and common non-project dirs
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;
        if (entry.name === 'target') continue;
        if (entry.name === 'dist') continue;
        if (entry.name === 'build') continue;
        if (entry.name === '__pycache__') continue;
        if (entry.name === 'venv') continue;
        if (entry.name === '.venv') continue;

        const subdir = join(directory, entry.name);
        const subProjects = scanDirectory(subdir, depth - 1);
        projects.push(...subProjects);
      }
    } catch {
      // Permission denied or other error, skip
    }
  }

  return projects;
}

function detectProjectType(directory: string): string | null {
  for (const [type, markers] of Object.entries(PROJECT_MARKERS)) {
    for (const marker of markers) {
      if (marker.includes('*')) {
        // Glob pattern - check with simple matching
        const pattern = marker.replace('*', '');
        try {
          const entries = readdirSync(directory);
          if (entries.some(e => e.endsWith(pattern))) {
            return type;
          }
        } catch {
          continue;
        }
      } else if (existsSync(join(directory, marker))) {
        return type;
      }
    }
  }
  return null;
}

function getProjectInfo(directory: string, type: string): ProjectInfo {
  const name = basename(directory);
  const hasSteroids = isInitialized(directory);

  let pendingTasks = 0;
  let totalTasks = 0;
  let health: number | null = null;

  if (hasSteroids) {
    try {
      const { db, close } = openDatabase(directory);
      try {
        const allTasks = listTasks(db, { status: 'all' });
        const pending = allTasks.filter(t =>
          t.status === 'pending' || t.status === 'in_progress' || t.status === 'review'
        );
        totalTasks = allTasks.length;
        pendingTasks = pending.length;

        // Calculate simple health score based on task completion
        if (totalTasks > 0) {
          const completed = allTasks.filter(t => t.status === 'completed').length;
          health = Math.round((completed / totalTasks) * 100);
        }
      } finally {
        close();
      }
    } catch {
      // Database error, skip
    }
  }

  return {
    name,
    path: directory,
    type,
    health,
    pendingTasks,
    totalTasks,
    hasSteroids,
  };
}

function sortProjects(projects: ProjectInfo[], sortField: string): ProjectInfo[] {
  return [...projects].sort((a, b) => {
    switch (sortField) {
      case 'name':
        return a.name.localeCompare(b.name);
      case 'type':
        return a.type.localeCompare(b.type);
      case 'health':
        // Null values go last
        if (a.health === null && b.health === null) return 0;
        if (a.health === null) return 1;
        if (b.health === null) return -1;
        return b.health - a.health; // Descending
      case 'tasks':
        return b.pendingTasks - a.pendingTasks; // Descending
      default:
        return a.name.localeCompare(b.name);
    }
  });
}

function outputResults(projects: ProjectInfo[], json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      success: true,
      command: 'scan',
      data: {
        count: projects.length,
        projects: projects.map(p => ({
          name: p.name,
          path: p.path,
          type: p.type,
          health: p.health,
          tasks: {
            pending: p.pendingTasks,
            total: p.totalTasks,
          },
          hasSteroids: p.hasSteroids,
        })),
      },
      error: null,
    }, null, 2));
    return;
  }

  if (projects.length === 0) {
    console.log('No projects found.');
    return;
  }

  // Table header
  console.log(
    'NAME'.padEnd(20) +
    'TYPE'.padEnd(10) +
    'HEALTH'.padEnd(8) +
    'TASKS'
  );
  console.log('\u2500'.repeat(50));

  for (const project of projects) {
    const name = project.name.length > 18
      ? project.name.substring(0, 15) + '...'
      : project.name.padEnd(20);
    const type = project.type.padEnd(10);
    const health = project.health !== null
      ? String(project.health).padEnd(8)
      : '-'.padEnd(8);
    const tasks = project.pendingTasks > 0
      ? `${project.pendingTasks} pending`
      : project.totalTasks > 0
        ? 'all done'
        : '-';

    console.log(`${name}${type}${health}${tasks}`);
  }

  console.log('\u2500'.repeat(50));
  console.log(`Found ${projects.length} projects`);
}
