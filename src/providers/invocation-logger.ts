/**
 * Invocation Logger
 * Logs all LLM invocations for debugging and audit purposes
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { InvokeResult } from './interface.js';

/**
 * Log entry for an LLM invocation
 */
export interface InvocationLogEntry {
  /** Timestamp of invocation start */
  timestamp: string;
  /** Role (orchestrator, coder, reviewer) */
  role: 'orchestrator' | 'coder' | 'reviewer';
  /** Provider name (claude, openai, gemini, codex) */
  provider: string;
  /** Model identifier */
  model: string;
  /** Task ID if applicable */
  taskId?: string;
  /** Duration in milliseconds */
  duration: number;
  /** Exit code */
  exitCode: number;
  /** Whether the invocation succeeded */
  success: boolean;
  /** Whether the invocation timed out */
  timedOut: boolean;
  /** Prompt text */
  prompt: string;
  /** Response text (stdout) */
  response: string;
  /** Error text (stderr) */
  error?: string;
}

/**
 * Configuration for invocation logging
 */
export interface InvocationLoggerConfig {
  /** Enable logging (default: true) */
  enabled?: boolean;
  /** Directory to store logs (default: .steroids/logs) */
  logsDir?: string;
  /** Log retention in days (default: 7, 0 = keep forever) */
  retentionDays?: number;
  /** Whether to include prompts in logs (default: true) */
  includePrompts?: boolean;
  /** Whether to include responses in logs (default: true) */
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

/**
 * Helper to log an invocation result
 * Logs to both file system and database (if taskId provided)
 */
export function logInvocation(
  prompt: string,
  result: InvokeResult,
  metadata: {
    role: 'orchestrator' | 'coder' | 'reviewer';
    provider: string;
    model: string;
    taskId?: string;
    projectPath?: string;
    rejectionNumber?: number;
  }
): void {
  const logger = getInvocationLogger();

  // Log to file system
  logger.log({
    timestamp: new Date().toISOString(),
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

  // Also log to database if we have a task ID
  if (metadata.taskId && (metadata.role === 'coder' || metadata.role === 'reviewer')) {
    try {
      // Dynamic import to avoid circular dependencies
      const { openDatabase } = require('../database/connection.js');
      const { createTaskInvocation } = require('../database/queries.js');

      const { db, close } = openDatabase(metadata.projectPath);
      try {
        createTaskInvocation(db, {
          taskId: metadata.taskId,
          role: metadata.role,
          provider: metadata.provider,
          model: metadata.model,
          prompt,
          response: result.stdout,
          error: result.stderr || undefined,
          exitCode: result.exitCode,
          durationMs: result.duration,
          success: result.success,
          timedOut: result.timedOut,
          rejectionNumber: metadata.rejectionNumber,
        });
      } finally {
        close();
      }
    } catch (error) {
      // Don't fail the invocation if database logging fails
      console.warn(`Failed to log invocation to database: ${error}`);
    }
  }
}
