/**
 * Invocation Logger
 * Logs all LLM invocations for debugging and audit purposes
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { InvocationActivity, InvokeResult } from './interface.js';

/**
 * Log entry for an LLM invocation
 */
export interface InvocationLogEntry {
  timestamp: string;
  role: 'orchestrator' | 'coder' | 'reviewer';
  provider: string;
  model: string;
  taskId?: string;
  duration: number;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
  prompt: string;
  response: string;
  error?: string;
}

/**
 * Configuration for invocation logging
 */
export interface InvocationLoggerConfig {
  enabled?: boolean;
  logsDir?: string;
  retentionDays?: number;
  includePrompts?: boolean;
  includeResponses?: boolean;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<InvocationLoggerConfig> = {
  enabled: true,
  logsDir: '.steroids/logs',
  retentionDays: 7,
  includePrompts: true,
  includeResponses: true,
};

/**
 * Invocation Logger
 * Logs LLM invocations to disk for debugging and audit
 */
export class InvocationLogger {
  private config: Required<InvocationLoggerConfig>;

  constructor(config: InvocationLoggerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Log an invocation
   */
  log(entry: InvocationLogEntry): void {
    if (!this.config.enabled) {
      return;
    }

    try {
      // Ensure logs directory exists
      this.ensureLogsDirectory();

      // Create log file path
      const logFileName = this.createLogFileName(entry);
      const logFilePath = join(this.config.logsDir, logFileName);

      // Build log content
      const logContent = this.formatLogEntry(entry);

      // Write to file
      writeFileSync(logFilePath, logContent, 'utf-8');

      // Clean up old logs
      this.cleanupOldLogs();
    } catch (error) {
      // Don't fail the invocation if logging fails
      console.warn(`Failed to log invocation: ${error}`);
    }
  }

  /**
   * Create log file name
   */
  private createLogFileName(entry: InvocationLogEntry): string {
    const date = new Date(entry.timestamp);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = date.toISOString().split('T')[1].split('.')[0].replace(/:/g, '-'); // HH-MM-SS
    const taskPart = entry.taskId ? `-${entry.taskId.substring(0, 8)}` : '';
    const successPart = entry.success ? 'success' : 'failed';

    // Ensure date directory exists
    const dateDir = join(this.config.logsDir, dateStr);
    if (!existsSync(dateDir)) {
      mkdirSync(dateDir, { recursive: true });
    }

    return `${dateStr}/${timeStr}-${entry.role}-${entry.provider}-${successPart}${taskPart}.log`;
  }

  /**
   * Format log entry as text
   */
  private formatLogEntry(entry: InvocationLogEntry): string {
    const lines: string[] = [];

    lines.push('='.repeat(80));
    lines.push('LLM INVOCATION LOG');
    lines.push('='.repeat(80));
    lines.push('');

    lines.push(`Timestamp:    ${entry.timestamp}`);
    lines.push(`Role:         ${entry.role}`);
    lines.push(`Provider:     ${entry.provider}`);
    lines.push(`Model:        ${entry.model}`);
    if (entry.taskId) {
      lines.push(`Task ID:      ${entry.taskId}`);
    }
    lines.push(`Duration:     ${entry.duration}ms (${(entry.duration / 1000).toFixed(1)}s)`);
    lines.push(`Exit Code:    ${entry.exitCode}`);
    lines.push(`Success:      ${entry.success ? 'Yes' : 'No'}`);
    lines.push(`Timed Out:    ${entry.timedOut ? 'Yes' : 'No'}`);
    lines.push('');

    if (this.config.includePrompts && entry.prompt) {
      lines.push('-'.repeat(80));
      lines.push('PROMPT');
      lines.push('-'.repeat(80));
      lines.push(entry.prompt);
      lines.push('');
    }

    if (this.config.includeResponses && entry.response) {
      lines.push('-'.repeat(80));
      lines.push('RESPONSE');
      lines.push('-'.repeat(80));
      lines.push(entry.response);
      lines.push('');
    }

    if (entry.error) {
      lines.push('-'.repeat(80));
      lines.push('ERROR');
      lines.push('-'.repeat(80));
      lines.push(entry.error);
      lines.push('');
    }

    lines.push('='.repeat(80));

    return lines.join('\n');
  }

  /**
   * Ensure logs directory exists
   */
  private ensureLogsDirectory(): void {
    if (!existsSync(this.config.logsDir)) {
      mkdirSync(this.config.logsDir, { recursive: true });
    }
  }

  /**
   * Clean up old logs based on retention policy
   */
  private cleanupOldLogs(): void {
    if (this.config.retentionDays === 0) {
      return; // Keep forever
    }

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

      // Iterate through date directories
      const entries = readdirSync(this.config.logsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        // Check if directory name is a date (YYYY-MM-DD)
        const dateMatch = entry.name.match(/^\d{4}-\d{2}-\d{2}$/);
        if (!dateMatch) {
          continue;
        }

        const dirDate = new Date(entry.name);
        if (dirDate < cutoffDate) {
          // Delete old directory
          const dirPath = join(this.config.logsDir, entry.name);
          rmSync(dirPath, { recursive: true, force: true });
        }
      }
    } catch (error) {
      console.warn(`Failed to cleanup old logs: ${error}`);
    }
  }

