/**
 * Merge validation gate and workspace utilities
 */

import { execSync } from 'node:child_process';
import { ParallelMergeError } from './merge-errors.js';

const VALIDATION_MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const VALIDATION_SNIPPET_LIMIT = 8_000;

export function runValidationGate(mergePath: string, validationCommand?: string): void {
  if (!validationCommand || validationCommand.trim().length === 0) {
    return;
  }

  try {
    execSync(validationCommand, {
      cwd: mergePath,
      stdio: 'pipe',
      encoding: 'utf-8',
      maxBuffer: VALIDATION_MAX_BUFFER_BYTES,
    });
  } catch (error: unknown) {
    const err = error as Error & { code?: string; stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : err.stderr?.toString() ?? '';
    const stdout = typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString() ?? '';
    if (err.code === 'ENOBUFS') {
      throw new ParallelMergeError(
        'Validation gate output exceeded the maximum buffer size. Reduce output verbosity or split the command.',
        'VALIDATION_FAILED',
        {
          details: {
            command: validationCommand.trim(),
            stderr: stderr ?? '',
            stdout: stdout ?? '',
          },
        }
      );
    }

    const message = [stderr, stdout, err.message].filter(Boolean).join('\n') || String(error);
    throw new ParallelMergeError(
      `Validation gate failed: ${message}`,
      'VALIDATION_FAILED',
      {
        details: {
          command: validationCommand.trim(),
          stderr,
          stdout,
        },
      }
    );
  }
}

export function snippet(value: string | null | undefined, limit = VALIDATION_SNIPPET_LIMIT): string {
  if (!value) {
    return '';
  }

  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }

  return trimmed.slice(-limit);
}
