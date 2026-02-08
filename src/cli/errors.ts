/**
 * Error codes and exit codes for Steroids CLI
 *
 * Provides consistent, semantic error codes that map to appropriate
 * exit codes for shell scripting and automation.
 *
 * Error codes are used in JSON output for machine-parseable errors.
 * Exit codes follow standard Unix conventions.
 */

/**
 * Standard error codes used throughout the CLI
 *
 * These codes appear in the JSON error.code field and are mapped
 * to appropriate exit codes for process termination.
 */
export enum ErrorCode {
  /** Operation completed successfully */
  SUCCESS = 'SUCCESS',

  /** Unspecified error (generic fallback) */
  GENERAL_ERROR = 'GENERAL_ERROR',

  /** Invalid command arguments or flags */
  INVALID_ARGUMENTS = 'INVALID_ARGUMENTS',

  /** Configuration file error or invalid config */
  CONFIG_ERROR = 'CONFIG_ERROR',

  /** Requested resource not found (generic) */
  NOT_FOUND = 'NOT_FOUND',

  /** Access denied or insufficient permissions */
  PERMISSION_DENIED = 'PERMISSION_DENIED',

  /** Resource is locked by another process */
  RESOURCE_LOCKED = 'RESOURCE_LOCKED',

  /** Health check failed */
  HEALTH_FAILED = 'HEALTH_FAILED',

  /** Specific: Task not found */
  TASK_NOT_FOUND = 'TASK_NOT_FOUND',

  /** Specific: Section not found */
  SECTION_NOT_FOUND = 'SECTION_NOT_FOUND',

  /** Specific: Task is locked by a runner */
  TASK_LOCKED = 'TASK_LOCKED',

  /** Steroids not initialized in this directory */
  NOT_INITIALIZED = 'NOT_INITIALIZED',

  /** Database migration required */
  MIGRATION_REQUIRED = 'MIGRATION_REQUIRED',

  /** Hook execution failed */
  HOOK_FAILED = 'HOOK_FAILED',

  /** Validation error */
  VALIDATION_ERROR = 'VALIDATION_ERROR',

  /** Internal error */
  INTERNAL_ERROR = 'INTERNAL_ERROR',

  /** Feature not implemented */
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',
}

/**
 * Unix exit codes for process termination
 *
 * These follow standard Unix conventions:
 * - 0: Success
 * - 1: General error
 * - 2-125: Specific errors
 * - 126-255: Reserved by shell
 */
export enum ExitCode {
  /** Success - operation completed without errors */
  SUCCESS = 0,

  /** General error - unspecified failure */
  GENERAL_ERROR = 1,

  /** Invalid arguments - bad command line input */
  INVALID_ARGUMENTS = 2,

  /** Configuration error - config file or settings problem */
  CONFIG_ERROR = 3,

  /** Not found - requested resource doesn't exist */
  NOT_FOUND = 4,

  /** Permission denied - access not allowed */
  PERMISSION_DENIED = 5,

  /** Resource locked - locked by another process */
  RESOURCE_LOCKED = 6,

  /** Health check failed - system health issues */
  HEALTH_FAILED = 7,
}

/**
 * Map error codes to exit codes
 *
 * This mapping determines what exit code the process should use
 * when terminating due to a specific error.
 */
export const ERROR_CODE_TO_EXIT_CODE: Record<ErrorCode, ExitCode> = {
  [ErrorCode.SUCCESS]: ExitCode.SUCCESS,
  [ErrorCode.GENERAL_ERROR]: ExitCode.GENERAL_ERROR,
  [ErrorCode.INVALID_ARGUMENTS]: ExitCode.INVALID_ARGUMENTS,
  [ErrorCode.CONFIG_ERROR]: ExitCode.CONFIG_ERROR,
  [ErrorCode.NOT_FOUND]: ExitCode.NOT_FOUND,
  [ErrorCode.PERMISSION_DENIED]: ExitCode.PERMISSION_DENIED,
  [ErrorCode.RESOURCE_LOCKED]: ExitCode.RESOURCE_LOCKED,
  [ErrorCode.HEALTH_FAILED]: ExitCode.HEALTH_FAILED,

  // Specific error codes map to generic exit codes
  [ErrorCode.TASK_NOT_FOUND]: ExitCode.NOT_FOUND,
  [ErrorCode.SECTION_NOT_FOUND]: ExitCode.NOT_FOUND,
  [ErrorCode.TASK_LOCKED]: ExitCode.RESOURCE_LOCKED,
  [ErrorCode.NOT_INITIALIZED]: ExitCode.CONFIG_ERROR,
  [ErrorCode.MIGRATION_REQUIRED]: ExitCode.CONFIG_ERROR,
  [ErrorCode.HOOK_FAILED]: ExitCode.GENERAL_ERROR,
  [ErrorCode.VALIDATION_ERROR]: ExitCode.INVALID_ARGUMENTS,
  [ErrorCode.INTERNAL_ERROR]: ExitCode.GENERAL_ERROR,
  [ErrorCode.NOT_IMPLEMENTED]: ExitCode.GENERAL_ERROR,
};

