/**
 * Project instruction file detection and injection
 * Handles AGENTS.md, CLAUDE.md, GEMINI.md detection and force-injection into prompts
 * Per-project override state stored in .steroids/instruction-files.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OVERRIDE_FILE = '.steroids/instruction-files.json';
const MAX_CHARS = 4000;

export interface InstructionOverrides {
  agentsMd?: boolean;
  claudeMd?: boolean;
  geminiMd?: boolean;
  customInstructions?: string;
}

export interface InstructionFile {
  name: string;
  key: string;
  exists: boolean;
  enabled: boolean;
  content: string;
}

export const INSTRUCTION_FILE_DEFS = [
  { key: 'agentsMd', filename: 'AGENTS.md' },
  { key: 'claudeMd', filename: 'CLAUDE.md' },
  { key: 'geminiMd', filename: 'GEMINI.md' },
] as const;

export type InstructionKey = typeof INSTRUCTION_FILE_DEFS[number]['key'];

export function readInstructionOverrides(projectPath: string): InstructionOverrides {
  try {
    return JSON.parse(readFileSync(join(projectPath, OVERRIDE_FILE), 'utf-8')) as InstructionOverrides;
  } catch {
    return {};
  }
}

export function writeInstructionOverrides(projectPath: string, overrides: InstructionOverrides): void {
  const filePath = join(projectPath, OVERRIDE_FILE);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(overrides, null, 2));
}

export function isInstructionEnabled(overrides: InstructionOverrides, key: string): boolean {
  return (overrides as Record<string, unknown>)[key] !== false;
}

/**
 * Get the list of instruction files with their state for a project.
 * Used by the API to return file info to the UI.
 */
export function getInstructionFilesList(projectPath: string): InstructionFile[] {
  const overrides = readInstructionOverrides(projectPath);
  return INSTRUCTION_FILE_DEFS.map(({ key, filename }) => {
    const filePath = join(projectPath, filename);
    const exists = existsSync(filePath);
    const enabled = isInstructionEnabled(overrides, key);
    let content = '';
    if (exists) {
      try {
        content = readFileSync(filePath, 'utf-8').trim();
        if (content.length > MAX_CHARS) content = content.slice(0, MAX_CHARS) + '\n\n[truncated]';
      } catch {
        content = '';
      }
    }
    return { name: filename, key, exists, enabled, content };
  });
}

/**
 * Build the mandatory project instructions section for injection into prompts.
 * Reads enabled instruction files and assembles a formatted block.
 * Returns empty string if no instruction files are found or enabled.
 */
export function buildProjectInstructionsSection(projectPath: string): string {
  const overrides = readInstructionOverrides(projectPath);
  const parts: string[] = [];

  for (const { key, filename } of INSTRUCTION_FILE_DEFS) {
    if (!isInstructionEnabled(overrides, key)) continue;
    const filePath = join(projectPath, filename);
    if (!existsSync(filePath)) continue;
    try {
      let content = readFileSync(filePath, 'utf-8').trim();
      if (content.length > MAX_CHARS) content = content.slice(0, MAX_CHARS) + '\n\n[truncated]';
      parts.push(`### ${filename}\n${content}`);
    } catch {
      // Skip unreadable files
    }
  }

  if (overrides.customInstructions?.trim()) {
    parts.push(`### Custom Instructions\n${overrides.customInstructions.trim()}`);
  }

  if (parts.length === 0) return '';

  return `
---

## MANDATORY PROJECT INSTRUCTIONS

**These instructions MUST be followed for ALL work on this project. Read and comply before writing any code.**

${parts.join('\n\n---\n\n')}

---
`;
}
