/**
 * Commit integration checks and SHA resolution
 */

import { runGitCommand } from './merge-git.js';

export function isAppliedCommitIntegrated(projectPath: string, commitSha: string | null): boolean {
  if (!commitSha) {
    return false;
  }

  const output = runGitCommand(
    projectPath,
    ['branch', '--contains', commitSha, '--list', 'HEAD'],
    { allowFailure: true }
  );
  const lower = output.toLowerCase();

  if (lower.includes('fatal:') || lower.includes('error:')) {
    return false;
  }

  return output.trim().length > 0;
}

export function resolveGitSha(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (/fatal:|error:/i.test(trimmed)) return null;
  return trimmed.split('\n').at(-1)?.trim() ?? null;
}
