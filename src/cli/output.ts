/**
 * JSON Output Envelope for Steroids CLI
 *
 * Provides standardized output format for machine-readable responses.
 * All commands should use this envelope when --json flag is set.
 */

import type { GlobalFlags } from './flags.js';

/**
 * Error details in JSON output
 */
export interface ErrorDetails {
  /** Machine-readable error code */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Additional context about the error */
  details?: Record<string, unknown>;
}

/**
 * Standard JSON response envelope
 */
export interface JsonEnvelope<T = unknown> {
  /** Whether the operation succeeded */
  success: boolean;
  /** The command that was executed */
  command: string;
  /** The subcommand that was executed (if any) */
  subcommand: string | null;
  /** Response data (null on error) */
  data: T | null;
  /** Error information (null on success) */
  error: ErrorDetails | null;
}

/**
 * Context for output operations
 */
export interface OutputContext {
  /** The command name */
  command: string;
  /** The subcommand name (optional) */
  subcommand?: string;
  /** Global flags affecting output */
  flags: GlobalFlags;
}

/**
 * Create a success envelope
 */
export function successEnvelope<T>(
  command: string,
  subcommand: string | null,
  data: T
): JsonEnvelope<T> {
  return {
    success: true,
    command,
    subcommand,
    data,
    error: null,
  };
}

/**
 * Create an error envelope
 */
export function errorEnvelope(
  command: string,
  subcommand: string | null,
  code: string,
  message: string,
  details?: Record<string, unknown>
): JsonEnvelope<null> {
  return {
    success: false,
    command,
    subcommand,
    data: null,
    error: {
      code,
      message,
      details,
    },
  };
}

/**
 * Output helper class for consistent command output
 */
export class Output {
  private readonly command: string;
  private readonly subcommand: string | null;
  private readonly flags: GlobalFlags;

  constructor(ctx: OutputContext) {
    this.command = ctx.command;
    this.subcommand = ctx.subcommand ?? null;
    this.flags = ctx.flags;
  }

  /**
   * Output a success response
   */
  success<T>(data: T): void {
    if (this.flags.json) {
      const envelope = successEnvelope(this.command, this.subcommand, data);
      console.log(JSON.stringify(envelope, null, 2));
    } else if (!this.flags.quiet) {
      // For non-JSON, non-quiet mode, the caller should format the output
      // This is a no-op to let caller handle it
    }
  }

  /**
   * Output an error response
   */
  error(code: string, message: string, details?: Record<string, unknown>): void {
    if (this.flags.json) {
      const envelope = errorEnvelope(
        this.command,
        this.subcommand,
        code,
        message,
        details
      );
      console.log(JSON.stringify(envelope, null, 2));
    } else if (!this.flags.quiet) {
      console.error(`Error: ${message}`);
      if (this.flags.verbose && details) {
        console.error('Details:', JSON.stringify(details, null, 2));
      }
    }
  }

  /**
   * Output a message (respects quiet mode)
   */
  log(message: string): void {
    if (!this.flags.quiet && !this.flags.json) {
      console.log(message);
    }
  }

  /**
   * Output verbose information (only in verbose mode)
   */
  verbose(message: string): void {
    if (this.flags.verbose && !this.flags.json) {
      console.log(message);
    }
  }

  /**
   * Output a warning (respects quiet mode)
   */
  warn(message: string): void {
    if (!this.flags.quiet && !this.flags.json) {
      console.warn(`Warning: ${message}`);
    }
  }

  /**
   * Check if output should be JSON
   */
  isJson(): boolean {
    return this.flags.json;
  }

  /**
   * Check if output should be quiet
   */
  isQuiet(): boolean {
    return this.flags.quiet;
  }

  /**
   * Check if output should be verbose
   */
  isVerbose(): boolean {
    return this.flags.verbose;
  }

  /**
   * Print a formatted table
   */
  table(headers: string[], rows: string[][], options?: { separator?: string }): void {
    if (this.flags.json || this.flags.quiet) {
      return;
    }

    const sep = options?.separator ?? '  ';

    // Calculate column widths
    const widths = headers.map((h, i) => {
      const maxRowWidth = Math.max(...rows.map(r => (r[i] ?? '').length));
      return Math.max(h.length, maxRowWidth);
    });

    // Print headers
    const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join(sep);
    console.log(headerLine);
    console.log('\u2500'.repeat(headerLine.length));

    // Print rows
    for (const row of rows) {
      const line = row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join(sep);
      console.log(line);
    }
  }

  /**
   * Print a divider line
   */
  divider(width = 80): void {
    if (!this.flags.json && !this.flags.quiet) {
      console.log('\u2500'.repeat(width));
    }
  }
}

/**
 * Create an output helper with context
 */
export function createOutput(ctx: OutputContext): Output {
  return new Output(ctx);
}

/**
 * Quick JSON output for simple cases
 */
export function outputJson<T>(
  command: string,
  subcommand: string | null,
  data: T
): void {
  const envelope = successEnvelope(command, subcommand, data);
  console.log(JSON.stringify(envelope, null, 2));
}

/**
 * Quick JSON error output for simple cases
 */
export function outputJsonError(
  command: string,
  subcommand: string | null,
  code: string,
  message: string,
  details?: Record<string, unknown>
): void {
  const envelope = errorEnvelope(command, subcommand, code, message, details);
  console.log(JSON.stringify(envelope, null, 2));
}
