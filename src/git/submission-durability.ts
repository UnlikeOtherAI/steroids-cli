import { execSync } from 'node:child_process';

export interface DurableSubmissionRef {
  ref: string;
  sha: string;
}

export function getSubmissionDurableRef(taskId: string): string {
  return `refs/steroids/submissions/${taskId}/latest`;
}

export function readDurableSubmissionRef(projectPath: string, taskId: string): DurableSubmissionRef | null {
  const ref = getSubmissionDurableRef(taskId);
  try {
    const sha = execSync(`git rev-parse --verify ${ref}`, {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!sha) return null;
    return { ref, sha };
  } catch {
    return null;
  }
}

export function writeDurableSubmissionRef(
  projectPath: string,
  taskId: string,
  commitSha: string,
  previousSha?: string | null
): { ok: true } | { ok: false; error: string } {
  const ref = getSubmissionDurableRef(taskId);

  try {
    if (previousSha) {
      execSync(`git update-ref ${ref} ${commitSha} ${previousSha}`, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      execSync(`git update-ref ${ref} ${commitSha}`, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to update durable submission ref ${ref}: ${message}` };
  }
}

export function deleteDurableSubmissionRef(projectPath: string, taskId: string): void {
  const ref = getSubmissionDurableRef(taskId);
  try {
    execSync(`git update-ref -d ${ref}`, {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // best effort cleanup
  }
}