/**
 * Get the exit code for a given error code
 *
 * @param errorCode - The error code to map
 * @returns The corresponding exit code
 */
export function getExitCode(errorCode: ErrorCode): ExitCode {
  return ERROR_CODE_TO_EXIT_CODE[errorCode] ?? ExitCode.GENERAL_ERROR;
}

/**
 * Get the exit code for an error code string
 *
 * Useful when you have a string error code from JSON or user input.
 *
 * @param errorCodeStr - The error code as a string
 * @returns The corresponding exit code, or GENERAL_ERROR if unknown
 */
export function getExitCodeFromString(errorCodeStr: string): ExitCode {
  const errorCode = errorCodeStr as ErrorCode;
  if (errorCode in ERROR_CODE_TO_EXIT_CODE) {
    return ERROR_CODE_TO_EXIT_CODE[errorCode];
  }
  return ExitCode.GENERAL_ERROR;
}

/**
 * CLI Error class that includes error code and exit code
 *
 * Use this for errors that should result in process termination
 * with a specific exit code.
 */
export class CliError extends Error {
  public readonly code: ErrorCode;
  public readonly exitCode: ExitCode;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = getExitCode(code);
    this.details = details;

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CliError);
    }
  }

  /**
   * Check if this error should terminate the process
   */
  shouldExit(): boolean {
    return this.exitCode !== ExitCode.SUCCESS;
  }

  /**
   * Exit the process with this error's exit code
   */
  exit(): never {
    process.exit(this.exitCode);
  }

  /**
   * Convert error to JSON-serializable object
   */
  toJSON(): { code: string; message: string; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/**
 * Create a CliError for task not found
 */
export function taskNotFoundError(taskId: string): CliError {
  return new CliError(
    ErrorCode.TASK_NOT_FOUND,
    `Task not found: ${taskId}`,
    { taskId }
  );
}

/**
 * Create a CliError for section not found
 */
export function sectionNotFoundError(sectionId: string): CliError {
  return new CliError(
    ErrorCode.SECTION_NOT_FOUND,
    `Section not found: ${sectionId}`,
    { sectionId }
  );
}

/**
 * Create a CliError for task locked
 */
export function taskLockedError(taskId: string, lockedBy?: string): CliError {
  return new CliError(
    ErrorCode.TASK_LOCKED,
    `Task is locked: ${taskId}${lockedBy ? ` (locked by: ${lockedBy})` : ''}`,
    { taskId, lockedBy }
  );
}

/**
 * Create a CliError for not initialized
 */
export function notInitializedError(): CliError {
  return new CliError(
    ErrorCode.NOT_INITIALIZED,
    'Steroids not initialized. Run: steroids init'
  );
}

/**
 * Create a CliError for migration required
 */
export function migrationRequiredError(): CliError {
  return new CliError(
    ErrorCode.MIGRATION_REQUIRED,
    'Database migration required. Run: steroids migrate'
  );
}

/**
 * Create a CliError for invalid arguments
 */
export function invalidArgumentsError(message: string): CliError {
  return new CliError(ErrorCode.INVALID_ARGUMENTS, message);
}

/**
 * Create a CliError for config error
 */
export function configError(message: string, details?: Record<string, unknown>): CliError {
  return new CliError(ErrorCode.CONFIG_ERROR, message, details);
}

/**
 * Create a CliError for permission denied
 */
export function permissionDeniedError(message: string): CliError {
  return new CliError(ErrorCode.PERMISSION_DENIED, message);
}

/**
 * Create a CliError for hook failed
 */
export function hookFailedError(hookName: string, exitCode?: number): CliError {
  return new CliError(
    ErrorCode.HOOK_FAILED,
    `Hook failed: ${hookName}${exitCode !== undefined ? ` (exit code: ${exitCode})` : ''}`,
    { hookName, exitCode }
  );
}