  /**
   * Get all log files
   */
  getAllLogs(): string[] {
    if (!existsSync(this.config.logsDir)) {
      return [];
    }

    const logs: string[] = [];

    try {
      const entries = readdirSync(this.config.logsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const dateDir = join(this.config.logsDir, entry.name);
        const logFiles = readdirSync(dateDir).filter((f) => f.endsWith('.log'));

        for (const logFile of logFiles) {
          logs.push(join(dateDir, logFile));
        }
      }
    } catch (error) {
      console.warn(`Failed to list logs: ${error}`);
    }

    return logs.sort();
  }

  /**
   * Purge all logs
   */
  purgeAll(): void {
    if (existsSync(this.config.logsDir)) {
      try {
        rmSync(this.config.logsDir, { recursive: true, force: true });
        mkdirSync(this.config.logsDir, { recursive: true });
      } catch (error) {
        console.warn(`Failed to purge logs: ${error}`);
      }
    }
  }

  /**
   * Get total size of all logs in bytes
   */
  getTotalSize(): number {
    const logs = this.getAllLogs();
    let totalSize = 0;

    for (const logPath of logs) {
      try {
        const stats = statSync(logPath);
        totalSize += stats.size;
      } catch {
        // Ignore errors
      }
    }

    return totalSize;
  }
}

/**
 * Global invocation logger instance
 */
let globalLogger: InvocationLogger | null = null;

/**
 * Get the global invocation logger
 */
export function getInvocationLogger(config?: InvocationLoggerConfig): InvocationLogger {
  if (!globalLogger) {
    globalLogger = new InvocationLogger(config);
  }
  return globalLogger;
}

/**
 * Set the global invocation logger
 */
export function setInvocationLogger(logger: InvocationLogger): void {
  globalLogger = logger;
}

/**
 * Reset the global invocation logger
 */
export function resetInvocationLogger(): void {
  globalLogger = null;
}

type InvocationInvokeContext = { onActivity?: (activity: InvocationActivity) => void };

function ensureInvocationsDir(projectPath: string): string {
  const dir = join(projectPath, '.steroids', 'invocations');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'README.txt'), 'Activity logs for invocations (JSONL).\n', { flag: 'wx' });
  } catch {}
  return dir;
}

