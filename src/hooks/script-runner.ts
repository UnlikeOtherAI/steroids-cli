/**
 * Script Hook Runner
 *
 * Executes shell commands as hooks with timeout and async support.
 * Handles templated arguments and environment variable resolution.
 */

import { spawn } from 'node:child_process';
import type { HookPayload } from './payload.js';
import { parseTemplate, createTemplateContext } from './templates.js';

/**
 * Script hook configuration
 */
export interface ScriptHookConfig {
  /** Hook name (for logging) */
  name: string;
  /** Command to execute */
  command: string;
  /** Arguments (supports templates) */
  args?: string[];
  /** Working directory (defaults to project path) */
  cwd?: string;
  /** Timeout (e.g., "60s", "5m", "1h" or number in seconds) */
  timeout?: string | number;
  /** Run async without blocking (default false) */
  async?: boolean;
}

/**
 * Script execution result
 */
export interface ScriptResult {
  /** Whether execution was successful */
  success: boolean;
  /** Exit code */
  exitCode: number | null;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Execution time in milliseconds */
  duration: number;
  /** Error message if failed */
  error?: string;
  /** Whether execution timed out */
  timedOut?: boolean;
}

/**
 * Parse timeout string (e.g., "60s", "5m") to milliseconds
 */
export function parseTimeout(timeout: string | number | undefined): number {
  if (timeout === undefined) {
    return 60000; // 60 seconds default
  }

  if (typeof timeout === 'number') {
    return timeout * 1000; // Convert seconds to ms
  }

  const match = timeout.match(/^(\d+)(s|m|h)?$/);
  if (!match) {
    throw new Error(`Invalid timeout format: ${timeout}. Use format like "60s", "5m", "1h"`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      return 60000;
  }
}

/**
 * Execute a script hook
 *
 * @param config - Script hook configuration
 * @param payload - Hook event payload for template resolution
 * @returns Promise resolving to script result
 */
export async function executeScript(
  config: ScriptHookConfig,
  payload: HookPayload
): Promise<ScriptResult> {
  const startTime = Date.now();

  try {
    // Create template context from payload
    const context = createTemplateContext(payload);

    // Parse command (resolve env vars)
    const command = parseTemplate(config.command, context);

    // Parse arguments (resolve both templates and env vars)
    const args = (config.args || []).map((arg) => parseTemplate(arg, context));

    // Parse working directory (default to project path)
    const cwd = config.cwd
      ? parseTemplate(config.cwd, context)
      : payload.project.path;

    // Parse timeout
    const timeoutMs = parseTimeout(config.timeout);

    // Execute
    if (config.async) {
      // Fire and forget - don't wait for completion
      spawnAsync(command, args, cwd, config.name);
      return {
        success: true,
        exitCode: null,
        stdout: '',
        stderr: '',
        duration: Date.now() - startTime,
      };
    } else {
      // Wait for completion
      return await spawnSync(command, args, cwd, timeoutMs, startTime);
    }
  } catch (error) {
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Spawn a process asynchronously (fire and forget)
 */
function spawnAsync(
  command: string,
  args: string[],
  cwd: string,
  hookName: string
): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    shell: false,
  });

  // Detach from parent process
  child.unref();

  // Log errors if they occur (but don't block)
  child.on('error', (error) => {
    console.error(`[Hook ${hookName}] Async execution error:`, error.message);
  });
}

/**
 * Spawn a process synchronously (wait for completion)
 */
function spawnSync(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  startTime: number
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let hasResolved = false;
    let killTimer: NodeJS.Timeout | null = null;

    // Spawn with args as separate argv entries to preserve args-with-spaces
    const child = spawn(command, args, {
      cwd,
      shell: false,
    });

    // Capture stdout
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    // Capture stderr
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Handle timeout
    const timeoutHandle = setTimeout(() => {
      if (hasResolved) return;
      timedOut = true;
      child.kill('SIGTERM');

      // Force kill after 5 seconds if still running
      // Note: child.killed becomes true immediately after kill(), so we check exitCode instead
      killTimer = setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already exited, ignore ESRCH
          }
        }
      }, 5000);
      killTimer.unref(); // Don't keep event loop alive
    }, timeoutMs);
    timeoutHandle.unref(); // Don't keep event loop alive

    // Handle process exit
    child.on('close', (code, signal) => {
      if (hasResolved) return;
      hasResolved = true;
      clearTimeout(timeoutHandle);
      if (killTimer) {
        clearTimeout(killTimer);
      }

      const result: ScriptResult = {
        success: !timedOut && code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        duration: Date.now() - startTime,
      };

      if (timedOut) {
        result.timedOut = true;
        result.error = `Script execution timed out after ${timeoutMs}ms`;
      } else if (signal) {
        result.error = `Process killed by signal: ${signal}`;
      }

      resolve(result);
    });

    // Handle spawn errors
    child.on('error', (error) => {
      if (hasResolved) return;
      hasResolved = true;
      clearTimeout(timeoutHandle);
      if (killTimer) {
        clearTimeout(killTimer);
      }

      resolve({
        success: false,
        exitCode: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        duration: Date.now() - startTime,
        error: error.message,
      });
    });
  });
}

/**
 * Validate script hook configuration
 */
export function validateScriptConfig(config: ScriptHookConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.name) {
    errors.push('Missing required field: name');
  }

  if (!config.command) {
    errors.push('Missing required field: command');
  }

  if (config.timeout !== undefined) {
    try {
      parseTimeout(config.timeout);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
