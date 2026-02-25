/**
 * Validation escalation tracking
 */

import { randomUUID } from 'node:crypto';
import { openGlobalDatabase, withGlobalDatabase } from './global-db-connection';

export interface ValidationEscalationRecord {
  id: string;
  session_id: string;
  project_path: string;
  workspace_path: string;
  validation_command: string;
  error_message: string;
  stdout_snippet: string | null;
  stderr_snippet: string | null;
  status: 'open' | 'resolved';
  created_at: string;
  resolved_at: string | null;
}

export function recordValidationEscalation(input: {
  sessionId: string;
  projectPath: string;
  workspacePath: string;
  validationCommand: string;
  errorMessage: string;
  stdoutSnippet?: string | null;
  stderrSnippet?: string | null;
}): ValidationEscalationRecord {
  const { db, close } = openGlobalDatabase();
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO validation_escalations (
         id, session_id, project_path, workspace_path, validation_command,
         error_message, stdout_snippet, stderr_snippet, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`
    ).run(
      id,
      input.sessionId,
      input.projectPath,
      input.workspacePath,
      input.validationCommand,
      input.errorMessage,
      input.stdoutSnippet ?? null,
      input.stderrSnippet ?? null
    );

    const row = db
      .prepare(
        `SELECT id, session_id, project_path, workspace_path, validation_command,
                error_message, stdout_snippet, stderr_snippet, status, created_at, resolved_at
         FROM validation_escalations
         WHERE id = ?`
      )
      .get(id) as ValidationEscalationRecord | undefined;

    if (!row) {
      throw new Error(`Failed to read validation escalation record for id ${id}`);
    }

    return row;
  } finally {
    close();
  }
}

export function resolveValidationEscalationsForSession(sessionId: string): number {
  return withGlobalDatabase((db) => {
    const result = db.prepare(
      `UPDATE validation_escalations
       SET status = 'resolved',
           resolved_at = datetime('now')
       WHERE session_id = ?
         AND status = 'open'`
    ).run(sessionId);

    return result.changes;
  });
}