function appendJsonlLine(filePath: string, entry: Record<string, unknown>): void {
  // Best-effort logging: never fail the invocation on log I/O issues.
  try {
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch (error) {
    console.warn(`Failed to append invocation activity log: ${error}`);
  }
}

export async function logInvocation(
  prompt: string,
  invokeOrResult: ((ctx?: InvocationInvokeContext) => Promise<InvokeResult>) | InvokeResult,
  metadata: {
    role: 'orchestrator' | 'coder' | 'reviewer';
    provider: string;
    model: string;
    taskId?: string;
    projectPath?: string;
    rejectionNumber?: number;
    sessionId?: string;
    resumedFromSessionId?: string;
    invocationMode?: 'fresh' | 'resume';
  }
): Promise<InvokeResult> {
  const logger = getInvocationLogger();
  const startedAtMs = Date.now();

  const canDbLog =
    Boolean(metadata.taskId && metadata.projectPath) &&
    (metadata.role === 'coder' || metadata.role === 'reviewer');

  const projectPath = metadata.projectPath;
  let invocationId: number | null = null;
  let activityLogFile: string | null = null;
  let dbConn: { db: any; close: () => void } | null = null;

  const activity = (entry: InvocationActivity): void => {
    if (!activityLogFile) return;
    const now = Date.now();
    appendJsonlLine(activityLogFile, { ts: now, ...entry });

    // Update the database with the last activity timestamp
    if (canDbLog && dbConn && invocationId !== null) {
      try {
        dbConn.db.prepare(
          `UPDATE task_invocations SET last_activity_at_ms = ? WHERE id = ?`
        ).run(now, invocationId);
      } catch {
        // ignore best-effort update failures
      }
    }
  };

  if (canDbLog && projectPath) {
    try {
      const { openDatabase } = await import('../database/connection.js');
      const conn = openDatabase(projectPath);
      dbConn = conn;

      const insert = conn.db.prepare(
        `INSERT INTO task_invocations (
          task_id, role, provider, model, prompt, started_at_ms, status,
          rejection_number, session_id, resumed_from_session_id, invocation_mode
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`
      );

      const info = insert.run(
        metadata.taskId,
        metadata.role,
        metadata.provider,
        metadata.model,
        prompt,
        startedAtMs,
        metadata.rejectionNumber ?? null,
        metadata.sessionId ?? null,
        metadata.resumedFromSessionId ?? null,
        metadata.invocationMode ?? 'fresh'
      );

      invocationId = Number(info.lastInsertRowid);
      const invDir = ensureInvocationsDir(projectPath);
      activityLogFile = join(invDir, `${invocationId}.log`);
      activity({ type: 'start', role: metadata.role, provider: metadata.provider, model: metadata.model, mode: metadata.invocationMode ?? 'fresh' });
    } catch (error) {
      console.warn(`Failed to create running invocation record: ${error}`);
      if (dbConn) {
        try {
          dbConn.close();
        } catch {}
      }
      dbConn = null;
    }
  }

  try {
    const result: InvokeResult =
      typeof invokeOrResult === 'function'
        ? await invokeOrResult({ onActivity: (a) => activity(a) })
        : invokeOrResult;

    const completedAtMs = Date.now();
    const status = result.timedOut ? 'timeout' : result.success ? 'completed' : 'failed';

    activity({ type: 'complete', success: result.success, duration: result.duration, exitCode: result.exitCode, timedOut: result.timedOut, sessionId: result.sessionId });

    // Human-readable log (legacy: .steroids/logs) for `steroids logs`
    logger.log({
      timestamp: new Date(startedAtMs).toISOString(),
      role: metadata.role,
      provider: metadata.provider,
      model: metadata.model,
      taskId: metadata.taskId,
      duration: result.duration,
      exitCode: result.exitCode,
      success: result.success,
      timedOut: result.timedOut,
      prompt,
      response: result.stdout,
      error: result.stderr || undefined,
    });

    if (canDbLog && dbConn && invocationId !== null) {
      try {
        dbConn.db.prepare(
          `UPDATE task_invocations
           SET completed_at_ms = ?, status = ?, response = ?, error = ?, exit_code = ?,
               duration_ms = ?, success = ?, timed_out = ?, rejection_number = ?,
               session_id = ?, token_usage_json = ?
           WHERE id = ?`
        ).run(
          completedAtMs,
          status,
          result.stdout,
          result.stderr || null,
          result.exitCode,
          result.duration,
          result.success ? 1 : 0,
          result.timedOut ? 1 : 0,
          metadata.rejectionNumber ?? null,
          result.sessionId ?? metadata.sessionId ?? null,
          result.tokenUsage ? JSON.stringify(result.tokenUsage) : null,
          invocationId
        );
      } catch (error) {
        console.warn(`Failed to update invocation record: ${error}`);
      } finally {
        try {
          dbConn.close();
        } catch {}
      }
    }

    return result;
  } catch (error) {
    const completedAtMs = Date.now();
    const durationMs = completedAtMs - startedAtMs;
    const message = error instanceof Error ? error.message : String(error);

    activity({ type: 'error', error: message });

    // Human-readable fallback log
    logger.log({
      timestamp: new Date(startedAtMs).toISOString(),
      role: metadata.role,
      provider: metadata.provider,
      model: metadata.model,
      taskId: metadata.taskId,
      duration: durationMs,
      exitCode: 1,
      success: false,
      timedOut: false,
      prompt,
      response: '',
      error: message,
    });

    if (canDbLog && dbConn && invocationId !== null) {
      try {
        dbConn.db.prepare(
          `UPDATE task_invocations
           SET completed_at_ms = ?, status = 'failed', error = ?, exit_code = 1, duration_ms = ?, success = 0, timed_out = 0
           WHERE id = ?`
        ).run(completedAtMs, message, durationMs, invocationId);
      } catch (e) {
        console.warn(`Failed to update failed invocation record: ${e}`);
      } finally {
        try {
          dbConn.close();
        } catch {}
      }
    } else if (dbConn) {
      try {
        dbConn.close();
      } catch {}
    }

    throw error;
  }
}
