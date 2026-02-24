/**
 * steroids skills - Manage and assign AI skills
 */

import type { GlobalFlags } from '../cli/flags.js';
import { createOutput } from '../cli/output.js';
import { generateHelp } from '../cli/help.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  loadConfig,
  loadConfigFile,
  saveConfig,
  getGlobalConfigPath,
  getProjectConfigPath,
  type SteroidsConfig,
} from '../config/loader.js';

const HELP = generateHelp({
  command: 'skills',
  description: 'Manage custom AI skills and project assignments',
  details: `Skills are modular prompt extensions that guide AI behavior.
Global skills are stored in ~/.steroids/skills/.
Pre-installed skills are available for all projects.`,
  usage: [
    'steroids skills list [--global]',
    'steroids skills create <filename> --content "<markdown>"',
    'steroids skills assign <project-path> <skill-name>',
    'steroids skills unassign <project-path> <skill-name>',
  ],
  subcommands: [
    { name: 'list', description: 'List available skills and their assignments' },
    { name: 'create', description: 'Create a new custom skill' },
    { name: 'assign', description: 'Assign a skill to a project' },
    { name: 'unassign', description: 'Remove a skill from a project' },
  ],
  examples: [
    { command: 'steroids skills list', description: 'List all skills' },
    { command: 'steroids skills assign . adhere-to-architecture', description: 'Assign a skill to current project' },
  ],
  options: [
    { long: 'content', description: 'Skill content (for create)', values: '<text>' },
  ],
});

function getCustomSkillsDir(): string {
  const dir = join(homedir(), '.steroids', 'skills');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getPreinstalledSkillsDir(): string {
  // Try to find the WebUI/src/assets/skills directory
  let currentDir = process.cwd();
  let rootDir = currentDir;
  while (currentDir !== '/') {
    if (existsSync(join(currentDir, 'WebUI', 'src', 'assets', 'skills'))) {
      rootDir = currentDir;
      break;
    }
    currentDir = join(currentDir, '..');
  }
  return join(rootDir, 'WebUI', 'src', 'assets', 'skills');
}

export async function listSkills(): Promise<{ name: string; type: 'pre-installed' | 'custom' }[]> {
  const skills: { name: string; type: 'pre-installed' | 'custom' }[] = [];

  const customDir = getCustomSkillsDir();
  if (existsSync(customDir)) {
    for (const file of readdirSync(customDir)) {
      if (file.endsWith('.md')) {
        skills.push({ name: file.replace('.md', ''), type: 'custom' });
      }
    }
  }

  const preinstalledDir = getPreinstalledSkillsDir();
  if (existsSync(preinstalledDir)) {
    for (const file of readdirSync(preinstalledDir)) {
      if (file.endsWith('.md')) {
        // Prevent duplicates if custom overrides pre-installed
        if (!skills.find(s => s.name === file.replace('.md', ''))) {
          skills.push({ name: file.replace('.md', ''), type: 'pre-installed' });
        }
      }
    }
  }

  return skills;
}

export function getSkillContent(name: string): string | null {
  const customFile = join(getCustomSkillsDir(), `${name}.md`);
  if (existsSync(customFile)) return readFileSync(customFile, 'utf-8');

  const preinstalledFile = join(getPreinstalledSkillsDir(), `${name}.md`);
  if (existsSync(preinstalledFile)) return readFileSync(preinstalledFile, 'utf-8');

  return null;
}

export async function skillsCommand(args: string[], flags: GlobalFlags): Promise<void> {
  const out = createOutput({ command: 'skills', flags });

  if (flags.help || args.includes('-h') || args.includes('--help')) {
    out.log(HELP);
    return;
  }

  const subcommand = args[0] || 'list';

  switch (subcommand) {
    case 'list': {
      const skills = await listSkills();
      if (skills.length === 0) {
        out.log('No skills found.');
        return;
      }

      out.log('AVAILABLE SKILLS');
      out.log('────────────────────────────────────────────────');
      for (const skill of skills) {
        out.log(`${skill.name.padEnd(30)} [${skill.type}]`);
      }
      break;
    }

    case 'create': {
      const name = args[1];
      if (!name) {
        out.error('INVALID_ARGUMENTS', 'Skill name is required');
        process.exit(2);
      }

      // Parse --content flag manually
      let content = '';
      const contentIndex = args.indexOf('--content');
      if (contentIndex !== -1 && args.length > contentIndex + 1) {
        content = args[contentIndex + 1];
      } else {
        out.error('INVALID_ARGUMENTS', '--content flag is required to create a skill');
        process.exit(2);
      }

      const filePath = join(getCustomSkillsDir(), `${name.replace('.md', '')}.md`);
      writeFileSync(filePath, content, 'utf-8');
      out.log(`Created custom skill: ${name}`);
      break;
    }

    case 'assign': {
      const projectPath = args[1];
      const skillName = args[2];
      
      if (!projectPath || !skillName) {
        out.error('INVALID_ARGUMENTS', 'Usage: steroids skills assign <project-path> <skill-name>');
        process.exit(2);
      }

      const configPath = join(projectPath, 'steroids.config.yaml');
      let config = loadConfigFile(configPath) as SteroidsConfig;
      if (!config.skills) config.skills = [];
      if (!config.skills.includes(skillName)) {
        config.skills.push(skillName);
        saveConfig(config, configPath);
        out.log(`Assigned skill '${skillName}' to project at ${projectPath}`);
      } else {
        out.log(`Skill '${skillName}' is already assigned to this project.`);
      }
      break;
    }

    case 'unassign': {
      const projectPath = args[1];
      const skillName = args[2];
      
      if (!projectPath || !skillName) {
        out.error('INVALID_ARGUMENTS', 'Usage: steroids skills unassign <project-path> <skill-name>');
        process.exit(2);
      }

      const configPath = join(projectPath, 'steroids.config.yaml');
      let config = loadConfigFile(configPath) as SteroidsConfig;
      if (config.skills && config.skills.includes(skillName)) {
        config.skills = config.skills.filter(s => s !== skillName);
        saveConfig(config, configPath);
        out.log(`Unassigned skill '${skillName}' from project at ${projectPath}`);
      } else {
        out.log(`Skill '${skillName}' was not assigned to this project.`);
      }
      break;
    }

    default:
      out.log(`Unknown subcommand: ${subcommand}`);
      out.log('Run "steroids skills --help" for usage.');
      process.exit(2);
  }
}
